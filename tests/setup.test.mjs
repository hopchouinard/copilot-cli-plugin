import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSetupReport } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { renderSetupReport } from "../plugins/copilot/scripts/lib/render.mjs";
import { getConfig, setConfig } from "../plugins/copilot/scripts/lib/state.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  // Isolate HOME so a real ~/.copilot/settings.json on the machine running
  // these tests can't leak a model choice into resolution and make the
  // "fallback" assertions flaky depending on the developer's local setup.
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-home-"));
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
}

test("setup reports auth and caches the model catalog", async () => {
  const cwd = tempWorkspace();
  const report = await buildSetupReport(cwd, { binary: FIXTURE });
  assert.equal(report.auth.loggedIn, true);
  assert.ok(report.modelCatalog.models.length > 0);
  assert.ok(getConfig(cwd).modelCatalog, "catalog should be persisted to config");
});

test("setup resolves both roles and reports the source of each", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  const report = await buildSetupReport(cwd, { binary: FIXTURE });
  assert.equal(report.resolved.review.model, "claude-sonnet-4.6");
  assert.equal(report.resolved.review.source, "config");
  assert.equal(report.resolved.task.source, "fallback");
});

test("rendered setup output names the multiplier for each role", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  const rendered = renderSetupReport(await buildSetupReport(cwd, { binary: FIXTURE }));
  assert.match(rendered, /review\s+claude-sonnet-4\.6\s+9x/);
  assert.match(rendered, /warn\s+at 6x/);
});

test("setup rejects an effort the chosen model does not support", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");
  await assert.rejects(
    () => buildSetupReport(cwd, { binary: FIXTURE, effort: "high" }),
    /does not support reasoning effort/
  );
});
