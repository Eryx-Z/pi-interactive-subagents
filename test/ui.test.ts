import { test } from "node:test";
import assert from "node:assert/strict";
import { taskMenu, widget, resultRenderer, TaskWidget } from "../pi-extension/subagents/ui.ts";

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
  const selections: string[] = [];
  const ctx: any = { hasUI: true, ui: {
    select: async () => selections.shift(), editor: async () => "extra requirement",
    confirm: async () => true, notify: (text: string) => notices.push(text),
    setWidget: (...args: unknown[]) => calls.push(["widget", ...args]),
  } };
  return { record, manager, ctx, calls, notices, selections };
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
  assert.deepEqual(t.calls[0], ["widget", "rpc-subagents", ["Subagents · 1 running · /subagents"]]);
  t.record.activity = "bash: npm test"; widget(t.manager, t.ctx, display);
  assert.equal(t.calls.at(-1)[2].length, 1);
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
  assert.match(display.lines([t.record], 90000)!.join("\n"), /awaiting answer.*\n\? auth work · Which interface\?/);
  t.record.questions[0].responseSent = true;
  assert.deepEqual(display.lines([t.record], 90001), ["Subagents · 1 running · /subagents"]);
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
  assert.deepEqual(display.lines([t.record], 9000), ["Subagents · 1 running · /subagents"]);
  t.record.state = "completed"; t.record.stopped = true;
  display.result(t.record, 10000);
  assert.match(display.lines([t.record], 17999)![0], /1 completed/);
  assert.equal(display.lines([t.record], 18000), undefined);
});

test("result renderer produces bounded-width terminal lines", () => {
  const component = resultRenderer({ content: "Subagent auth completed\n" + "long text ".repeat(100) }, { expanded: true });
  for (const width of [20, 80]) {
    for (const line of component.render(width)) assert.ok(line.length <= width);
  }
});
