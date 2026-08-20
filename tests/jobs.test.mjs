import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runTrackedJob, createJobRecord } from "../plugins/copilot/scripts/lib/tracked-jobs.mjs";
import { buildStatusSnapshot } from "../plugins/copilot/scripts/lib/job-control.mjs";
import { generateJobId } from "../plugins/copilot/scripts/lib/state.mjs";

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
}

function job(workspaceRoot) {
  return createJobRecord({
    id: generateJobId("task"),
    kind: "task",
    kindLabel: "rescue",
    title: "Copilot Task",
    workspaceRoot,
    jobClass: "task",
    summary: "test job"
  });
}

test("a successful tracked job records usage on the job", async () => {
  const cwd = tempWorkspace();
  const record = job(cwd);
  await runTrackedJob(record, async () => ({
    exitStatus: 0,
    payload: {},
    rendered: "done",
    summary: "done",
    usage: { premiumRequests: 4, model: "claude-sonnet-4.6" }
  }));
  const snapshot = buildStatusSnapshot(cwd, { all: true });
  assert.equal(snapshot.jobs[0].usage.premiumRequests, 4);
});

test("a failing tracked job is marked failed and rethrows", async () => {
  const cwd = tempWorkspace();
  const record = job(cwd);
  await assert.rejects(() =>
    runTrackedJob(record, async () => {
      throw new Error("copilot exploded");
    })
  );
  const snapshot = buildStatusSnapshot(cwd, { all: true });
  assert.equal(snapshot.jobs[0].status, "failed");
  assert.match(snapshot.jobs[0].errorMessage, /copilot exploded/);
});

test("the status snapshot totals premium requests across jobs", async () => {
  const cwd = tempWorkspace();
  for (const premium of [1, 2]) {
    await runTrackedJob(job(cwd), async () => ({
      exitStatus: 0,
      payload: {},
      rendered: "ok",
      summary: "ok",
      usage: { premiumRequests: premium }
    }));
  }
  const snapshot = buildStatusSnapshot(cwd, { all: true });
  assert.equal(snapshot.usageTotal.premiumRequests, 3);
});
