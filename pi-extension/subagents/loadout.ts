import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const CHILD_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "child.ts");
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"]);
const DELEGATION_TOOLS = new Set(["subagent", "subagent_message", "subagents_list", "subagent_control", "delegate", "delegate_task"]);
type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
export interface ToolSnapshot {
  name: string; description: string; parameters: ToolInfo["parameters"]; promptGuidelines?: string[];
  source: "builtin" | "extension"; path: string;
}
export interface SkillSnapshot {
  name: string; description: string; filePath: string; baseDir: string; disableModelInvocation: boolean;
  /** Original absolute loader path; unlike canonical identity, symlink spelling affects skill metadata. */
  loadPath?: string;
}
export interface Loadout {
  version: 2; tools: string[]; toolMetadata: ToolSnapshot[]; extensions: string[]; skills: SkillSnapshot[];
  model: string; thinking: string; cwd: string; agentDir: string;
}
export function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value.trim();
}
/** Tool APIs have no capability tags. Exclude known and conventional delegation tool names. */
export function isDelegationTool(name: string): boolean {
  return DELEGATION_TOOLS.has(name) || /(?:^|[_-])subagents?(?:[_-]|$)/i.test(name) ||
    /^(?:(?:spawn|launch|create|manage|control|message|list|wait|close|stop|resume|send_input)[_-]agents?|agents?[_-](?:spawn|launch|create|manage|control|message|list|wait|close|stop|resume))$/i.test(name);
}
function file(path: string, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`Cannot inherit ${label}: no absolute file-backed source`);
  try {
    const canonical = realpathSync(path);
    if (statSync(canonical).isFile()) return canonical;
  } catch {}
  throw new Error(`Cannot inherit ${label}: missing source file ${path}`);
}
export function snapshotTool(tool: ToolInfo): ToolSnapshot {
  const source = tool.sourceInfo?.source === "builtin" ? "builtin" : "extension";
  if (tool.sourceInfo?.source === "sdk") throw new Error(`Cannot inherit tool ${tool.name}: SDK tools have no reloadable implementation`);
  const path = source === "builtin" ? `<builtin:${tool.name}>` : file(tool.sourceInfo?.path, `tool ${tool.name}`);
  if (source === "builtin" && (!BUILTIN_TOOLS.has(tool.name) || tool.sourceInfo.path !== path)) throw new Error(`Invalid builtin provenance: ${tool.name}`);
  // Tool schemas are JSON on the wire; discard TypeBox's symbol metadata, not schema fields.
  return JSON.parse(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters,
    promptGuidelines: tool.promptGuidelines, source, path }));
}
export function snapshotSkills(skills: readonly Skill[]): SkillSnapshot[] {
  return skills.map(s => ({ name: s.name, description: s.description, filePath: file(s.filePath, `skill ${s.name}`),
    loadPath: s.filePath, baseDir: realpathSync(s.baseDir), disableModelInvocation: s.disableModelInvocation }));
}
/** Inputs come from the live parent API and prompt options, never resource rediscovery. */
export function resolveLoadout(pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">, skills: readonly Skill[] | undefined,
  cwd: string, model: string, thinking: string, configDir = getAgentDir()): Loadout {
  if (!skills) throw new Error("Parent skill inventory is unavailable; launch during a parent agent turn");
  const all = new Map(pi.getAllTools().map(t => [t.name, t]));
  const names = [...new Set(pi.getActiveTools())].filter(n => n !== "ask_question" && !isDelegationTool(n));
  const toolMetadata = names.map(name => {
    const tool = all.get(name);
    if (!tool) throw new Error(`Cannot inherit active tool ${name}: runtime metadata is missing`);
    return snapshotTool(tool);
  });
  return validateLoadout({ version: 2, tools: [...names, "ask_question"], toolMetadata,
    extensions: [...new Set(toolMetadata.filter(t => t.source === "extension").map(t => t.path))],
    skills: snapshotSkills(skills), model, thinking, cwd: realpathSync(cwd), agentDir: resolve(configDir) });
}
export function validateLoadout(value: unknown): Loadout {
  const l = value as Loadout;
  if (!l || l.version !== 2 || !Array.isArray(l.tools) || !Array.isArray(l.toolMetadata) || !Array.isArray(l.extensions) || !Array.isArray(l.skills)) {
    throw new Error("Invalid v2 inherited loadout; legacy profile tasks cannot be continued, launch a new task");
  }
  for (const key of ["model", "thinking", "cwd", "agentDir"] as const) nonempty(l[key], `loadout.${key}`);
  if (!isAbsolute(l.cwd) || !isAbsolute(l.agentDir) || !statSync(l.cwd).isDirectory()) throw new Error("Loadout cwd/config must be absolute and cwd must exist");
  if (!/^[^/]+\/.+/.test(l.model)) throw new Error("Use a canonical provider/model ID");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(l.thinking)) throw new Error("Invalid thinking level");
  if (!l.tools.includes("ask_question") || new Set(l.tools).size !== l.tools.length ||
      l.tools.some(t => typeof t !== "string" || !/^[\w.-]+$/.test(t) || isDelegationTool(t))) throw new Error("Invalid child tool allowlist: nested delegation is disabled");
  if (!isDeepStrictEqual(l.toolMetadata.map(t => t.name), l.tools.filter(n => n !== "ask_question"))) throw new Error("Incomplete inherited tool metadata");
  for (const t of l.toolMetadata) {
    if (typeof t.description !== "string" || !t.parameters || typeof t.parameters !== "object") throw new Error(`Invalid tool metadata: ${t.name}`);
    if (t.source === "builtin") {
      if (!BUILTIN_TOOLS.has(t.name) || t.path !== `<builtin:${t.name}>`) throw new Error(`Invalid builtin provenance: ${t.name}`);
    } else if (t.source !== "extension" || file(t.path, `tool ${t.name}`) !== t.path) throw new Error(`Invalid tool provenance: ${t.name}`);
  }
  const extensions = [...new Set(l.toolMetadata.filter(t => t.source === "extension").map(t => t.path))];
  if (!isDeepStrictEqual(l.extensions, extensions)) throw new Error("Extension sources do not match inherited tools");
  const names = new Set<string>();
  for (const s of l.skills) {
    nonempty(s.name, "skill.name"); nonempty(s.description, "skill.description");
    if (names.has(s.name) || file(s.filePath, `skill ${s.name}`) !== s.filePath ||
        file(s.loadPath ?? s.filePath, `skill ${s.name} load path`) !== s.filePath || !isAbsolute(s.baseDir) ||
        realpathSync(s.baseDir) !== s.baseDir || !statSync(s.baseDir).isDirectory() || typeof s.disableModelInvocation !== "boolean") throw new Error(`Invalid skill snapshot: ${s.name}`);
    names.add(s.name);
  }
  return l;
}
export function verifyTools(loadout: Loadout, tools: ToolInfo[]): void {
  const all = new Map(tools.map(t => [t.name, t]));
  for (const expected of loadout.toolMetadata) {
    const actual = all.get(expected.name);
    if (!actual) throw new Error(`Child is missing required tool: ${expected.name}`);
    if (!isDeepStrictEqual(snapshotTool(actual), expected)) throw new Error(`Inherited tool schema/provenance mismatch: ${expected.name}`);
  }
  const question = all.get("ask_question");
  if (!question || file(question.sourceInfo?.path, "ask_question") !== realpathSync(CHILD_EXTENSION)) throw new Error("Child ask_question bridge was replaced");
}
export function verifySkills(loadout: Loadout, skills: readonly Skill[] | undefined): void {
  if (!skills) throw new Error("Child skill inventory is unavailable");
  const sorted = (s: SkillSnapshot[]) => s.map(({ loadPath: _loadPath, ...identity }) => identity).sort((a, b) => a.name.localeCompare(b.name));
  if (!isDeepStrictEqual(sorted(snapshotSkills(skills)), sorted(loadout.skills))) throw new Error("Inherited skill inventory/metadata mismatch");
}
