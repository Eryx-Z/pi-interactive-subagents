import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CHILD_EXTENSION = join(HERE, "child.ts");
export const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
const FORBIDDEN = new Set(["subagent", "subagent_message", "subagents_list", "subagent_control"]);
export interface Agent {
  name: string; description: string; tools: string[]; extensions: string[];
  model?: string; thinking?: string; prompt: string; promptMode: "append" | "replace"; cwd?: string;
}
export interface Loadout {
  version: 1; agent: string; tools: string[]; extensions: string[];
  model: string; thinking: string; prompt: string; promptMode: "append" | "replace";
  cwd: string; agentDir: string;
}
export function agentDir(): string {
  return resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}
export function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value.trim();
}
function list(value: unknown, field: string): string[] {
  if (value === undefined || value === null || value === "") return [];
  const items = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(items) || items.some(v => typeof v !== "string" || !v.trim())) {
    throw new Error(`${field} must be a comma-separated string or string array`);
  }
  return [...new Set(items.map(v => v.trim()))];
}
export function parseAgent(text: string, file: string): Agent {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new Error(`${file}: missing YAML frontmatter`);
  const fm = parse(match[1]);
  if (!fm || typeof fm !== "object" || Array.isArray(fm)) throw new Error(`${file}: invalid frontmatter`);
  const name = nonempty(fm.name, "name");
  if (!/^[\w-]+$/.test(name)) throw new Error(`${file}: invalid agent name`);
  if (fm.cli && fm.cli !== "pi") throw new Error(`${file}: only Pi RPC agents are supported`);
  if (fm.skills || fm.skill) throw new Error(`${file}: automatic skills are not supported in RPC v1; include instructions in the role body`);
  if (fm["system-prompt"] && !["append", "replace"].includes(fm["system-prompt"])) throw new Error(`${file}: invalid system-prompt`);
  const tools = list(fm.tools, "tools");
  if (tools.some(t => FORBIDDEN.has(t)) || list(fm.subagent_agents, "subagent_agents").length) {
    throw new Error(`${file}: nested delegation is disabled in RPC v1`);
  }
  return {
    name, description: typeof fm.description === "string" ? fm.description : "",
    tools, extensions: list(fm.extensions, "extensions").map(p => resolve(dirname(file), p)),
    model: fm.model == null ? undefined : nonempty(fm.model, "model"),
    thinking: fm.thinking == null ? undefined : nonempty(fm.thinking, "thinking"),
    prompt: match[2].trim(), promptMode: fm["system-prompt"] ?? "append",
    cwd: fm.cwd == null ? undefined : nonempty(fm.cwd, "cwd"),
  };
}
export function discoverAgents(cwd: string, trusted: boolean, configDir = agentDir()): Agent[] {
  const found = new Map<string, Agent>();
  for (const dir of [join(HERE, "../../agents"), join(configDir, "agents"), ...(trusted ? [join(cwd, ".pi/agents")] : [])]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
      const path = join(dir, file);
      const agent = parseAgent(readFileSync(path, "utf8"), path);
      found.set(agent.name, agent);
    }
  }
  return [...found.values()];
}
export function validateLoadout(value: unknown): Loadout {
  const l = value as Loadout;
  if (!l || l.version !== 1 || !Array.isArray(l.tools) || !Array.isArray(l.extensions)) throw new Error("Invalid v1 loadout");
  for (const key of ["agent", "model", "thinking", "cwd", "agentDir"] as const) nonempty(l[key], `loadout.${key}`);
  if (!isAbsolute(l.cwd) || !isAbsolute(l.agentDir) || !statSync(l.cwd).isDirectory()) throw new Error("Loadout cwd/config must be absolute and cwd must exist");
  if (typeof l.prompt !== "string" || !["append", "replace"].includes(l.promptMode)) throw new Error("Invalid loadout prompt");
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(l.thinking)) throw new Error("Invalid thinking level");
  if (!l.tools.includes("ask_question") || l.tools.some(t => typeof t !== "string" || !/^[\w-]+$/.test(t) || FORBIDDEN.has(t))) throw new Error("Invalid child tool allowlist");
  for (const p of l.extensions) if (typeof p !== "string" || !isAbsolute(p) || !statSync(p).isFile()) throw new Error(`Missing extension: ${p}`);
  return l;
}
export function resolveLoadout(agent: Agent, cwd: string, model: string, thinking: string, configDir = agentDir()): Loadout {
  const extensions = new Set(agent.extensions);
  for (const tool of agent.tools) {
    if (BUILTIN_TOOLS.has(tool) || tool === "ask_question") continue;
    const candidate = tool === "safe_bash" ? join(HERE, "tools/safe-bash.ts") : join(configDir, "extensions", tool.replaceAll("_", "-"), "index.ts");
    if (existsSync(candidate)) extensions.add(candidate);
    else if (agent.extensions.length === 0) throw new Error(`No backing extension for ${tool}; declare extensions in ${agent.name}.md`);
  }
  return validateLoadout({
    version: 1, agent: agent.name, tools: [...new Set([...agent.tools, "ask_question"])],
    extensions: [...extensions].map(p => realpathSync(p)), model, thinking,
    prompt: agent.prompt, promptMode: agent.promptMode, cwd: realpathSync(cwd), agentDir: resolve(configDir),
  });
}
