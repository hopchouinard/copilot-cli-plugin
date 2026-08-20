// Regression coverage for the final whole-branch review fix wave
// (2026-08-19). Each block below is labeled with the finding it closes; see
// .superpowers/sdd/2026-08-19-copilot-plugin-cc/final-fix-report.md for the
// full writeup.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCopilotTurn } from "../plugins/copilot/scripts/lib/copilot.mjs";
import { executeTrackedTask } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { buildStatusSnapshot } from "../plugins/copilot/scripts/lib/job-control.mjs";
import { buildSetupReport } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { buildTranscriptDigest } from "../plugins/copilot/scripts/lib/claude-session-transfer.mjs";
import { SESSION_ID_ENV as TRACKED_JOBS_SESSION_ID_ENV } from "../plugins/copilot/scripts/lib/tracked-jobs.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-home-"));
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
}

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

function transcript(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-tx-")), "session.jsonl");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// M1 — the foreground `task` path (the only path every documented rescue
// flow actually reaches) must be wrapped in runTrackedJob, symmetric with
// handleReview, so a rescue run appears in /copilot:status and its spend
// reaches the session total.
// ---------------------------------------------------------------------------

test("M1: a foreground task run is tracked as a job, reaches 'completed', and carries its usage", async () => {
  const cwd = tempWorkspace();
  const capture = withCaptureScenario({ finalMessage: "fixed it", shutdown: { totalPremiumRequests: 3 } });

  const execution = await executeTrackedTask(cwd, { prompt: "fix the flaky test", ...capture });
  assert.equal(execution.exitStatus, 0);

  const snapshot = buildStatusSnapshot(cwd, { all: true });
  assert.equal(snapshot.jobs.length, 1, "the foreground run must leave exactly one job record behind");
  const [job] = snapshot.jobs;
  assert.equal(job.status, "completed");
  assert.equal(job.kind, "task");
  assert.ok(job.copilotSessionId, "the completed job must carry the Copilot session id it ran under");
  assert.ok(job.usage, "the job record must carry usage so /copilot:status totals aren't blind to rescue spend");
});

test("M1: a failing foreground task run is still tracked and marked failed, not silently dropped", async () => {
  const cwd = tempWorkspace();
  const capture = withCaptureScenario({});

  await assert.rejects(() => executeTrackedTask(cwd, { prompt: "", resumeLast: false, ...capture }));

  const snapshot = buildStatusSnapshot(cwd, { all: true });
  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.jobs[0].status, "failed");
});

// ---------------------------------------------------------------------------
// M2 — runCopilotTurn must emit copilotSessionId on both the create and the
// resume path, not just at completion, so a job record's copilotSessionId
// (and therefore /copilot:cancel's interruptCopilotTurn) is populated while
// the run is still in flight.
// ---------------------------------------------------------------------------

test("M2: creating a session emits copilotSessionId on the very first progress event", async () => {
  const events = [];
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "investigate",
    model: "claude-haiku-4.5",
    readOnly: true,
    onProgress: (event) => events.push(event),
    ...withCaptureScenario({})
  });

  const creating = events.find((event) => /Creating Copilot session/.test(event.message));
  assert.ok(creating, "expected a progress event for session creation");
  assert.equal(creating.copilotSessionId, result.sessionId);
});

test("M2: resuming a session emits copilotSessionId on the resume progress event too", async () => {
  const sessionId = "resumed-for-cancel-1";
  const events = [];
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "continue",
    model: "claude-haiku-4.5",
    readOnly: true,
    sessionId,
    onProgress: (event) => events.push(event),
    ...withCaptureScenario({ sessions: [{ sessionId }] })
  });

  const resuming = events.find((event) => /Resuming session/.test(event.message));
  assert.ok(resuming, "expected a progress event for session resume");
  assert.equal(resuming.copilotSessionId, sessionId);
  assert.equal(result.sessionId, sessionId);
});

// ---------------------------------------------------------------------------
// M3 — resuming a session must forward the resolved model and reasoning
// effort to session.resume, not just session.create, so a job whose model
// was overridden with --model doesn't bill under the resumed session's
// original model while printing the requested model's multiplier.
// ---------------------------------------------------------------------------

test("M3: resuming a session forwards the requested model and effort to session.resume", async () => {
  const sessionId = "resumed-with-model-1";
  const capture = withCaptureScenario({ sessions: [{ sessionId }] });

  await runCopilotTurn(process.cwd(), {
    prompt: "continue",
    model: "claude-haiku-4.5",
    effort: "low",
    readOnly: true,
    sessionId,
    ...capture
  });

  const resumed = readCapturedCalls(capture.capturePath).find((call) => call.method === "session.resume");
  assert.ok(resumed, "expected a session.resume call to be captured");
  assert.equal(resumed.params.model, "claude-haiku-4.5");
  assert.equal(resumed.params.reasoningEffort, "low");
});

test("M3: resuming without an effort omits reasoningEffort rather than sending an empty value", async () => {
  const sessionId = "resumed-with-model-2";
  const capture = withCaptureScenario({ sessions: [{ sessionId }] });

  await runCopilotTurn(process.cwd(), {
    prompt: "continue",
    model: "claude-sonnet-4.6",
    readOnly: true,
    sessionId,
    ...capture
  });

  const resumed = readCapturedCalls(capture.capturePath).find((call) => call.method === "session.resume");
  assert.equal(resumed.params.model, "claude-sonnet-4.6");
  assert.equal("reasoningEffort" in resumed.params, false);
});

// ---------------------------------------------------------------------------
// M4 — a read-only turn must allow a permission request whose command
// matches the read-only allowlist (git status|diff|log|show|ls-files, ls,
// cat, rg, grep, find, head, tail, wc) and deny everything else, including
// when the command can't be confidently identified at all.
// ---------------------------------------------------------------------------

test("M4: a read-only turn approves an allowlisted git diff command from a self-collect permission request", async () => {
  const capture = withCaptureScenario({
    serverRequest: { method: "session.permissions.confirm", params: { command: "git diff --stat HEAD~3" } }
  });
  await runCopilotTurn(process.cwd(), { prompt: "investigate", model: "claude-haiku-4.5", readOnly: true, ...capture });

  const reply = readCapturedCalls(capture.capturePath).find((call) => call.method === "__serverRequestReply");
  assert.ok(reply);
  assert.equal(reply.params.result.approved, true, "git diff must be allowed under the read-only allowlist");
});

test("M4: a read-only turn approves other allowlisted inspection commands (git status, ls, cat, rg)", async () => {
  for (const command of ["git status --short", "git ls-files", "ls -la", "cat package.json", "rg TODO", "grep -n foo", "find . -name '*.mjs'", "head -n 20 file.txt", "tail file.txt", "wc -l file.txt", "git log --oneline -5", "git show HEAD"]) {
    const capture = withCaptureScenario({
      serverRequest: { method: "session.permissions.confirm", params: { command } }
    });
    await runCopilotTurn(process.cwd(), { prompt: "investigate", model: "claude-haiku-4.5", readOnly: true, ...capture });
    const reply = readCapturedCalls(capture.capturePath).find((call) => call.method === "__serverRequestReply");
    assert.equal(reply.params.result.approved, true, `expected "${command}" to be allowed`);
  }
});

test("M4: a read-only turn still denies a non-allowlisted command (e.g. rm)", async () => {
  const capture = withCaptureScenario({
    serverRequest: { method: "session.permissions.confirm", params: { command: "rm -rf /tmp/whatever" } }
  });
  await runCopilotTurn(process.cwd(), { prompt: "investigate", model: "claude-haiku-4.5", readOnly: true, ...capture });

  const reply = readCapturedCalls(capture.capturePath).find((call) => call.method === "__serverRequestReply");
  assert.equal(reply.params.result.approved, false);
});

test("M4: a command chained onto an allowlisted prefix is denied, not allowed (no smuggling a write past 'git status')", async () => {
  const capture = withCaptureScenario({
    serverRequest: { method: "session.permissions.confirm", params: { command: "git status; rm -rf ." } }
  });
  await runCopilotTurn(process.cwd(), { prompt: "investigate", model: "claude-haiku-4.5", readOnly: true, ...capture });

  const reply = readCapturedCalls(capture.capturePath).find((call) => call.method === "__serverRequestReply");
  assert.equal(reply.params.result.approved, false);
});

test("M4: an unrecognised permission-request params shape still degrades to deny (no regression risk)", async () => {
  const capture = withCaptureScenario({
    serverRequest: { method: "session.permissions.confirm", params: { toolName: "something-unfamiliar" } }
  });
  await runCopilotTurn(process.cwd(), { prompt: "investigate", model: "claude-haiku-4.5", readOnly: true, ...capture });

  const reply = readCapturedCalls(capture.capturePath).find((call) => call.method === "__serverRequestReply");
  assert.equal(reply.params.result.approved, false);
});

// ---------------------------------------------------------------------------
// Also fix — --cost-warn-threshold must reject garbage instead of silently
// disabling the money guard.
// ---------------------------------------------------------------------------

test("also-fix: an unparseable --cost-warn-threshold is rejected with a clear error, not silently disabled", async () => {
  const cwd = tempWorkspace();
  await assert.rejects(
    () => buildSetupReport(cwd, { binary: FIXTURE, "cost-warn-threshold": "abc" }),
    /Invalid --cost-warn-threshold/
  );
});

test("also-fix: a negative --cost-warn-threshold is rejected too", async () => {
  const cwd = tempWorkspace();
  await assert.rejects(
    () => buildSetupReport(cwd, { binary: FIXTURE, "cost-warn-threshold": "-1" }),
    /Invalid --cost-warn-threshold/
  );
});

test("also-fix: a valid --cost-warn-threshold (including 0, to disable) is still accepted", async () => {
  const cwd = tempWorkspace();
  const report = await buildSetupReport(cwd, { binary: FIXTURE, "cost-warn-threshold": "0" });
  assert.equal(report.costWarnThreshold, 0);
});

// ---------------------------------------------------------------------------
// Also fix — transfer redaction must cover goal/decisions/openThreads, not
// just recorded commands, since a pasted credential shows up in a chat
// message far more often than in a Bash tool call.
// ---------------------------------------------------------------------------

test("also-fix: a credential pasted in the user's goal message is redacted from the digest", () => {
  const file = transcript([
    { type: "user", message: { role: "user", content: "Use this: GITHUB_TOKEN=ghp_realsecretvalue123 to deploy" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Ack." }] } }
  ]);
  const digest = buildTranscriptDigest(file);
  assert.doesNotMatch(digest.goal, /ghp_realsecretvalue123/);
  assert.doesNotMatch(digest.markdown, /ghp_realsecretvalue123/);
});

test("also-fix: a credential in an assistant decision message is redacted", () => {
  const file = transcript([
    { type: "user", message: { role: "user", content: "continue" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: 'I set Authorization: Bearer sk-live-realvalue and moved on.' }]
      }
    }
  ]);
  const digest = buildTranscriptDigest(file);
  assert.ok(digest.decisions.some((line) => line.includes("<redacted>")));
  assert.ok(digest.decisions.every((line) => !line.includes("sk-live-realvalue")));
  assert.doesNotMatch(digest.markdown, /sk-live-realvalue/);
});

test("also-fix: a credential in the most recent instruction (openThreads) is redacted", () => {
  const file = transcript([
    { type: "user", message: { role: "user", content: "start" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "user", message: { role: "user", content: "AWS_SECRET_ACCESS_KEY=realkeyvalue please retry" } }
  ]);
  const digest = buildTranscriptDigest(file);
  assert.ok(digest.openThreads.every((line) => !line.includes("realkeyvalue")));
  assert.doesNotMatch(digest.markdown, /realkeyvalue/);
});

// ---------------------------------------------------------------------------
// Also fix — SESSION_ID_ENV must be declared once (in tracked-jobs.mjs) and
// imported everywhere else, exactly as TRANSCRIPT_PATH_ENV already is.
// ---------------------------------------------------------------------------

test("also-fix: session-lifecycle-hook.mjs imports SESSION_ID_ENV rather than redeclaring it", () => {
  assert.ok(TRACKED_JOBS_SESSION_ID_ENV, "the canonical constant must exist in tracked-jobs.mjs");
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "plugins/copilot/scripts/session-lifecycle-hook.mjs"),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /export const SESSION_ID_ENV\s*=/,
    "session-lifecycle-hook.mjs must import SESSION_ID_ENV, not redeclare it"
  );
  assert.match(source, /import\s*\{\s*SESSION_ID_ENV\s*\}\s*from\s*"\.\/lib\/tracked-jobs\.mjs"/);
});

// ---------------------------------------------------------------------------
// Also fix (doc-level) — review/adversarial-review/rescue must forward a
// user-supplied --model to cost-check, and setup.md must handle a bare
// --model itself (never pass it through to the script) and show its own
// rendered report instead of only ever requesting --json.
// ---------------------------------------------------------------------------

test("also-fix (doc): review/adversarial-review/rescue tell Claude to forward --model to cost-check", () => {
  for (const file of ["review.md", "adversarial-review.md", "rescue.md"]) {
    const source = fs.readFileSync(path.join(REPO_ROOT, "plugins/copilot/commands", file), "utf8");
    assert.match(
      source,
      /forward the same `--model <id>` to `cost-check`/,
      `${file} must instruct forwarding --model to cost-check`
    );
  }
});

test("also-fix (doc): setup.md handles a bare --model itself instead of passing it to the script", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "plugins/copilot/commands/setup.md"), "utf8");
  assert.match(
    source,
    /bare `--model` with no id after it/,
    "setup.md must detect a valueless --model before invoking the script"
  );
  assert.match(
    source,
    /rejects a valueless `--model` outright/,
    "setup.md must explain why the bare --model can't be passed through"
  );
});

test("also-fix (doc): setup.md shows the rendered (non-JSON) report as the final output", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "plugins/copilot/commands/setup.md"), "utf8");
  assert.match(
    source,
    /copilot-companion\.mjs" setup \$ARGUMENTS\s*\n```/,
    "setup.md must run the final, user-facing invocation without --json"
  );
});
