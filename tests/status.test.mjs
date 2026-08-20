import { test } from "node:test";
import assert from "node:assert/strict";

import { renderStatusReport, renderStoredJobResult } from "../plugins/copilot/scripts/lib/render.mjs";
import { DEFAULT_MAX_STATUS_JOBS } from "../plugins/copilot/scripts/lib/job-control.mjs";

test("the status table includes a premium column and a session total", () => {
  const rendered = renderStatusReport({
    jobs: [
      { id: "task-1", kindLabel: "rescue", status: "completed", phase: "done", summary: "fix bug", usage: { premiumRequests: 4 } },
      { id: "review-1", kindLabel: "review", status: "running", phase: "investigating", summary: "review", usage: null }
    ],
    usageTotal: { premiumRequests: 4, jobs: 1 }
  });
  assert.match(rendered, /premium/i);
  assert.match(rendered, /task-1/);
  assert.match(rendered, /4/);
  assert.match(rendered, /session total/i);
});

test("a job with no usage renders a dash rather than a zero", () => {
  const rendered = renderStatusReport({
    jobs: [{ id: "review-1", kindLabel: "review", status: "running", phase: "starting", summary: "r", usage: null }],
    usageTotal: null
  });
  assert.doesNotMatch(rendered, /\|\s*0\s*\|/);
});

test("without --all the status table is capped to a compact window; with --all it shows everything", () => {
  const jobs = Array.from({ length: DEFAULT_MAX_STATUS_JOBS + 2 }, (_, index) => ({
    id: `task-${index}`,
    kindLabel: "rescue",
    status: "completed",
    phase: "done",
    summary: `job ${index}`,
    usage: null
  }));

  const compact = renderStatusReport({ jobs, usageTotal: null });
  const full = renderStatusReport({ jobs, usageTotal: null, all: true });

  assert.notEqual(compact, full);
  // The last two jobs fall outside the compact window and must not appear
  // unless --all is set. If the flag stopped mattering (both branches
  // rendered the same, uncapped `report.jobs`), this would fail.
  const overflowId = `task-${DEFAULT_MAX_STATUS_JOBS + 1}`;
  assert.doesNotMatch(compact, new RegExp(overflowId));
  assert.match(full, new RegExp(overflowId));
});

test("renderStoredJobResult resumes using the Copilot session id, never the Claude Code session id", () => {
  const job = {
    id: "task-1",
    title: "Copilot Task",
    sessionId: "claude-session-AAAA",
    copilotSessionId: "copilot-session-BBBB"
  };
  const storedJob = { rendered: "# Copilot Task\n\nFixed the bug.\n" };

  const rendered = renderStoredJobResult(job, storedJob);

  assert.match(rendered, /copilot --resume=copilot-session-BBBB/);
  assert.doesNotMatch(rendered, /claude-session-AAAA/);
});
