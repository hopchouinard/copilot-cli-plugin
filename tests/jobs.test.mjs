import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runTrackedJob, createJobRecord, SESSION_ID_ENV } from "../plugins/copilot/scripts/lib/tracked-jobs.mjs";
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

test("the Claude session id and the Copilot session id stay distinct: filtering keys off the Claude id, resume off the Copilot id", async () => {
  const cwd = tempWorkspace();
  const claudeSessionId = "claude-session-A";
  const copilotSessionId = "11111111-1111-1111-1111-111111111111";

  // A background job pre-mints its Copilot session id at enqueue time (see
  // copilot-companion.mjs's enqueueBackgroundTask) and carries it as
  // copilotSessionId, distinct from the Claude Code session id createJobRecord
  // derives from SESSION_ID_ENV as `sessionId`. If these two ever get
  // collapsed onto one field again, this test must fail.
  const record = createJobRecord(
    {
      id: generateJobId("task"),
      kind: "task",
      kindLabel: "rescue",
      title: "Copilot Task",
      workspaceRoot: cwd,
      jobClass: "task",
      summary: "test job",
      copilotSessionId
    },
    { env: { [SESSION_ID_ENV]: claudeSessionId } }
  );
  assert.equal(record.sessionId, claudeSessionId);
  assert.equal(record.copilotSessionId, copilotSessionId);

  await runTrackedJob(record, async () => ({
    exitStatus: 0,
    payload: {},
    rendered: "done",
    summary: "done",
    sessionId: copilotSessionId,
    usage: { premiumRequests: 1 }
  }));

  // Filtering by the Claude Code session id (as /copilot:status does by
  // default) finds the job...
  const scoped = buildStatusSnapshot(cwd, { env: { [SESSION_ID_ENV]: claudeSessionId } });
  assert.equal(scoped.jobs.length, 1);
  assert.equal(scoped.jobs[0].id, record.id);

  // ...but the Copilot session id is not interchangeable with it — filtering
  // by that id must not match, because it is a different id space entirely.
  const wrongScope = buildStatusSnapshot(cwd, { env: { [SESSION_ID_ENV]: copilotSessionId } });
  assert.equal(wrongScope.jobs.length, 0);

  // The id a `copilot --resume=<id>` line would use is the Copilot session
  // id, unaffected by which Claude session filtered the job in.
  assert.equal(scoped.jobs[0].copilotSessionId, copilotSessionId);
  assert.equal(scoped.jobs[0].sessionId, claudeSessionId);
});
