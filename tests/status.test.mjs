import { test } from "node:test";
import assert from "node:assert/strict";

import { renderStatusReport } from "../plugins/copilot/scripts/lib/render.mjs";

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
