import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseFailure } from "../pi-extension/subagents/diagnostics.ts";
import { loadout } from "./fixtures/loadout.ts";

test('credential failures delivered after prompt acceptance still have actionable context', () => {
  const config = loadout('/tmp');
  const result = diagnoseFailure('No API key found for example', config);
  assert.match(result, /\[subagent credentials\]/);
  assert.match(result, /phase=model run/);
  assert.match(result, /Parent-only in-memory authentication is not copied/);
  assert.ok(result.endsWith('Original error: No API key found for example'));
});

test('unknown runtime errors and rate limits are not misreported as missing credentials', () => {
  for (const error of ['provider failed', '429 rate limit exceeded', 'tool execution failed']) {
    assert.equal(diagnoseFailure(error, loadout('/tmp')), error);
  }
});
