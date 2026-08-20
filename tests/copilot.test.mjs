import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCopilotTurn, parseStructuredOutput, getCopilotAuthStatus } from "../plugins/copilot/scripts/lib/copilot.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

function scenarioFile(scenario) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scn-")), "scenario.json");
  fs.writeFileSync(file, JSON.stringify(scenario), "utf8");
  return file;
}

function withScenario(scenario) {
  return { binary: FIXTURE, env: { ...process.env, FAKE_COPILOT_SCRIPT: scenarioFile(scenario) } };
}

// Like withScenario, but also points the fixture at a capture file so a test
// can read back exactly which RPC calls (and params) the fixture received.
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

test("auth status reports the fixture login", async () => {
  const status = await getCopilotAuthStatus(process.cwd(), withScenario({}));
  assert.equal(status.loggedIn, true);
  assert.equal(status.login, "fixture");
});

test("a completed turn returns the final assistant message and exit status 0", async () => {
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "review this",
    model: "claude-haiku-4.5",
    readOnly: true,
    ...withScenario({ finalMessage: "no findings" })
  });
  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "no findings");
  assert.ok(result.sessionId);
});

test("progress events map onto phases in order", async () => {
  const phases = [];
  await runCopilotTurn(process.cwd(), {
    prompt: "go",
    model: "claude-haiku-4.5",
    readOnly: true,
    onProgress: (event) => {
      const phase = typeof event === "object" ? event.phase : null;
      if (phase) phases.push(phase);
    },
    ...withScenario({
      events: [
        { type: "session.start", data: {} },
        { type: "assistant.turn_start", data: {} },
        { type: "command.execute", data: { command: "npm test" } },
        { type: "assistant.message", data: { content: "done" } },
        { type: "assistant.turn_end", data: { status: "completed" } }
      ]
    })
  });
  assert.ok(phases.includes("starting"));
  assert.ok(phases.includes("verifying"), "npm test should be classified as verification");
  assert.ok(phases.includes("finalizing"));
});

test("a turn that ends without turn_end still resolves via the inferred timer", async () => {
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "go",
    model: "claude-haiku-4.5",
    readOnly: true,
    ...withScenario({
      events: [
        { type: "assistant.turn_start", data: {} },
        { type: "assistant.message", data: { content: "partial" } }
      ]
    })
  });
  assert.equal(result.finalMessage, "partial");
});

test("read-only turns exclude write tools and set plan mode", async () => {
  const capture = withCaptureScenario({});
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "go",
    model: "claude-haiku-4.5",
    readOnly: true,
    ...capture
  });
  assert.equal(result.mode, "plan");

  const created = readCapturedCalls(capture.capturePath).find((call) => call.method === "session.create");
  assert.ok(created, "expected a session.create call to be captured");
  assert.equal(created.params.requestPermission, true);
  assert.ok(
    Array.isArray(created.params.excludedTools) && created.params.excludedTools.length > 0,
    "session.create should transmit a non-empty excludedTools list for a read-only turn"
  );
});

test("read-only turns on the resume path also transmit tool exclusions and permission requests", async () => {
  // session.resume now requires a session the fixture actually knows about
  // (matching the real Copilot CLI, which rejects an unknown id) — plant it
  // via `sessions`, the same field that seeds `sessions.list`.
  const capture = withCaptureScenario({ sessions: [{ sessionId: "resumed-session-1" }] });
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "continue",
    model: "claude-haiku-4.5",
    readOnly: true,
    sessionId: "resumed-session-1",
    ...capture
  });
  assert.equal(result.mode, "plan");
  assert.equal(result.sessionId, "resumed-session-1");

  const resumed = readCapturedCalls(capture.capturePath).find((call) => call.method === "session.resume");
  assert.ok(resumed, "expected a session.resume call to be captured");
  assert.equal(resumed.params.requestPermission, true);
  assert.ok(
    Array.isArray(resumed.params.excludedTools) && resumed.params.excludedTools.length > 0,
    "session.resume should transmit the same excludedTools restrictions as session.create for a read-only turn"
  );
});

test(
  "a duplicate assistant.turn_end resolves the run instead of hanging",
  { timeout: 5000 },
  async () => {
    // capture.completed guards against a second resolve(); this is a
    // regression test for that guard. A duplicate turn_end must not
    // leave the run's promise permanently pending.
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "go",
      model: "claude-haiku-4.5",
      readOnly: true,
      ...withScenario({
        events: [
          { type: "assistant.turn_start", data: {} },
          { type: "assistant.message", data: { content: "done" } },
          { type: "assistant.turn_end", data: { status: "completed" } },
          { type: "assistant.turn_end", data: { status: "completed" } }
        ]
      })
    });
    assert.equal(result.finalMessage, "done");
  }
);

// Regression coverage for the read-only permission deadlock found in Task
// 16 acceptance testing: the real Copilot CLI sends a server→client request
// when a read-only session (`requestPermission: true`) wants to run a tool,
// and the client used to silently drop it as a notification, leaving the
// server's turn blocked forever. These assert the turn still completes
// (a hang would fail these tests on their timeout) and that the reply's
// decision matches the turn's read-only posture.
test(
  "a server permission request during a read-only turn is answered with a denial, not silence",
  { timeout: 5000 },
  async () => {
    const capture = withCaptureScenario({ serverRequest: { method: "session.permissions.confirm" } });
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "investigate",
      model: "claude-haiku-4.5",
      readOnly: true,
      ...capture
    });
    assert.equal(result.status, 0, "the turn must complete rather than hang");

    const reply = readCapturedCalls(capture.capturePath).find((call) => call.method === "__serverRequestReply");
    assert.ok(reply, "expected the client to reply to the server request");
    assert.ok(!reply.params.error, "a recognised permission-like method must not be refused");
    assert.equal(reply.params.result.approved, false, "a read-only turn must deny the permission request");
  }
);

test(
  "a server permission request during a write-capable turn is answered with an allow",
  { timeout: 5000 },
  async () => {
    const capture = withCaptureScenario({ serverRequest: { method: "session.permissions.confirm" } });
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "fix it",
      model: "claude-haiku-4.5",
      readOnly: false,
      ...capture
    });
    assert.equal(result.status, 0);

    const reply = readCapturedCalls(capture.capturePath).find((call) => call.method === "__serverRequestReply");
    assert.ok(reply);
    assert.equal(reply.params.result.approved, true, "a write-capable turn must allow the permission request");
  }
);

test(
  "a server request for an unrecognised method still gets an explicit refusal, not silence",
  { timeout: 5000 },
  async () => {
    const capture = withCaptureScenario({ serverRequest: { method: "some.other.thing" } });
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "investigate",
      model: "claude-haiku-4.5",
      readOnly: true,
      ...capture
    });
    assert.equal(result.status, 0, "an unrecognised server request must not hang the turn either");

    const reply = readCapturedCalls(capture.capturePath).find((call) => call.method === "__serverRequestReply");
    assert.ok(reply, "expected a reply even for an unrecognised method");
    assert.ok(reply.params.error, "an unrecognised method must be refused explicitly rather than guessed at");
  }
);

// Regression coverage for the inert premium-accounting finding: the real
// Copilot CLI never populated assistant.usage or session.shutdown, but does
// answer session.usage.getMetrics with real numbers. These assert
// runCopilotTurn prefers that RPC's numbers, and falls back cleanly when
// it's unavailable (an older CLI, or — as here — the fixture not
// implementing it).
test("runCopilotTurn prefers session.usage.getMetrics over assistant.usage when both are present", async () => {
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "review this",
    model: "claude-haiku-4.5",
    readOnly: true,
    ...withScenario({
      finalMessage: "no findings",
      premiumRequests: 1,
      metrics: { totalPremiumRequestCost: 3, totalNanoAiu: 7000 }
    })
  });
  assert.equal(result.usage.premiumRequests, 3);
  assert.equal(result.usage.aiu, 7000);
});

test("runCopilotTurn falls back to the event-based usage when session.usage.getMetrics is unsupported", async () => {
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "review this",
    model: "claude-haiku-4.5",
    readOnly: true,
    ...withScenario({ finalMessage: "no findings", premiumRequests: 2, metricsUnsupported: true })
  });
  assert.equal(result.usage.premiumRequests, 2);
});

test("runCopilotTurn prefers codeChanges.filesModified from the metrics call when it is a non-empty string array", async () => {
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "fix it",
    model: "claude-haiku-4.5",
    readOnly: false,
    ...withScenario({
      finalMessage: "done",
      metrics: {
        totalPremiumRequestCost: 1,
        totalNanoAiu: 100,
        codeChanges: { filesModified: ["src/a.js", "src/b.js"] }
      }
    })
  });
  assert.deepEqual(result.touchedFiles, ["src/a.js", "src/b.js"]);
});

test("parseStructuredOutput strips a fenced code block before parsing", () => {
  const parsed = parseStructuredOutput('```json\n{"verdict":"approve"}\n```');
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput reports a parse error without throwing", () => {
  const parsed = parseStructuredOutput("not json at all");
  assert.equal(parsed.parsed, null);
  assert.ok(parsed.parseError);
  assert.equal(parsed.rawOutput, "not json at all");
});
