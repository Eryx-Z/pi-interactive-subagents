import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { snapshotContext, seedSession, taskPrompt, closePendingCalls } from "../pi-extension/subagents/context.ts";

test("full snapshot uses active branch including current turn, not abandoned branches", () => {
  const sm = SessionManager.inMemory('/tmp');
  const first = sm.appendMessage({ role: "user", content: "base", timestamp: 0 });
  sm.appendMessage({ role: "user", content: "abandoned", timestamp: 1 });
  sm.branch(first);
  sm.appendMessage({ role: "user", content: "latest useful instruction", timestamp: 2 });
  const snapshot = snapshotContext(sm);
  assert.equal(snapshot.length, 2);
  assert.match(JSON.stringify(snapshot), /latest useful/);
  assert.doesNotMatch(JSON.stringify(snapshot), /abandoned/);
  sm.appendMessage({ role: "user", content: "later parent message", timestamp: 3 });
  assert.doesNotMatch(JSON.stringify(snapshot), /later parent/);
});
test("full snapshot respects compaction summaries and retained context", () => {
  const sm = SessionManager.inMemory('/tmp');
  sm.appendMessage({ role: "user", content: "old huge context", timestamp: 0 });
  const keep = sm.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  sm.appendCompaction("summary", keep, 100);
  sm.appendMessage({ role: "user", content: "current", timestamp: 2 });
  const snap = JSON.stringify(snapshotContext(sm));
  assert.match(snap, /summary/); assert.match(snap, /retained/); assert.match(snap, /current/);
  assert.doesNotMatch(snap, /old huge context/);
});
test("none/partial seed empty sessions; full seeds reference messages and closes pending parent calls", () => {
  const dir = mkdtempSync(join(tmpdir(), 'context-'));
  try {
    const parent: any[] = [{ role: 'user', content: 'context', timestamp: 0 }, { role: 'assistant', content: [{ type: 'text', text: 'Useful current reasoning' }, { type: 'toolCall', id: 'pending', name: 'subagent', arguments: {} }], timestamp: 1 }];
    for (const mode of ['none', 'partial', 'full'] as const) {
      const path = join(dir, mode + '.jsonl'); seedSession(path, dir, mode, parent, '/path/to/parent-session.jsonl');
      const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      assert.equal(lines.length, mode === 'full' ? 4 : 1);
      assert.equal(lines[0].parentSession, '/path/to/parent-session.jsonl');
      assert.equal(lines[0].cwd, dir);
      if (mode === 'full') assert.match(JSON.stringify(lines), /Useful current reasoning/);
    }
    assert.equal(parent.length, 2);
    assert.equal(closePendingCalls(parent).at(-1)?.role, 'toolResult');
    assert.match(taskPrompt('task', 'src/a', 'partial', 'selected background'), /selected background/);
    assert.throws(() => taskPrompt('task', 'src/a', 'partial'), /requires/);
    assert.throws(() => taskPrompt('task', 'src/a', 'none', 'accidental history'), /only supported/);
    assert.doesNotMatch(taskPrompt('task', 'src/a', 'none'), /selected background/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("closePendingCalls closes multiple pending calls and preserves completed results", () => {
  const messages: any[] = [
    { role: 'user', content: 'do work' },
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
        { type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'test' } },
        { type: 'toolCall', id: 'call-3', name: 'write', arguments: { path: 'b.ts' } },
      ],
    },
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'content' }] },
  ];
  const closed = closePendingCalls(messages);
  assert.equal(closed.length, 5);
  assert.equal(closed[0].role, 'user');
  assert.equal(closed[1].role, 'assistant');
  assert.equal(closed[2].role, 'toolResult');
  assert.equal(closed[2].toolCallId, 'call-1');
  assert.equal(closed[2].isError, undefined);
  assert.equal(closed[3].role, 'toolResult');
  assert.equal(closed[3].toolCallId, 'call-2');
  assert.equal(closed[3].isError, true);
  assert.equal(closed[4].role, 'toolResult');
  assert.equal(closed[4].toolCallId, 'call-3');
  assert.equal(closed[4].isError, true);
});
test("taskPrompt injects cooperative guidelines, context mode, and ownership for all modes", () => {
  const nonePrompt = taskPrompt('build feature', 'src/feature/*', 'none');
  assert.match(nonePrompt, /Context mode: none/);
  assert.match(nonePrompt, /Ownership: src\/feature\/\*/);
  assert.match(nonePrompt, /Assigned task:\nbuild feature/);
  assert.match(nonePrompt, /cooperation agreement/);
  assert.doesNotMatch(nonePrompt, /Selected parent context/);

  const fullPrompt = taskPrompt('fix bug', 'src/bug.ts', 'full');
  assert.match(fullPrompt, /Context mode: full/);
  assert.match(fullPrompt, /Ownership: src\/bug\.ts/);
  assert.match(fullPrompt, /Assigned task:\nfix bug/);
  assert.doesNotMatch(fullPrompt, /Selected parent context/);

  const partialPrompt = taskPrompt('test module', 'test/*', 'partial', 'use auth token in headers');
  assert.match(partialPrompt, /Context mode: partial/);
  assert.match(partialPrompt, /Selected parent context:\nuse auth token in headers/);
  assert.match(partialPrompt, /Assigned task:\ntest module/);

  assert.throws(() => taskPrompt('task', 'src/*', 'full', 'accidental text'), /contextText is only supported in partial mode/);
  assert.throws(() => taskPrompt('task', 'src/*', 'invalid' as any), /Invalid context mode/);
});

test("closePendingCalls preserves error/aborted assistants without orphan provider results", async () => {
  const { transformMessages } = await import("@earendil-works/pi-ai/api/transform-messages");
  for (const stopReason of ["error", "aborted"] as const) {
    const messages: any[] = [
      { role: "user", content: "interrupted task", timestamp: 0 },
      { role: "assistant", api: "openai-responses", provider: "openai", model: "fixture", stopReason,
        content: [{ type: "toolCall", id: "unexecuted", name: "read", arguments: { path: "a" } }], timestamp: 1 },
      { role: "user", content: "later dispatch", timestamp: 2 },
    ];
    const closed = closePendingCalls(messages);
    assert.deepEqual(closed, messages);
    const transformed = transformMessages(closed as any, { api: "openai-responses", provider: "openai", id: "fixture", input: ["text"] } as any);
    assert.equal(transformed.some(m => m.role === "toolResult"), false);
    assert.deepEqual(transformed.map(m => m.role), ["user", "user"]);
  }
});
