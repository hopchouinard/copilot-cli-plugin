import { test } from "node:test";
import assert from "node:assert/strict";

import { parseStopReviewOutput } from "../plugins/copilot/scripts/stop-review-gate-hook.mjs";

test("an ALLOW first line permits the stop", () => {
  assert.deepEqual(parseStopReviewOutput("ALLOW: nothing to review"), { ok: true, reason: null });
});

test("a BLOCK first line blocks and carries the reason", () => {
  const result = parseStopReviewOutput("BLOCK: the retry loop never terminates\nmore detail");
  assert.equal(result.ok, false);
  assert.match(result.reason, /retry loop never terminates/);
});

test("empty output blocks rather than silently allowing", () => {
  assert.equal(parseStopReviewOutput("").ok, false);
});

test("an unrecognised first line blocks rather than guessing", () => {
  const result = parseStopReviewOutput("Sure! Here is my review of the changes.");
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected answer/i);
});
