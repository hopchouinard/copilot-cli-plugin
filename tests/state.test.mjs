import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getConfig, setConfig, listJobs, upsertJob, generateJobId, loadState } from "../plugins/copilot/scripts/lib/state.mjs";

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-state-"));
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  return dir;
}

test("config defaults include the cost warn threshold and null model roles", () => {
  const cwd = tempWorkspace();
  const config = getConfig(cwd);
  assert.equal(config.stopReviewGate, false);
  assert.equal(config.costWarnThreshold, 6);
  assert.equal(config.reviewModel, null);
  assert.equal(config.taskModel, null);
  assert.equal(config.modelCatalog, null);
});

test("setConfig persists a value and leaves the other defaults intact", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  const config = getConfig(cwd);
  assert.equal(config.reviewModel, "claude-sonnet-4.6");
  assert.equal(config.costWarnThreshold, 6);
});

test("upsertJob inserts then merges by id", () => {
  const cwd = tempWorkspace();
  const id = generateJobId("review");
  upsertJob(cwd, { id, status: "running" });
  upsertJob(cwd, { id, status: "completed", summary: "done" });
  const jobs = listJobs(cwd);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].summary, "done");
});

test("state prunes to the 50 newest jobs", () => {
  const cwd = tempWorkspace();
  for (let index = 0; index < 55; index += 1) {
    upsertJob(cwd, { id: `job-${index}`, status: "completed" });
  }
  assert.equal(loadState(cwd).jobs.length, 50);
});

test("generateJobId is prefixed and unique", () => {
  const a = generateJobId("task");
  const b = generateJobId("task");
  assert.ok(a.startsWith("task-"));
  assert.notEqual(a, b);
});
