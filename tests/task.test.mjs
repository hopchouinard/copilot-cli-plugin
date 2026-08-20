import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeTask, findTaskResumeCandidate } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { renderTaskResult } from "../plugins/copilot/scripts/lib/render.mjs";
import { setConfig } from "../plugins/copilot/scripts/lib/state.mjs";
import { TASK_SESSION_PREFIX } from "../plugins/copilot/scripts/lib/copilot.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  // Isolate HOME so a real ~/.copilot/settings.json on the machine running
  // these tests can't leak a model choice into resolution (see setup.test.mjs).
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-home-"));
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
}

// Like withScenario in copilot.test.mjs/setup.test.mjs: writes a scenario
// file for the fixture to read (via FAKE_COPILOT_SCRIPT) so a test can
// control sessions.list / turn events without touching the real binary.
function withScenario(scenario) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scn-")), "scenario.json");
  fs.writeFileSync(file, JSON.stringify(scenario), "utf8");
  return { binary: FIXTURE, env: { ...process.env, FAKE_COPILOT_SCRIPT: file } };
}

// Like withScenario, but also points the fixture at a capture file so a test
// can read back exactly which RPC calls (and params) the fixture received —
// needed to assert on *which* bootstrap method was called (session.create
// vs session.resume), not just on a return value that would look identical
// either way.
function withCaptureScenario(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scn-"));
  const scenarioPath = path.join(dir, "scenario.json");
  fs.writeFileSync(scenarioPath, JSON.stringify(scenario), "utf8");
  const capturePath = path.join(dir, "capture.json");
  return {
    binary: FIXTURE,
    env: { ...process.env, FAKE_COPILOT_SCRIPT: scenarioPath, FAKE_COPILOT_CAPTURE_FILE: capturePath },
    capturePath
  };
}

function readCapturedCalls(capturePath) {
  return fs.existsSync(capturePath) ? JSON.parse(fs.readFileSync(capturePath, "utf8")) : [];
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

test("--resume-last resumes the latest matching task session instead of starting fresh", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");
  const execution = await executeTask(cwd, {
    resumeLast: true,
    ...withScenario({
      sessions: [{ sessionId: "prior-session-1", name: `${TASK_SESSION_PREFIX}: fix the bug` }],
      finalMessage: "continuing from before"
    })
  });
  assert.equal(execution.sessionId, "prior-session-1");
  assert.equal(execution.payload.rawOutput, "continuing from before");
});

test("--resume-last with no matching prior task session rejects with a clear error", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");
  await assert.rejects(
    () => executeTask(cwd, { resumeLast: true, ...withScenario({ sessions: [] }) }),
    /No previous Copilot task session was found for this repository/
  );
});

test("a background job's preset copilotSessionId creates a new session — it must never resume", async () => {
  // Regression guard for the production defect the coordinator probed live
  // against Copilot 1.0.80: session.resume for an id that was never created
  // fails with -32603 "Session not found". A background job's pre-minted
  // copilotSessionId must route to session.create, not session.resume, or
  // every /copilot:task --background run fails immediately against the
  // real CLI. Assert on the fixture's recorded RPC calls, not just on
  // execution.sessionId — a resume would echo the same id back and look
  // identical on the return value alone.
  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");
  const capture = withCaptureScenario({});
  const presetId = "11111111-2222-3333-4444-555555555555";

  const execution = await executeTask(cwd, {
    prompt: "run this in the background",
    copilotSessionId: presetId,
    ...capture
  });
  assert.equal(execution.sessionId, presetId);

  const calls = readCapturedCalls(capture.capturePath);
  const created = calls.find((call) => call.method === "session.create");
  assert.ok(created, "expected a session.create call to be captured");
  assert.equal(created.params.sessionId, presetId);
  assert.ok(
    !calls.some((call) => call.method === "session.resume"),
    "session.resume must never be called for a preset copilotSessionId"
  );
});

test("renderTaskResult lists edited files when the run was write-capable and touched files", () => {
  const rendered = renderTaskResult(
    { finalMessage: "Fixed the bug.", touchedFiles: ["src/a.js", "src/b.js"], usage: { premiumRequests: 2, model: "claude-haiku-4.5" } },
    { model: "claude-haiku-4.5", catalog: null, write: true }
  );
  assert.match(rendered, /Copilot edited these files:/);
  assert.match(rendered, /- src\/a\.js/);
  assert.match(rendered, /- src\/b\.js/);
});

test("renderTaskResult falls back to '(no output)' when Copilot returned nothing", () => {
  const rendered = renderTaskResult(
    { finalMessage: "", touchedFiles: [], usage: { premiumRequests: null, aiu: null } },
    { model: "claude-haiku-4.5", catalog: null, write: false }
  );
  assert.match(rendered, /\(no output\)/);
});

test("findTaskResumeCandidate reports available:true with the sessionId when a matching task session exists", async () => {
  const cwd = tempWorkspace();
  const report = await findTaskResumeCandidate(
    cwd,
    withScenario({ sessions: [{ sessionId: "prior-session-9", name: `${TASK_SESSION_PREFIX}: something` }] })
  );
  assert.equal(report.available, true);
  assert.equal(report.sessionId, "prior-session-9");
});

test("findTaskResumeCandidate reports available:false when there is no matching task session", async () => {
  const cwd = tempWorkspace();
  const report = await findTaskResumeCandidate(cwd, withScenario({ sessions: [] }));
  assert.equal(report.available, false);
  assert.equal(report.sessionId, null);
});

test("findTaskResumeCandidate degrades to available:false instead of throwing when Copilot cannot be reached", async () => {
  const cwd = tempWorkspace();
  const report = await findTaskResumeCandidate(cwd, { binary: path.join(os.tmpdir(), "no-such-copilot-binary") });
  assert.equal(report.available, false);
  assert.equal(report.sessionId, null);
});
