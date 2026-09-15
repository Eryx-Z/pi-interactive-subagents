import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { RpcProcess, JsonlDecoder } from "../pi-extension/subagents/rpc.ts";
const fixture = fileURLToPath(new URL("./fixtures/fake-rpc.mjs", import.meta.url));
const rpc = (timeout = 1000) => new RpcProcess({ command: process.execPath, args: [fixture], cwd: process.cwd() }, timeout, 25);

test("JSONL preserves chunked UTF8, CRLF, Unicode separators and rejects oversized/malformed frames", () => {
  const events: any[] = []; const d = new JsonlDecoder(e => events.push(e));
  const b = Buffer.from(JSON.stringify({ type: "message", value: "中\u2028文\u2029" }) + "\r\n");
  for (const byte of b) d.push(Buffer.from([byte]));
  assert.equal(events[0].value, "中\u2028文\u2029");
  assert.throws(() => new JsonlDecoder(() => {}, 8).push(Buffer.from('123456789')), /limit/);
  assert.throws(() => d.push(Buffer.from('bad\n')));
});
test("RPC requests correlate out-of-order responses and reject failed/mismatched commands", async () => {
  const r = rpc();
  try {
    const [a, b] = await Promise.all([r.request("echo", { value: "a", delay: 20 }), r.request("echo", { value: "b" })]);
    assert.equal(a.value, "a"); assert.equal(b.value, "b");
    await assert.rejects(r.request("reject"), /rejected/);
    await assert.rejects(r.request("wrong"), /mismatch/);
  } finally { await r.stop(); }
});
test("RPC timeout is explicit and stops the child, rejecting outstanding requests", async () => {
  const r = rpc(1000);
  await r.request("get_state");
  await assert.rejects(r.request("never"), /unknown/);
  await r.stop();
  await assert.rejects(r.request("get_state"), /stopping/);
});
test("unexpected child exit rejects pending requests; shutdown is idempotent", async () => {
  const r = rpc();
  await assert.rejects(r.request("die"), /closed/);
  const first = r.stop();
  assert.equal(r.stop(), first);
  await assert.rejects(first, /without confirmed agent\/tool cleanup/);
  assert.throws(() => r.send({ type: "prompt", message: "hi" }), /closed/);
  await assert.rejects(r.request("get_state"), /stopping/);
});
test("JsonlDecoder ignores empty lines and rejects missing type or non-object payloads", () => {
  const events: any[] = [];
  const decoder = new JsonlDecoder(e => events.push(e));
  decoder.push(Buffer.from("\n\n" + JSON.stringify({ type: "first" }) + "\r\n\n" + JSON.stringify({ type: "second" }) + "\n"));
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "first");
  assert.equal(events[1].type, "second");

  assert.throws(() => decoder.push(Buffer.from(JSON.stringify({ notype: true }) + "\n")), /Invalid RPC event/);
  assert.throws(() => decoder.push(Buffer.from(JSON.stringify("string-not-object") + "\n")), /Invalid RPC event/);
});

test("stop escalates without EOF when abort cleanup cannot be confirmed", async () => {
  const r = new RpcProcess({ command: process.execPath, cwd: process.cwd(), args: ['-e', `
    let buffer = '';
    process.stdin.on('data', data => {
      buffer += data;
      let n;
      while ((n = buffer.indexOf('\\n')) >= 0) {
        const e = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
        if (e.type === 'abort') continue;
        process.stdout.write(JSON.stringify({type:'response', id:e.id, command:e.type, success:true}) + '\\n');
      }
    });
    process.stdin.on('end', () => process.stdout.write(JSON.stringify({type:'eof'}) + '\\n'));
    process.on('SIGTERM', () => process.exit(0));
  `] }, 2000, 50);
  const events: string[] = [];
  r.on('event', e => events.push(e.type));
  await r.request('get_state');
  await assert.rejects(r.stop(), /without confirmed agent\/tool cleanup/);
  assert.equal(events.includes('eof'), false);
});

const preflightFixture = fileURLToPath(new URL('./fixtures/prompt-preflight-rpc.mjs', import.meta.url));
function preflightRpc(timeout = 1000, grace = 500) {
  const rpc = new RpcProcess({ command: process.execPath, args: [preflightFixture], cwd: process.cwd() }, timeout, grace);
  const events: any[] = [];
  rpc.on('event', event => events.push(event));
  return { process: rpc, events };
}
async function waitForPreflight(events: any[]) {
  for (let i = 0; i < 100; i++) {
    if (events.some(e => e.type === 'preflight')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not start prompt preflight');
}

test('prompt caller timeout leaves unknown acceptance tracked and forbids EOF confirmation', async () => {
  const { process: r, events } = preflightRpc();
  try {
    await r.request('get_state');
    await assert.rejects(r.request('prompt', { message: 'never accepted' }), /timed out.*unknown/);
    await assert.rejects(r.stop(), /Prompt preflight did not settle/);
    assert.ok(events.some(e => e.type === 'signal_received'));
    assert.equal(events.some(e => e.type === 'eof' || e.type === 'cleanup_command'), false);
  } finally { await r.stop().catch(() => {}); }
});

test('late success/rejection receipts after caller cancellation drain preflight before cleanup, not model completion', async () => {
  for (const accepted of [true, false]) {
    const { process: r, events } = preflightRpc();
    try {
      await r.request('get_state');
      const prompt = assert.rejects(r.request('prompt', { message: 'gated', receiptDelay: 200, accepted }), /stopping/);
      await waitForPreflight(events);
      const stopping = r.stop();
      for (const type of ['prompt', 'steer', 'follow_up']) {
        await assert.rejects(r.request(type, { message: 'new work' }), /stopping/);
        assert.throws(() => r.send({ type, message: 'raw new work' }), /stopping/);
      }
      await stopping;
      await prompt;
      assert.deepEqual(events.map(e => e.type), ['preflight', 'receipt', 'cleanup_command', 'cleanup_command', 'eof']);
      assert.deepEqual(events.filter(e => e.type === 'cleanup_command').map(e => e.command), ['clear_queue', 'abort']);
      assert.equal(events.some(e => e.type === 'model_complete'), false);
    } finally { await r.stop().catch(() => {}); }
  }
});

test('late prompt receipt after caller timeout can confirm cleanup only inside the bounded preflight wait', async () => {
  const { process: r, events } = preflightRpc(1000, 1000);
  try {
    await r.request('get_state');
    await assert.rejects(r.request('prompt', { message: 'slow receipt', receiptDelay: 1300 }), /timed out.*unknown/);
    await r.stop();
    assert.deepEqual(events.map(e => e.type), ['preflight', 'receipt', 'cleanup_command', 'cleanup_command', 'eof']);
  } finally { await r.stop().catch(() => {}); }
});

test('mismatched prompt receipts do not erase unknown acceptance', async () => {
  const { process: r, events } = preflightRpc();
  try {
    await r.request('get_state');
    await assert.rejects(r.request('prompt', { message: 'wrong receipt', receiptDelay: 10, wrongCommand: true }), /mismatch/);
    await assert.rejects(r.stop(), /Prompt preflight did not settle/);
    assert.equal(events.some(e => e.type === 'eof' || e.type === 'cleanup_command'), false);
  } finally { await r.stop().catch(() => {}); }
});

test('all unresolved prompts count, including unawaited raw sends without caller promises', async () => {
  const { process: r, events } = preflightRpc();
  try {
    await r.request('get_state');
    r.send({ type: 'prompt', message: 'raw unresolved prompt' });
    await r.request('prompt', { message: 'later handled prompt', receiptDelay: 10, accepted: false }).catch(() => {});
    await assert.rejects(r.stop(), /Prompt preflight did not settle/);
    assert.equal(events.filter(e => e.type === 'preflight').length, 2);
    assert.equal(events.some(e => e.type === 'eof' || e.type === 'cleanup_command'), false);
  } finally { await r.stop().catch(() => {}); }
});
