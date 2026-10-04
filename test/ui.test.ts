import { test } from "node:test";
import assert from "node:assert/strict";
import { taskMenu, widget, resultRenderer, TaskWidget, clean, detail, taskSummary } from "../pi-extension/subagents/ui.ts";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function setup() {
  const record: any = { id: "task-id", name: "auth work", state: "running", loadout: { cwd: "/project" }, context: "partial", run: 1, access: "full", sessionFile: "/tmp/session.jsonl", task: "fix auth", startedAt: Date.now(), updatedAt: Date.now(), activity: "read: auth.ts", output: "working", log: [], questions: [] };
  const calls: any[] = [], notices: string[] = [];
  const manager: any = {
    records: new Map([[record.id, record]]),
    get(id: string) { assert.ok(id === record.id || id === record.name); return record; },
    message: async (...args: unknown[]) => calls.push(["message", ...args]),
    answer: (...args: unknown[]) => calls.push(["answer", ...args]),
    cancel: async (...args: unknown[]) => calls.push(["cancel", ...args]),
    continue: async (...args: unknown[]) => calls.push(["continue", ...args]),
  };
  const selections: string[] = [], dialogs: any[] = [];
  const ctx: any = { hasUI: true, mode: "tui", ui: {
    select: async (...args: unknown[]) => { dialogs.push(args); return selections.shift(); }, editor: async () => "extra requirement",
    confirm: async () => true, notify: (text: string) => notices.push(text),
    setWidget: (...args: unknown[]) => calls.push(["widget", ...args]),
  } };
  return { record, manager, ctx, calls, notices, selections, dialogs };
}

test("task menu accepts an explicit name containing spaces and sends instructions", async () => {
  const t = setup(); t.selections.push("Message");
  await taskMenu(t.manager, t.ctx, "auth work");
  assert.deepEqual(t.calls, [["message", "task-id", "extra requirement"]]);
  assert.match(t.notices[0], /not yet proven executed/);
});
test("task menu routes correlated answers and avoids empty question dialogs", async () => {
  const t = setup(); t.selections.push("Answer question");
  await taskMenu(t.manager, t.ctx, "task-id");
  assert.deepEqual(t.notices, ["No unanswered questions"]);
  t.record.questions.push({ id: "q-id", title: "Which interface?" });
  t.selections.push("Answer question", "q-id Which interface?");
  await taskMenu(t.manager, t.ctx, "task-id");
  assert.deepEqual(t.calls, [["answer", "task-id", "q-id", "extra requirement"]]);
});
test("task menu controls cancellation and explicit continuation", async () => {
  const t = setup(); t.selections.push("Cancel");
  await taskMenu(t.manager, t.ctx, "task-id");
  t.selections.push("Continue", "read-only");
  await taskMenu(t.manager, t.ctx, "task-id");
  assert.deepEqual(t.calls, [["cancel", "task-id"], ["continue", "task-id", "extra requirement", "read-only"]]);
});
test("widget updates activity and headless mode has no terminal requirements", async () => {
  const t = setup(), display = new TaskWidget(); widget(t.manager, t.ctx, display);
  assert.equal(t.calls[0][1], "rpc-subagents");
  assert.equal(typeof t.calls[0][2], "function");
  const theme: any = { fg: (_color: string, text: string) => text };
  const component = t.calls[0][2]({}, theme);
  assert.match(component.render(80).join("\n"), /┌─ Subagents · 1 running.*\n│ ● auth work.*read: auth.ts/);
  t.record.activity = "bash: npm test"; widget(t.manager, t.ctx, display);
  assert.match(component.render(80).join("\n"), /bash: npm test/);
  t.ctx.hasUI = false;
  const count = t.calls.length; widget(t.manager, t.ctx, display); assert.equal(t.calls.length, count);
  await assert.rejects(taskMenu(t.manager, t.ctx), /headless/);
});
test("terminal summaries expire after eight seconds without deleting history or replaying it", () => {
  const t = setup(), display = new TaskWidget();
  t.record.state = "failed"; t.record.stopped = true;
  assert.equal(display.lines([t.record], 100), undefined, "loaded history stays hidden");
  display.result(t.record, 100);
  assert.match(display.lines([t.record], 8099)![0], /1 failed/);
  assert.equal(display.lines([t.record], 8100), undefined);
  assert.equal(display.lines([t.record], 20000), undefined);
  assert.equal(t.manager.records.size, 1);
  assert.equal(new TaskWidget().lines([t.record], 200), undefined, "new session does not replay results");
});
test("questions persist until answered and unconfirmed shutdowns never auto-hide", () => {
  const t = setup(), display = new TaskWidget();
  t.record.state = "waiting";
  t.record.questions = [{ id: "q", title: "Which interface?" }];
  assert.match(display.lines([t.record], 90000)!.join("\n"), /awaiting answer/);
  assert.match(display.lines([t.record], 90000)!.join("\n"), /\? auth work · Which interface\?/);
  t.record.questions[0].responseSent = true;
  assert.match(display.lines([t.record], 90001)![0], /1 running/);
  assert.doesNotMatch(display.lines([t.record], 90001)!.join("\n"), /Which interface/);
  t.record.state = "failed"; t.record.stopped = false;
  display.result(t.record, 90002);
  assert.match(display.lines([t.record], 200000)!.join("\n"), /shutdown unconfirmed/);
  t.record.stopped = true;
  assert.equal(display.lines([t.record], 200001), undefined);
});
test("a new run remains visible after older results expire", () => {
  const t = setup(), display = new TaskWidget();
  t.record.state = "completed"; t.record.stopped = true;
  display.result(t.record, 100);
  t.record.state = "running"; t.record.stopped = false;
  assert.match(display.lines([t.record], 9000)![0], /1 running/);
  assert.match(display.lines([t.record], 9000)![1], /auth work/);
  t.record.state = "completed"; t.record.stopped = true;
  display.result(t.record, 10000);
  assert.match(display.lines([t.record], 17999)![0], /1 completed/);
  assert.equal(display.lines([t.record], 18000), undefined);
});

test("result renderer preserves collapse and safely fits narrow CJK terminals", () => {
  const content = "Subagent auth completed\n" + ["中文🙂 ".repeat(20), "second", "third", "fourth", "hidden tail"].join("\n");
  const collapsed = resultRenderer({ content }, { expanded: false });
  assert.match(collapsed.render(80).join("\n"), /Subagents ─ Subagent auth completed/);
  assert.doesNotMatch(collapsed.render(80).join("\n"), /hidden tail/);
  assert.match(collapsed.render(80).join("\n"), /expand for full report/);
  const expanded = resultRenderer({ content }, { expanded: true, outputPad: 3 });
  assert.match(expanded.render(80).join("\n"), /hidden tail/);
  for (const component of [collapsed, expanded]) {
    assert.deepEqual(component.render(0), []);
    for (const width of [1, 2, 3, 8, 20, 80]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
    }
  }
});

test("empty and historical widget state clears the installed widget", () => {
  const t = setup(), display = new TaskWidget();
  t.manager.records.clear();
  assert.equal(display.lines([], 0), undefined);
  widget(t.manager, t.ctx, display);
  assert.deepEqual(t.calls.at(-1), ["widget", "rpc-subagents", undefined]);
  t.record.state = "completed"; t.record.stopped = true;
  t.manager.records.set(t.record.id, t.record);
  widget(t.manager, t.ctx, display);
  assert.deepEqual(t.calls.at(-1), ["widget", "rpc-subagents", undefined]);
});

test("RPC widget uses only text and CJK-aware bounded fallback", () => {
  const t = setup(), display = new TaskWidget();
  t.ctx.mode = "rpc";
  t.record.name = "中文".repeat(100);
  widget(t.manager, t.ctx, display);
  const lines = t.calls.at(-1)[2];
  assert.ok(Array.isArray(lines));
  assert.deepEqual(lines, display.lines([...t.manager.records.values()])!.map(line => truncateToWidth(line, 150)));
  assert.equal(lines[0], "Subagents ─ 1 running · /subagents");
  assert.ok(lines[1].startsWith("● "));
  for (const line of lines) assert.ok(visibleWidth(line) <= 150);
});

test("widget bounds previews, retains attention, and refreshes theme colors", () => {
  const t = setup(), display = new TaskWidget();
  t.record.name = "中文🙂".repeat(50) + "\x1b[31mRED\x1b[0m\r\x07";
  t.record.activity = "\x1b]0;BAD-TITLE\x07read\nfile";
  for (let i = 0; i < 5; i++) t.manager.records.set(`task-${i}`, { ...t.record, id: `task-${i}`, name: `worker ${i}` });
  const unsafe = { ...t.record, id: "unsafe", name: "unsafe", state: "failed", stopped: false };
  t.manager.records.set(unsafe.id, unsafe);
  const lines = display.lines([...t.manager.records.values()])!;
  assert.equal(lines.filter(line => line.startsWith("●")).length, 3);
  assert.match(lines.join("\n"), /\+3 more active/);
  assert.match(lines.join("\n"), /shutdown unconfirmed/);
  widget(t.manager, t.ctx, display);
  let code = "31";
  const colors: string[] = [];
  const theme: any = { fg: (color: string, text: string) => { colors.push(color); return `\x1b[${code}m${text}\x1b[0m`; } };
  const component = t.calls.at(-1)[2]({}, theme);
  for (const width of [0, 1, 2, 3, 12, 40, 80]) {
    const rendered = component.render(width);
    for (const line of rendered) {
      assert.ok(visibleWidth(line) <= width);
      assert.doesNotMatch(stripTerminalSequences(line), /BAD-TITLE|[\x00-\x1f\x7f-\x9f]/);
    }
  }
  assert.ok(colors.includes("accent")); assert.ok(colors.includes("warning"));
  code = "32"; component.invalidate();
  const refreshed = component.render(80).join("\n");
  assert.match(refreshed, /\x1b\[32m/);
  assert.doesNotMatch(refreshed, /\x1b\[31m/);
});

test("widget card emphasizes structured names and semantic counts without extra rows", testContext => {
  const t = setup(), display = new TaskWidget();
  testContext.mock.method(Date, "now", () => t.record.startedAt);
  t.record.name = "auth · 中文 [running]";
  t.record.questions = [{ id: "q", title: "Which interface?" }];
  t.record.state = "waiting";
  const unsafe = { ...t.record, id: "unsafe", name: "unsafe", state: "failed", stopped: false, questions: [] };
  t.manager.records.set(unsafe.id, unsafe);
  widget(t.manager, t.ctx, display);
  const styles: [string, string][] = [];
  const theme: any = { fg: (color: string, text: string) => { styles.push([color, text]); return text; } };
  const component = t.calls.at(-1)[2]({}, theme);
  const rendered = component.render(150);
  assert.equal(rendered.length, display.lines([...t.manager.records.values()])!.length);
  assert.deepEqual(rendered, [
    "┌─ Subagents · 1 awaiting answer · 1 shutdown unconfirmed · /subagents",
    "│ ? auth · 中文 [running] · 0s · read: auth.ts",
    "│ ! unsafe · shutdown unconfirmed — inspect before continuing",
    "│ ? auth · 中文 [running] · Which interface?",
  ]);
  for (const pair of [
    ["accent", "Subagents"], ["warning", "1 awaiting answer"], ["warning", "1 shutdown unconfirmed"],
    ["text", t.record.name], ["warning", "?"], ["muted", " · 0s · read: auth.ts"],
  ]) assert.ok(styles.some(style => style[0] === pair[0] && style[1] === pair[1]), pair.join(": "));
});

test("widget result card uses success/error colors and vanishes at the original deadline", testContext => {
  const t = setup(), display = new TaskWidget();
  let now = 1000;
  testContext.mock.method(Date, "now", () => now);
  t.record.state = "completed"; t.record.stopped = true;
  display.result(t.record);
  widget(t.manager, t.ctx, display);
  const styles: [string, string][] = [];
  const theme: any = { fg: (color: string, text: string) => { styles.push([color, text]); return text; } };
  const component = t.calls.at(-1)[2]({}, theme);
  assert.deepEqual(component.render(80), ["┌─ Subagents · 1 completed · /subagents"]);
  assert.ok(styles.some(([color, text]) => color === "success" && text === "1 completed"));
  now = 8999;
  assert.equal(component.render(80).length, 1);
  now = 9000;
  assert.deepEqual(component.render(80), []);
  t.record.state = "failed";
  display.result(t.record);
  assert.deepEqual(component.render(80), ["┌─ Subagents · 1 failed · /subagents"]);
  assert.ok(styles.some(([color, text]) => color === "error" && text === "1 failed"));
  assert.equal(t.manager.records.size, 1);
});

test("RPC menu preserves task and question IDs as the first token", async () => {
  const t = setup(); t.ctx.mode = "rpc";
  t.record.name = "中文 auth\nwork";
  t.selections.push("task-id ● 中文 auth work · running", "Details");
  await taskMenu(t.manager, t.ctx);
  assert.match(t.dialogs[0][1][0], /^task-id ● 中文 auth work \[task-id\]/);
  t.record.questions.push({ id: "q-id", title: "Which\ninterface?" });
  t.selections.push("Answer question", "q-id ? Which interface?");
  await taskMenu(t.manager, t.ctx, "task-id");
  assert.equal(t.dialogs.at(-1)[1][0], "q-id ? Which interface?");
  assert.deepEqual(t.calls.at(-1), ["answer", "task-id", "q-id", "extra requirement"]);
});

test("snapshots have explicit sections and sanitize terminal controls", () => {
  const t = setup();
  t.record.name = "\x1b[31mauth\x1b[0m\nwork";
  t.record.error = "\x1b]0;evil\x07failure\x9b";
  t.record.output = "\x1b[2Jhello\x00\nworld";
  assert.equal(clean("\x1b[31mred\x1b[0m\t\n\x1b]0;title\x07\x9b"), "red\t\n");
  assert.doesNotMatch(taskSummary(t.record), /[\n\x1b]/);
  const snapshot = detail(t.record);
  for (const section of ["Run & access", "Task", "Error", "Questions", "Latest assistant text", "Recent activity"]) assert.ok(snapshot.includes(`── ${section}`));
  assert.match(snapshot, /hello\nworld/);
  assert.doesNotMatch(snapshot, /evil|[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  const component = resultRenderer({ content: t.record.output }, { expanded: true });
  assert.doesNotMatch(component.render(80).join("\n"), /\x1b|\x00/);
});
