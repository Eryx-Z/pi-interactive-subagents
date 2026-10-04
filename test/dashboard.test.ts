import { test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { TaskDashboard, dashboardRecords, dashboardState, closeDashboards } from "../pi-extension/subagents/dashboard.ts";
import { taskMenu, detail, createDashboardContent } from "../pi-extension/subagents/ui.ts";
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
  const make = (done = (_: any) => {}) => new TaskDashboard(manager, state, tui, theme, keys, done, createDashboardContent());
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
    assert.equal(options.overlay, true);
    assert.deepEqual(options.overlayOptions, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 });
    count++; open = true;
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
    t.record.task = "完整任务\n".repeat(100) + "\x1b]0;evil\x07\x00";
    for (const pane of ["1", "2", "3", "4"]) {
      view.handleInput(pane);
      for (const width of [0, 1, 8, 20, 60, 89, 90, 120]) {
        const lines = view.render(width);
        assert.ok(lines.every(s => visibleWidth(s) === width));
        assert.equal(lines.length, width > 0 ? t.tui.terminal.rows : 0);
        assert.doesNotMatch(stripTerminalSequences(lines.join("\n")), /evil|\x00/);
        if (width >= 60) {
          const plain = lines.map(stripTerminalSequences);
          assert.ok(plain[0].startsWith("╭─ Subagents "));
          assert.equal(plain.at(-1), `╰${"─".repeat(width - 2)}╯`);
          assert.ok(plain.every(s => visibleWidth(s) === width));
        }
      }
    }
    assert.match(view.render(120).join("\n"), /\x1b\[32m/);
    t.color("35"); view.invalidate();
    assert.doesNotMatch(view.render(120).join("\n"), /\x1b\[32m/);
    t.tui.terminal.rows = 9;
    assert.equal(view.render(40).length, 9);
    assert.doesNotMatch(detail(t.record), /Shutdown: unconfirmed/);
  } finally { view.dispose(); }
});

test("one outer frame has aligned dividers, padding and theme-aware focus labels", () => {
  const t = setup();
  t.record.loadout.model = "provider/model";
  t.theme.fg = (token: string, s: string) => `\x1b[${token === "accent" ? "36" : token === "border" ? "90" : "37"}m${s}\x1b[0m`;
  const view = t.make();
  try {
    assert.equal(t.state.pane, "prompt");
    assert.match(view.render(120).join("\n"), /\x1b\[36m2 Prompt\x1b\[0m/);
    view.handleInput("1");
    for (const width of [60, 120]) {
      let rendered = view.render(width);
      let plain = rendered.map(stripTerminalSequences);
      const labels = plain.findIndex(s => s.includes("Tasks · 1"));
      assert.ok(labels > 0);
      assert.match(rendered[labels], /\x1b\[36mTasks · 1/);
      assert.match(plain.join("\n"), /Focus: Tasks/);
      for (const corner of ["╭", "╮", "╰", "╯"]) {
        assert.equal(plain.join("\n").split(corner).length - 1, 1, "no nested frames");
      }
      assert.ok(plain.every(s => visibleWidth(s) === width));
      assert.equal(plain.at(-1), `╰${"─".repeat(width - 2)}╯`);
      const content = plain.find(s => s.includes("Access:"))!;
      assert.match(content, /│ Access:/); // One column of inset after the separator/edge.
      if (width === 60) {
        assert.ok(plain.some(s => s.includes("Overview · 1/8")));
        assert.ok(plain.some(s => s.includes("中文任务")));
        assert.equal(plain.filter(s => s.startsWith("├")).length, 3);
        assert.equal(content.split("│").length - 1, 2);
      } else {
        assert.match(plain[labels], /Tasks · 1\s+│ Overview/);
        assert.equal(plain.filter(s => s.startsWith("├")).length, 2);
        assert.equal(content.split("│").length - 1, 3);
        // Every content row uses the same single vertical divider.
        const leftColumns = visibleWidth(plain[labels].split("│")[1]);
        for (const line of plain.slice(labels, -4)) assert.equal(visibleWidth(line.split("│")[1]), leftColumns);
      }
      view.handleInput("\t");
      rendered = view.render(width); plain = rendered.map(stripTerminalSequences);
      assert.match(rendered[plain.findIndex(s => s.includes("Tasks · 1"))], /\x1b\[37mTasks · 1/);
      assert.match(rendered[plain.findIndex(s => s.includes("Overview · 1/8"))], /\x1b\[36mOverview/);
      assert.match(plain.join("\n"), /Focus: Detail/);
      view.handleInput("\r");
    }
    for (const rows of [1, 3, 9, 17, 18, 20, 24, 40]) {
      t.tui.terminal.rows = rows;
      for (const width of [0, 1, 8, 16, 20, 60, 90, 120]) {
        const lines = view.render(width);
        assert.equal(lines.length, width > 0 ? rows : 0);
        assert.ok(lines.every(s => visibleWidth(s) === width));
        if (width >= 16 && rows >= 18) assert.match(stripTerminalSequences(lines.at(-1)!), /^╰─+╯$/);
      }
    }
  } finally { view.dispose(); }
});

test("separate views keep the selected model visible and hide noisy IDs and paths", () => {
  const t = setup();
  t.record.loadout.model = "provider/child-model";
  t.record.loadout.thinking = "high";
  t.record.task = "父 agent 的任务 prompt";
  t.record.log = Array.from({ length: 100 }, (_, i) => `log ${i}`);
  const view = t.make();
  try {
    assert.match(stripTerminalSequences(view.render(120)[2]), /Model: provider\/child-model/);
    let screen = stripTerminalSequences(view.render(120).join("\n"));
    assert.equal(t.state.pane, "prompt");
    assert.match(screen, /1 Overview · 2 Prompt · 3 Activity/);
    assert.doesNotMatch(screen, /\[(?:1 Overview|2 Prompt|3 Activity)\]/);
    assert.ok(screen.includes(t.record.task));
    assert.doesNotMatch(screen, /Access:|Recent activity|log 99|\/tmp\/session|\[one\]/);
    assert.equal(t.state.views.get("one:prompt")!.top, 0);
    assert.equal(t.state.views.get("one:prompt")!.follow, false);
    view.handleInput("1");
    screen = stripTerminalSequences(view.render(120).join("\n"));
    assert.equal(t.state.pane, "overview");
    assert.match(screen, /Access:/);
    assert.doesNotMatch(screen, /父 agent 的任务 prompt|log 99|\/tmp\/session|\[one\]/);
    assert.equal(t.state.views.get("one:overview")!.top, 0);
    assert.equal(t.state.views.get("one:overview")!.follow, false);
    view.handleInput("2");
    assert.ok(stripTerminalSequences(view.render(120).join("\n")).includes(t.record.task));
    view.handleInput("3");
    screen = stripTerminalSequences(view.render(120).join("\n"));
    assert.match(screen, /Following latest/);
    assert.match(screen, /log 99/);
    assert.doesNotMatch(screen, /父 agent 的任务 prompt/);
    const second = { ...t.record, id: "two", name: "second", loadout: { ...t.record.loadout, model: "other/model" } };
    t.manager.records.set(second.id, second);
    view.handleInput("\x1b[B");
    assert.match(stripTerminalSequences(view.render(120)[2]), /Model: other\/model/);
    second.loadout.model = "\x1b]0;evil\x07other/model\nspoof";
    screen = stripTerminalSequences(view.render(120).join("\n"));
    assert.doesNotMatch(screen, /evil/);
    for (const width of [1, 20, 60, 120]) assert.ok(view.render(width).every(line => visibleWidth(line) <= width));
  } finally { view.dispose(); }
});

test("manual detail scrolling pauses follow, End resumes and reopening retains task scroll", () => {
  const t = setup(); t.record.log = Array.from({ length: 100 }, (_, i) => `log ${i}`);
  let view = t.make();
  try {
    view.handleInput("3"); view.render(100);
    assert.equal(t.state.views.get("one:activity")!.follow, true);
    view.handleInput("\r"); assert.equal(t.state.detailFocus, true);
    view.handleInput("\x1b[A"); view.render(100);
    const before = t.state.views.get("one:activity")!.top;
    t.record.log.push("new activity"); view.render(100);
    assert.equal(t.state.views.get("one:activity")!.top, before);
    assert.equal(t.state.views.get("one:activity")!.follow, false);
    view.handleInput("2"); view.render(100);
    assert.equal(t.state.views.get("one:prompt")!.top, 0);
    view.handleInput("3"); view.render(100);
    assert.equal(t.state.views.get("one:activity")!.top, before);
    view.dispose(); view = t.make(); view.render(100);
    assert.equal(t.state.views.get("one:activity")!.top, before);
    view.handleInput("\x1b[F"); view.render(100);
    assert.equal(t.state.views.get("one:activity")!.follow, true);
    assert.ok(t.state.views.get("one:activity")!.top > before);
    view.handleInput("\x1b[H"); view.render(100);
    assert.equal(t.state.views.get("one:activity")!.top, 0);
    assert.equal(t.state.views.get("one:activity")!.follow, false);
  } finally { view.dispose(); }
});

test("prompt scrolling is independent per task and pane, and long prompts remain complete", () => {
  const t = setup();
  t.record.task = Array.from({ length: 100 }, (_, i) => `prompt line ${i}`).join("\n");
  const second = { ...t.record, id: "two", name: "second", task: "second task prompt", questions: [] };
  t.manager.records.set(second.id, second);
  const view = t.make();
  try {
    view.render(120); view.handleInput("2"); view.render(120);
    view.handleInput("\x1b[6~"); view.render(120);
    const top = t.state.views.get("one:prompt")!.top;
    assert.ok(top > 0);
    view.handleInput("\x1b[B"); view.render(120);
    assert.equal(t.state.views.get("two:prompt")!.top, 0);
    assert.match(stripTerminalSequences(view.render(120).join("\n")), /second task prompt/);
    view.handleInput("\x1b[A"); view.render(120);
    assert.equal(t.state.views.get("one:prompt")!.top, top);
    view.handleInput("1"); view.render(120);
    assert.equal(t.state.views.get("one:overview")!.top, 0);
    view.handleInput("2"); view.render(120);
    assert.equal(t.state.views.get("one:prompt")!.top, top);
    view.handleInput("\x1b[F");
    assert.match(stripTerminalSequences(view.render(120).join("\n")), /prompt line 99/);
    assert.equal(t.state.views.get("one:prompt")!.follow, false);
  } finally { view.dispose(); }
});

test("4 selects complete Trace with independent scrolling and End follow for appended records", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagents-dashboard-trace-"));
  const t = setup();
  t.record.sessionFile = join(dir, "child.jsonl");
  const entries = Array.from({ length: 100 }, (_, i) => JSON.stringify({ type: "message", text: `TRACE_${i}` }));
  writeFileSync(t.record.sessionFile, entries.join("\n") + "\n");
  const view = t.make();
  try {
    view.render(120);
    assert.equal(t.state.pane, "prompt");
    view.handleInput("4");
    let screen = stripTerminalSequences(view.render(120).join("\n"));
    assert.equal(t.state.pane, "trace");
    assert.match(screen, /4 Trace/);
    assert.match(screen, /Recorded session JSONL/);
    assert.match(screen, /TRACE_0/);
    assert.equal(t.state.views.get("one:trace")!.top, 0);
    assert.equal(t.state.views.get("one:trace")!.follow, false);
    view.handleInput("\x1b[F");
    screen = stripTerminalSequences(view.render(120).join("\n"));
    assert.match(screen, /TRACE_99/);
    assert.equal(t.state.views.get("one:trace")!.follow, true);
    appendFileSync(t.record.sessionFile, JSON.stringify({ text: "TRACE_APPENDED" }) + "\n");
    assert.match(stripTerminalSequences(view.render(120).join("\n")), /TRACE_APPENDED/);
    view.handleInput("\t"); view.handleInput("\x1b[A"); view.render(120);
    const paused = t.state.views.get("one:trace")!.top;
    assert.equal(t.state.views.get("one:trace")!.follow, false);
    appendFileSync(t.record.sessionFile, JSON.stringify({ text: "TRACE_LATER" }) + "\n");
    view.render(120);
    assert.equal(t.state.views.get("one:trace")!.top, paused);
    view.handleInput("2"); view.render(120);
    assert.equal(t.state.views.get("one:prompt")!.top, 0);
    view.handleInput("4"); view.render(120);
    assert.equal(t.state.views.get("one:trace")!.top, paused);
    view.handleInput("\x1b[H"); view.render(120);
    assert.equal(t.state.views.get("one:trace")!.top, 0);
    assert.equal(t.state.views.get("one:trace")!.follow, false);
    for (const width of [1, 8, 20, 60, 120]) {
      const lines = view.render(width);
      assert.equal(lines.length, t.tui.terminal.rows);
      assert.ok(lines.every(line => visibleWidth(line) === width));
      if (width >= 60) assert.match(stripTerminalSequences(lines.join("\n")), /4 Trace/);
    }
  } finally { view.dispose(); rmSync(dir, { recursive: true, force: true }); }
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
