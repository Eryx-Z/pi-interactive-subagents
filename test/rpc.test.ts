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
  const r = rpc(100);
  await assert.rejects(r.request("never"), /unknown/);
  await r.stop();
  await assert.rejects(r.request("get_state"), /stopping/);
});
test("unexpected child exit rejects pending requests; shutdown is idempotent", async () => {
  const r = rpc();
  await assert.rejects(r.request("die"), /closed/);
  await Promise.all([r.stop(), r.stop()]);
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
