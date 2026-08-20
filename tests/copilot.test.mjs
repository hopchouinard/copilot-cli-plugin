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
  const capture = withCaptureScenario({});
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
