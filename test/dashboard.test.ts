import { test } from "node:test";
import assert from "node:assert/strict";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { TaskDashboard, dashboardRecords, dashboardState, closeDashboards } from "../pi-extension/subagents/dashboard.ts";
import { taskMenu, detail, taskSummary } from "../pi-extension/subagents/ui.ts";
import { TaskManager } from "../pi-extension/subagents/tasks.ts";

function setup() {
  const record: any = { id: "one", name: "中文任务", state: "running", loadout: { cwd: "/project" }, context: "partial", run: 1, access: "full", sessionFile: "/tmp/session", task: "fix", startedAt: Date.now(), updatedAt: Date.now(), activity: "working", output: "", log: [], questions: [], stopped: false };
  const calls: any[] = [], selections: string[] = [], notices: any[] = [];
  const manager: any = {
    records: new Map([[record.id, record]]), get(id: string) { const r = this.records.get(id); if (!r) throw new Error("Unknown task"); return r; },
    message: async (...args: any[]) => calls.push(["message", ...args]), answer: (...args: any[]) => calls.push(["answer", ...args]),
    continue: async (...args: any[]) => calls.push(["continue", ...args]), cancel: async (...args: any[]) => calls.push(["cancel", ...args]),
  };
  let color = "32", renders = 0;
  const theme: any = { fg: (_: string, s: string) => `\x1b[${color}m${s}\x1b[0m` };
  const tui: any = { terminal: { rows: 40 }, requestRender() { renders++; } };
  const state = dashboardState(), keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const make = (done = (_: any) => {}) => new TaskDashboard(manager, state, tui, theme, keys, done, { summary: taskSummary, detail: r => detail(r, true) });
  const ctx: any = { mode: "tui", hasUI: true, ui: {
    select: async () => selections.shift(), editor: async () => "instruction", confirm: async () => true,
    notify: (...args: any[]) => notices.push(args),
  } };
  return { record, manager, calls, selections, notices, ctx, state, theme, tui, keys, make, color: (s: string) => { color = s; }, renders: () => renders };
}

// custom() harness asserts the component is completed/disposed before native dialogs are used.
function custom(t: ReturnType<typeof setup>, steps: Array<(component: TaskDashboard) => void>) {
  let open = false, count = 0;
  t.ctx.ui.custom = async (factory: any, options: any) => {
    assert.equal(options.overlay, true); count++; open = true;
    let resolve!: (value: any) => void;
    const promise = new Promise(r => { resolve = r; });
    const component = factory(t.tui, t.theme, t.keys, (value: any) => { open = false; resolve(value); });
    component.render(100);
    steps.shift()!(component);
    const value = await promise;
    component.dispose();
    return value;
  };
  const editor = t.ctx.ui.editor;
  t.ctx.ui.editor = async (...args: any[]) => { assert.equal(open, false); return editor(...args); };
  return () => count;
}

test("attention ordering is stable and selection stays on identity across refresh/deletion", () => {
  const t = setup(), view = t.make();
  try {
    const second = { ...t.record, id: "two", name: "second", state: "failed", stopped: true, questions: [] };
    const third = { ...t.record, id: "three", name: "third", questions: [{ id: "q" }] };
    t.manager.records.set("two", second); t.manager.records.set("three", third);
    assert.deepEqual(dashboardRecords(t.manager.records.values()).map(r => r.id), ["three", "two", "one"]);
    view.render(100); assert.equal(t.state.selectedId, "three");
    view.handleInput("\x1b[B"); assert.equal(t.state.selectedId, "two");
    t.record.questions.push({ id: "q2" }); second.updatedAt++;
    view.render(100); assert.equal(t.state.selectedId, "two");
    assert.deepEqual(dashboardRecords(t.manager.records.values()).map(r => r.id), ["one", "three", "two"]);
    t.manager.records.delete("two"); view.render(100); assert.equal(t.state.selectedId, "one");
    t.manager.records.clear(); assert.match(stripTerminalSequences(view.render(100).join("\n")), /No subagent tasks/);
    view.handleInput("m"); // no action on a missing task
  } finally { view.dispose(); }
});

test("wide/narrow/CJK layout and themes are bounded and terminal injection is stripped", () => {
  const t = setup(); t.record.name += "\x1b]0;evil\x07\nname";
  t.record.output = "汉字👨‍👩‍👧‍👦".repeat(60) + "\x1b[31mtext\x1b[0m\x00";
  const view = t.make();
  try {
    for (const width of [0, 1, 8, 20, 60, 89, 90, 120]) {
      const lines = view.render(width);
      assert.ok(lines.every(s => visibleWidth(s) <= width));
      assert.ok(lines.length <= 32);
      assert.doesNotMatch(stripTerminalSequences(lines.join("\n")), /evil|\x00/);
      if (width >= 90) assert.ok(lines.some(s => s.includes(" │ ")));
      if (width === 60) assert.ok(lines.some(s => stripTerminalSequences(s) === "─".repeat(width)));
    }
    assert.match(view.render(120).join("\n"), /\x1b\[32m/);
    t.color("35"); view.invalidate();
    assert.doesNotMatch(view.render(120).join("\n"), /\x1b\[32m/);
    t.tui.terminal.rows = 9;
    assert.ok(view.render(40).length <= 7);
    assert.doesNotMatch(detail(t.record), /Shutdown: unconfirmed/);
  } finally { view.dispose(); }
});

test("manual detail scrolling pauses follow, End resumes and reopening retains task scroll", () => {
  const t = setup(); t.record.log = Array.from({ length: 100 }, (_, i) => `log ${i}`);
  let view = t.make();
  try {
    view.render(100);
    assert.equal(t.state.views.get("one")!.follow, true);
    view.handleInput("\r"); assert.equal(t.state.detailFocus, true);
    view.handleInput("\x1b[A"); view.render(100);
    const before = t.state.views.get("one")!.top;
    t.record.log.push("new activity"); view.render(100);
    assert.equal(t.state.views.get("one")!.top, before);
    assert.equal(t.state.views.get("one")!.follow, false);
    view.dispose(); view = t.make(); view.render(100);
    assert.equal(t.state.views.get("one")!.top, before);
    view.handleInput("\x1b[F"); view.render(100);
    assert.equal(t.state.views.get("one")!.follow, true);
    assert.ok(t.state.views.get("one")!.top > before);
    view.handleInput("\x1b[H"); view.render(100);
    assert.equal(t.state.views.get("one")!.top, 0);
    assert.equal(t.state.views.get("one")!.follow, false);
  } finally { view.dispose(); }
});

test("refresh timer clears on completion, dispose, custom rejection and session shutdown", async context => {
  const ticks: Array<() => void> = [], cleared: unknown[] = [];
  context.mock.method(globalThis, "setInterval", (callback: () => void) => { ticks.push(callback); return { unref() {} }; });
  context.mock.method(globalThis, "clearInterval", (timer: unknown) => { cleared.push(timer); });
  const t = setup(), view = t.make(); ticks[0](); assert.equal(t.renders(), 1);
  view.handleInput("\x1b"); view.dispose(); ticks[0](); assert.equal(t.renders(), 1);
  assert.equal(cleared.length, 1);
  const count = custom(t, [() => closeDashboards()]);
  await taskMenu(t.manager, t.ctx); assert.equal(count(), 1); assert.equal(cleared.length, 2);
  t.ctx.ui.custom = async (factory: any) => { factory(t.tui, t.theme, t.keys, () => {}); throw new Error("custom failed"); };
  await assert.rejects(taskMenu(t.manager, t.ctx), /custom failed/);
  assert.equal(cleared.length, 3);
  closeDashboards(); assert.equal(cleared.length, 3);
});

test("overlay routes actions through original dialogs, confirms cancel and preserves continuation guard errors", async () => {
  const t = setup(); t.record.questions = [{ id: "q", title: "Pick?" }];
  t.selections.push("q ? Pick?", "read-only");
  let confirms = 0;
  t.ctx.ui.confirm = async () => { confirms++; return false; };
  const count = custom(t, [v => v.handleInput("m"), v => v.handleInput("a"), v => v.handleInput("x"), v => v.handleInput("c"), v => v.handleInput("\x1b")]);
  await taskMenu(t.manager, t.ctx);
  assert.equal(count(), 5); assert.equal(confirms, 1);
  assert.deepEqual(t.calls, [["message", "one", "instruction"], ["answer", "one", "q", "instruction"], ["continue", "one", "instruction", "read-only"]]);
  t.record.workflow = { id: "wf", stepId: "step" };
  t.manager.continue = TaskManager.prototype.continue.bind(t.manager);
  t.selections.push("full");
  custom(t, [v => v.handleInput("c"), v => { assert.match(t.notices.at(-1)[0], /workflow_control retry/); assert.equal(t.notices.at(-1)[1], "error"); v.handleInput("\x1b"); }]);
  await taskMenu(t.manager, t.ctx);
});

test("deleted tasks report action errors and shutdown during a native dialog never reopens", async () => {
  const t = setup();
  custom(t, [v => { t.manager.records.clear(); v.handleInput("m"); }, v => { assert.match(t.notices.at(-1)[0], /Unknown task/); v.handleInput("\x1b"); }]);
  await taskMenu(t.manager, t.ctx); // never route a deleted task's action to a fallback
  t.manager.records.set(t.record.id, t.record);
  t.manager.message = async () => { throw new Error("Task disappeared during input"); };
  const count = custom(t, [v => v.handleInput("m"), v => { assert.match(t.notices.at(-1)[0], /Task disappeared/); v.handleInput("\x1b"); }]);
  await taskMenu(t.manager, t.ctx); assert.equal(count(), 2);
  t.manager.message = async () => { closeDashboards(); };
  const stopped = custom(t, [v => v.handleInput("m")]);
  await taskMenu(t.manager, t.ctx); assert.equal(stopped(), 1);
});

test("RPC and explicit task IDs retain menu flow; accepted cancel still routes to manager", async () => {
  const t = setup(); t.ctx.mode = "rpc";
  t.selections.push("one task", "Cancel");
  t.ctx.ui.custom = () => { throw new Error("RPC custom forbidden"); };
  await taskMenu(t.manager, t.ctx);
  assert.deepEqual(t.calls, [["cancel", "one"]]);
  t.ctx.mode = "tui"; t.selections.push("Message");
  await taskMenu(t.manager, t.ctx, "one");
  assert.deepEqual(t.calls.at(-1), ["message", "one", "instruction"]);
});
