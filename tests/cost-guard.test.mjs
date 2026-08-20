import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCostCheck } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { setConfig } from "../plugins/copilot/scripts/lib/state.mjs";
import { normalizeCatalog } from "../plugins/copilot/scripts/lib/models.mjs";

const CATALOG = normalizeCatalog({
  models: [
    { id: "claude-sonnet-4.6", capabilities: {}, billing: { multiplier: 9 } },
    { id: "claude-haiku-4.5", capabilities: {}, billing: { multiplier: 0.33 } }
  ]
});

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  // Isolate HOME so a real ~/.copilot/settings.json on the machine running
  // these tests can't leak a model choice into resolution and make the
  // assertions flaky depending on the developer's local setup.
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
  setConfig(cwd, "modelCatalog", CATALOG);
  return cwd;
}

test("a 9x model trips the default 6x threshold and offers the cheapest alternative", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  const check = buildCostCheck(cwd, { role: "review" });
  assert.equal(check.exceeds, true);
  assert.equal(check.multiplier, 9);
  assert.equal(check.cheapest, "claude-haiku-4.5");
});

test("a cheap model does not trip the threshold", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-haiku-4.5");
  assert.equal(buildCostCheck(cwd, { role: "review" }).exceeds, false);
});

test("a zero threshold disables the guard", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  setConfig(cwd, "costWarnThreshold", 0);
  assert.equal(buildCostCheck(cwd, { role: "review" }).exceeds, false);
});
