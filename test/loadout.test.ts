import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { CHILD_EXTENSION, isDelegationTool, resolveLoadout, verifyTools, verifySkills, validateLoadout } from "../pi-extension/subagents/loadout.ts";
import { readInfo } from "./fixtures/loadout.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "loadout-"));
  const source = join(dir, "unrelated-provider-name.ts");
  writeFileSync(source, "export default function () {}\n");
  const tool = { ...readInfo(dir), name: "custom_search", description: "Search custom data", sourceInfo: { path: source, source: "package:custom", scope: "project" as const, origin: "package" as const } };
  const api = { getActiveTools: () => ["custom_search", "read", "subagent", "subagent_control"], getAllTools: () => [readInfo(dir), tool] };
  const question = { ...tool, name: "ask_question", sourceInfo: { ...tool.sourceInfo, path: CHILD_EXTENSION } };
  const skillPath = join(dir, "SKILL.md"); writeFileSync(skillPath, "---\nname: hidden\ndescription: Hidden skill\ndisable-model-invocation: true\n---\nInstructions");
  const skill: Skill = { name: "hidden", description: "Hidden skill", filePath: skillPath, baseDir: dir, disableModelInvocation: true, sourceInfo: { ...tool.sourceInfo, path: skillPath } };
  return { dir, source, tool, api, question, skill, clean: () => rmSync(dir, {recursive: true, force: true}) };
}
test("loadout freezes actual active tools and all skills, not names guessed from config", () => {
  const t = setup();
  try {
    const alias = join(t.dir, "alias.ts"); symlinkSync(t.source, alias); t.tool.sourceInfo.path = alias;
    const l = resolveLoadout(t.api, [t.skill], t.dir, "fake/test", "high", t.dir);
    assert.deepEqual(l.tools, ["custom_search", "read", "ask_question"]);
    assert.deepEqual(l.extensions, [t.source]);
    assert.equal(l.skills[0].disableModelInvocation, true);
    assert.equal(l.thinking, "high");
    t.skill.description = "later change"; t.tool.description = "later tool change";
    assert.equal(l.skills[0].description, "Hidden skill");
    assert.equal(l.toolMetadata[0].description, "Search custom data");
  } finally { t.clean(); }
});
test("empty parent active set remains empty except ask_question; delegation names are excluded", () => {
  const t = setup();
  try {
    const names = ["subagent", "subagent_message", "subagents_list", "subagent_control", "spawn_agent", "manage_agents", "agent_spawn", "delegate_task", "mcp_subagent_launch"];
    assert.ok(names.every(isDelegationTool));
    assert.ok(!isDelegationTool("read")); assert.ok(!isDelegationTool("ask_question"));
    for (const active of [[], names]) {
      const l = resolveLoadout({ ...t.api, getActiveTools: () => active }, [], t.dir, "fake/test", "off", t.dir);
      assert.deepEqual(l.tools, ["ask_question"]); assert.deepEqual(l.extensions, []);
    }
  } finally { t.clean(); }
});
test("unavailable inventory, inline/SDK tools, missing source and missing metadata fail explicitly", () => {
  const t = setup();
  try {
    const resolve = (skills: Skill[] | undefined = []) => resolveLoadout(t.api, skills, t.dir, "fake/test", "off", t.dir);
    assert.throws(() => resolveLoadout(t.api, undefined, t.dir, "fake/test", "off", t.dir), /skill inventory is unavailable/);
    t.tool.sourceInfo.source = "sdk"; assert.throws(() => resolve(), /SDK tools/);
    t.tool.sourceInfo.source = "inline"; t.tool.sourceInfo.path = "<inline:tools>"; assert.throws(() => resolve(), /no absolute file-backed/);
    t.tool.sourceInfo.path = join(t.dir, "gone.ts"); assert.throws(() => resolve(), /missing source file/);
    t.api.getAllTools = () => [readInfo(t.dir)]; assert.throws(() => resolve(), /runtime metadata is missing/);
  } finally { t.clean(); }
});
test("tool preflight rejects absent tools, builtin substitution, changed schemas and replaced question bridge", () => {
  const t = setup();
  try {
    const l = resolveLoadout(t.api, [], t.dir, "fake/test", "off", t.dir);
    const all = [...t.api.getAllTools(), t.question]; verifyTools(l, all);
    assert.throws(() => verifyTools(l, [readInfo(t.dir), t.question]), /missing required tool/);
    t.tool.parameters = JSON.parse(JSON.stringify({ ...t.tool.parameters, required: [] }));
    assert.throws(() => verifyTools(l, all), /schema\/provenance mismatch/);
    const override = { ...readInfo(t.dir), sourceInfo: { ...t.tool.sourceInfo, path: t.source } };
    const overridden = resolveLoadout({getActiveTools: () => ["read"], getAllTools: () => [override]}, [], t.dir, "fake/test", "off", t.dir);
    assert.throws(() => verifyTools(overridden, [readInfo(t.dir), t.question]), /schema\/provenance mismatch/);
    t.question.sourceInfo.path = t.source;
    assert.throws(() => verifyTools({...l, tools: ["ask_question"], toolMetadata: []}, [t.question]), /bridge was replaced/);
  } finally { t.clean(); }
});
test("skill preflight verifies exact canonical inventory and metadata, including hidden skills", () => {
  const t = setup();
  try {
    const l = resolveLoadout(t.api, [t.skill], t.dir, "fake/test", "off", t.dir);
    verifySkills(l, [t.skill]);
    assert.throws(() => verifySkills(l, []), /inventory\/metadata mismatch/);
    assert.throws(() => verifySkills(l, [t.skill, {...t.skill, name: "extra"}]), /inventory\/metadata mismatch/);
    assert.throws(() => verifySkills(l, [{...t.skill, disableModelInvocation: false}]), /inventory\/metadata mismatch/);
    assert.throws(() => verifySkills(l, [{...t.skill, filePath: "/virtual/SKILL.md"}]), /missing source file/);
  } finally { t.clean(); }
});


test("skill loader path is separate from canonical identity and retargeted aliases are rejected", () => {
  const t = setup();
  try {
    const alias = join(t.dir, "alias.md"); symlinkSync(t.skill.filePath, alias);
    const l = resolveLoadout(t.api, [{ ...t.skill, filePath: alias }], t.dir, "fake/test", "off", t.dir);
    assert.equal(l.skills[0].filePath, t.skill.filePath);
    assert.equal(l.skills[0].loadPath, alias);
    verifySkills(l, [t.skill]); // Provenance comparison remains canonical.
    const other = join(t.dir, "other.md"); writeFileSync(other, "different target");
    unlinkSync(alias); symlinkSync(other, alias);
    assert.throws(() => validateLoadout(l), /Invalid skill snapshot/);
  } finally { t.clean(); }
});
