import { test } from "node:test";
import assert from "node:assert/strict";
import { taskMenu, widget, resultRenderer } from "../pi-extension/subagents/ui.ts";

function setup() {
  const record: any = { id: "task-id", name: "auth work", state: "running", loadout: { cwd: "/project" }, context: "partial", run: 1, ownership: "src/auth", sessionFile: "/tmp/session.jsonl", task: "fix auth", startedAt: Date.now(), updatedAt: Date.now(), activity: "read: auth.ts", output: "working", log: [], questions: [] };
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
  t.selections.push("Continue");
  await taskMenu(t.manager, t.ctx, "task-id");
  assert.deepEqual(t.calls, [["cancel", "task-id"], ["continue", "task-id", "extra requirement"]]);
});
test("widget updates activity and headless mode has no terminal requirements", async () => {
  const t = setup(); widget(t.manager, t.ctx);
  assert.match(JSON.stringify(t.calls), /read: auth.ts/);
  t.record.activity = "bash: npm test"; widget(t.manager, t.ctx);
  assert.match(JSON.stringify(t.calls.at(-1)), /npm test/);
  t.ctx.hasUI = false;
  const count = t.calls.length; widget(t.manager, t.ctx); assert.equal(t.calls.length, count);
  await assert.rejects(taskMenu(t.manager, t.ctx), /headless/);
});
test("result renderer produces bounded-width terminal lines", () => {
  const component = resultRenderer({ content: "Subagent auth completed\n" + "long text ".repeat(100) }, { expanded: true });
  for (const width of [20, 80]) {
    for (const line of component.render(width)) assert.ok(line.length <= width);
  }
});
