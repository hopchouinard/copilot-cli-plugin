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
  const result = await runCopilotTurn(process.cwd(), {
    prompt: "go",
    model: "claude-haiku-4.5",
    readOnly: true,
    ...withScenario({})
  });
  assert.equal(result.mode, "plan");
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
