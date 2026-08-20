import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeCatalog } from "../plugins/copilot/scripts/lib/models.mjs";
import { describeCost, exceedsThreshold, formatUsage, summariseJobUsage } from "../plugins/copilot/scripts/lib/usage.mjs";

const CATALOG = normalizeCatalog({
  models: [
    { id: "auto", capabilities: {}, billing: { discountPercent: 10 } },
    { id: "claude-sonnet-4.6", capabilities: {}, billing: { multiplier: 9 } },
    { id: "claude-haiku-4.5", capabilities: {}, billing: { multiplier: 0.33 } }
  ]
});

test("describeCost labels a priced model with its multiplier", () => {
  assert.equal(describeCost("claude-sonnet-4.6", CATALOG).label, "claude-sonnet-4.6 (9x premium)");
});

test("describeCost labels auto with its discount", () => {
  assert.equal(describeCost("auto", CATALOG).label, "auto (10% discount)");
});

test("describeCost says the cost is unknown for a model missing from the catalog", () => {
  assert.equal(describeCost("mystery-model", CATALOG).label, "mystery-model (cost unknown)");
});

test("exceedsThreshold is true at exactly the threshold", () => {
  assert.equal(exceedsThreshold("claude-sonnet-4.6", CATALOG, 9), true);
});

test("exceedsThreshold is false below the threshold", () => {
  assert.equal(exceedsThreshold("claude-haiku-4.5", CATALOG, 6), false);
});

test("a threshold of 0 disables the check entirely", () => {
  assert.equal(exceedsThreshold("claude-sonnet-4.6", CATALOG, 0), false);
});

test("an uncatalogued model never trips the threshold", () => {
  assert.equal(exceedsThreshold("mystery-model", CATALOG, 6), false);
});

test("formatUsage returns null when nothing was reported", () => {
  assert.equal(formatUsage({ premiumRequests: null, aiu: null }), null);
});

test("formatUsage reports premium requests when present", () => {
  assert.match(formatUsage({ premiumRequests: 3, model: "claude-sonnet-4.6" }), /3 premium request/);
});

test("summariseJobUsage totals only jobs that reported usage", () => {
  const summary = summariseJobUsage([
    { usage: { premiumRequests: 2 } },
    { usage: { premiumRequests: 1 } },
    { usage: null },
    {}
  ]);
  assert.deepEqual(summary, { premiumRequests: 3, jobs: 2 });
});

test("summariseJobUsage returns null when no job reported usage", () => {
  assert.equal(summariseJobUsage([{ usage: null }, {}]), null);
});
