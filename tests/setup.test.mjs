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

// Plants ~/.copilot/settings.json under the HOME that tempWorkspace() just
// isolated, so a test can make the task/review model arrive via
// "user-settings" instead of plugin config.
function plantUserSettings(settings) {
  const dir = path.join(process.env.HOME, ".copilot");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings), "utf8");
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

test("setup validates --effort against the task model resolved from user settings, not the config-less fallback", async () => {
  const cwd = tempWorkspace();
  // No taskModel in plugin config, no COPILOT_MODEL env, no repo settings —
  // the task model can only be found by reading ~/.copilot/settings.json.
  plantUserSettings({ model: "claude-sonnet-4.6" });

  const report = await buildSetupReport(cwd, { binary: FIXTURE, effort: "high" });

  // If the effort probe resolved the task model without repoSettings/userSettings,
  // it would fall through to "auto" (which supports no reasoning effort) and
  // this would reject instead of succeeding.
  assert.equal(report.resolved.task.model, "claude-sonnet-4.6");
  assert.equal(report.resolved.task.source, "user-settings");
  assert.equal(report.resolved.effort, "high");
});
