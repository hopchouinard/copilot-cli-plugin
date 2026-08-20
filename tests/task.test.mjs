import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeTask } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { setConfig } from "../plugins/copilot/scripts/lib/state.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  // Isolate HOME so a real ~/.copilot/settings.json on the machine running
  // these tests can't leak a model choice into resolution (see setup.test.mjs).
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-home-"));
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
}

test("a task run resolves the task model, not the review model", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  setConfig(cwd, "taskModel", "gpt-5.3-codex");
  const execution = await executeTask(cwd, { prompt: "fix the bug", binary: FIXTURE });
  assert.equal(execution.payload.model, "gpt-5.3-codex");
});

test("a write-capable task runs in interactive mode, not plan mode", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");
  const execution = await executeTask(cwd, { prompt: "fix it", write: true, binary: FIXTURE });
  assert.equal(execution.payload.mode, "interactive");
});

test("a read-only task runs in plan mode", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");
  const execution = await executeTask(cwd, { prompt: "investigate", write: false, binary: FIXTURE });
  assert.equal(execution.payload.mode, "plan");
});

test("a task with neither a prompt nor --resume-last is rejected", async () => {
  const cwd = tempWorkspace();
  await assert.rejects(() => executeTask(cwd, { prompt: "", binary: FIXTURE }), /Provide a prompt/);
});

test("the task payload carries usage so status can total it later", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");
  const execution = await executeTask(cwd, { prompt: "go", binary: FIXTURE });
  assert.equal(execution.payload.usage.premiumRequests, 1);
});
