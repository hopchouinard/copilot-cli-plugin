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
  "a duplicate assistant.turn_end does not hang the run",
  { timeout: 5000 },
  async () => {
    // assistant.turn_end is progress-logging only (see the permission-fix
    // wave's change to applyEvent — session.idle is now the authoritative
    // completion signal, since a self-collect review's tool-only rounds
    // each raise their own turn_end without being the turn's actual end).
    // No idle event is emitted by this scenario, so completion here comes
    // from the pre-existing, unchanged scheduleInferredCompletion fallback
    // timer armed by assistant.message; a duplicate turn_end must not
    // interfere with that or leave the run's promise permanently pending.
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

test(
  "a duplicate session.idle resolves the run instead of hanging",
  { timeout: 5000 },
  async () => {
    // capture.completed guards against a second resolve(); this is the
    // regression test for that guard against the new authoritative
    // completion signal (session.idle replaced assistant.turn_end — see
    // above). A duplicate session.idle must not leave the run's promise
    // permanently pending or throw from a second capture.resolve() call.
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "go",
      model: "claude-haiku-4.5",
      readOnly: true,
      ...withScenario({
        events: [
          { type: "assistant.turn_start", data: {} },
          { type: "assistant.message", data: { content: "done" } },
          { type: "assistant.turn_end", data: { status: "completed" } },
          { type: "session.idle", data: {} },
          { type: "session.idle", data: {} }
        ]
      })
    });
    assert.equal(result.finalMessage, "done");
  }
);

// Regression coverage for the exact bug an instrumented live run against
// Copilot CLI 1.0.80 found while verifying Fix 1 (the permission-event fix):
// a self-collect review (git.mjs's self-collect path, >2 files) sent
// Copilot through a tool-only first round (fetching the diff with `git
// diff`, no assistant.message at all) whose assistant.turn_end used to be
// treated as the whole turn's completion — truncating the result to an
// empty message before the model ever got to a second round to actually
// write the review. This asserts a second round's message, arriving after
// a first, message-less round's turn_end, is what the turn actually
// returns.
test(
  "a tool-only first round does not truncate a self-collect turn before its real answer arrives",
  { timeout: 5000 },
  async () => {
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "review this",
      model: "claude-haiku-4.5",
      readOnly: true,
      ...withScenario({
        events: [
          { type: "assistant.turn_start", data: {} },
          { type: "command.execute", data: { command: "git diff" } },
          { type: "command.completed", data: { command: "git diff", exitCode: 0 } },
          { type: "assistant.turn_end", data: { status: "completed" } },
          { type: "assistant.turn_start", data: {} },
          { type: "assistant.message", data: { content: "Found an off-by-one at mod1.js:3." } },
          { type: "assistant.turn_end", data: { status: "completed" } },
          { type: "session.idle", data: {} }
        ]
      })
    });
    assert.equal(result.finalMessage, "Found an off-by-one at mod1.js:3.");
  }
);

// Regression coverage for a Critical found on re-review (C1): before this
// fix, the only two things that could ever settle `capture.promise` were
// session.idle and scheduleInferredCompletion's message-gated 250ms timer.
// A round that produces no assistant.message — self-collect's tool-only
// round 1, exactly the scenario above — followed by an error, a dropped
// connection, or the copilot process dying, hung forever with no bound
// anywhere in the call chain. These three tests cover each of those
// termination paths.
test(
  "a mid-turn error event resolves the run instead of hanging when no message was ever seen",
  { timeout: 5000 },
  async () => {
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "review this",
      model: "claude-haiku-4.5",
      readOnly: true,
      ...withScenario({
        events: [
          { type: "assistant.turn_start", data: {} },
          { type: "command.execute", data: { command: "git diff" } },
          { type: "error", data: { message: "model call failed" } }
          // Deliberately no turn_end, no session.idle, and no
          // assistant.message — the exact combination that used to hang.
        ]
      })
    });
    assert.equal(result.status, 1, "an error must surface as a failed status, not an empty success");
    assert.equal(result.error?.message, "model call failed");
  }
);

test(
  "the copilot process dying mid-turn resolves the run instead of hanging when no message was ever seen",
  { timeout: 5000 },
  async () => {
    const capture = withCaptureScenario({
      crashAfterSend: true,
      events: [
        { type: "assistant.turn_start", data: {} },
        { type: "command.execute", data: { command: "git diff" } }
        // No message, no turn_end, no idle — then the fixture process
        // itself exits (see fake-copilot-fixture.mjs's crashAfterSend),
        // simulating a crashed/killed real Copilot CLI.
      ]
    });
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "review this",
      model: "claude-haiku-4.5",
      readOnly: true,
      ...capture
    });
    assert.equal(result.status, 1, "a dead connection must surface as a failed status, not an empty success");
    assert.ok(result.error?.message, "expected an error describing the dropped connection");
  }
);

test(
  "a turn that goes completely silent is bounded by the absolute timeout backstop",
  { timeout: 5000 },
  async () => {
    const capture = withCaptureScenario({
      neverComplete: true,
      events: [{ type: "assistant.turn_start", data: {} }]
      // The fixture process stays alive and never sends anything else —
      // no message, no turn_end, no idle, no error, no exit. Only the
      // absolute-ceiling timer (forced tiny here via absoluteTimeoutMs) can
      // still bound this.
    });
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "review this",
      model: "claude-haiku-4.5",
      readOnly: true,
      absoluteTimeoutMs: 100,
      ...capture
    });
    assert.equal(result.status, 1, "a silent turn must fail loudly once the absolute ceiling is hit, not hang");
    assert.ok(/absolute ceiling/.test(result.error?.message ?? ""), "expected the timeout's own error message");
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

// Regression coverage for the permission-fix wave: an instrumented live run
// against Copilot CLI 1.0.80 found the real permission mechanism is a
// `session.event` notification of type `permission.requested` (not a
// server→client request — the earlier tests above cover that vestigial
// path), and that self-collect reviews (>2 files, git.mjs's
// DEFAULT_INLINE_DIFF_MAX_FILES) hung forever because nothing ever answered
// it via `session.permissions.handlePendingPermissionRequest`. These assert
// the turn completes (a hang fails on the timeout) and that the decision
// sent matches the read-only allowlist / write-capable posture.
test(
  "a permission.requested event for an allowlisted read-only command is answered with approve-once",
  { timeout: 5000 },
  async () => {
    const capture = withCaptureScenario({
      permissionEvent: {
        requestId: "perm-1",
        permissionRequest: { kind: "shell", fullCommandText: "git diff --stat", intention: "inspect the diff" }
      }
    });
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "review this",
      model: "claude-haiku-4.5",
      readOnly: true,
      ...capture
    });
    assert.equal(result.status, 0, "the turn must complete rather than hang");

    const reply = readCapturedCalls(capture.capturePath).find(
      (call) => call.method === "session.permissions.handlePendingPermissionRequest"
    );
    assert.ok(reply, "expected the client to answer the permission.requested event");
    assert.equal(reply.params.requestId, "perm-1");
    assert.deepEqual(reply.params.result, { kind: "approve-once" });
  }
);

test(
  "a permission.requested event for a non-allowlisted command is answered with reject under read-only posture",
  { timeout: 5000 },
  async () => {
    const capture = withCaptureScenario({
      permissionEvent: {
        requestId: "perm-2",
        permissionRequest: { kind: "shell", fullCommandText: "rm -rf /tmp/whatever", intention: "delete things" }
      }
    });
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "review this",
      model: "claude-haiku-4.5",
      readOnly: true,
      ...capture
    });
    assert.equal(result.status, 0, "the turn must complete rather than hang even on a denial");

    const reply = readCapturedCalls(capture.capturePath).find(
      (call) => call.method === "session.permissions.handlePendingPermissionRequest"
    );
    assert.ok(reply);
    assert.equal(reply.params.result.kind, "reject");
  }
);

test(
  "a permission.requested event with a chained/piped allowlisted-looking command is still denied under read-only posture",
  { timeout: 5000 },
  async () => {
    const capture = withCaptureScenario({
      permissionEvent: {
        requestId: "perm-3",
        permissionRequest: {
          kind: "shell",
          fullCommandText: "git status; rm -rf .",
          intention: "get status then clean up"
        }
      }
    });
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "review this",
      model: "claude-haiku-4.5",
      readOnly: true,
      ...capture
    });
    assert.equal(result.status, 0);

    const reply = readCapturedCalls(capture.capturePath).find(
      (call) => call.method === "session.permissions.handlePendingPermissionRequest"
    );
    assert.ok(reply);
    assert.equal(reply.params.result.kind, "reject", "a chained command must not ride through on its allowlisted prefix");
  }
);

// Regression coverage for a Critical found on re-review: the allowlist regex
// used `.test()` anchored only at `^`, never at `$`, and `\s` (which the
// allowlist used for "verb followed by anything") matches a literal
// newline. "git status\nrm -rf /" was therefore approved outright in
// read-only mode — a live-verified bypass. The fix anchors the allowlist at
// both ends and denies every C0 control character (not just the
// shell-special ones) up front. These cover the reported bypass plus
// neighbouring shapes that rely on the same "something after a recognised
// prefix goes unexamined" class of mistake.
for (const [label, fullCommandText] of [
  ["a bare LF between two commands", "git status\nrm -rf /"],
  ["a CRLF between two commands", "git status\r\nrm -rf /"],
  ["input redirection", "git status < /etc/passwd"],
  ["a trailing backslash", "git status \\"],
  ["a command name with a bogus suffix", "git statusx"]
]) {
  test(
    `a permission.requested event for ${label} is denied under read-only posture`,
    { timeout: 5000 },
    async () => {
      const capture = withCaptureScenario({
        permissionEvent: {
          requestId: `perm-bypass-${label}`,
          permissionRequest: { kind: "shell", fullCommandText, intention: "inspect" }
        }
      });
      const result = await runCopilotTurn(process.cwd(), {
        prompt: "review this",
        model: "claude-haiku-4.5",
        readOnly: true,
        ...capture
      });
      assert.equal(result.status, 0, "the turn must complete rather than hang even on a denial");

      const reply = readCapturedCalls(capture.capturePath).find(
        (call) => call.method === "session.permissions.handlePendingPermissionRequest"
      );
      assert.ok(reply);
      assert.equal(reply.params.result.kind, "reject", `${JSON.stringify(fullCommandText)} must not be approved`);
    }
  );
}

test(
  "a permission.requested event for a non-shell kind is denied under read-only posture",
  { timeout: 5000 },
  async () => {
    const capture = withCaptureScenario({
      permissionEvent: {
        requestId: "perm-4",
        permissionRequest: { kind: "write", fileName: "src/a.js", intention: "patch a bug", diff: "" }
      }
    });
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "review this",
      model: "claude-haiku-4.5",
      readOnly: true,
      ...capture
    });
    assert.equal(result.status, 0);

    const reply = readCapturedCalls(capture.capturePath).find(
      (call) => call.method === "session.permissions.handlePendingPermissionRequest"
    );
    assert.ok(reply);
    assert.equal(reply.params.result.kind, "reject", "a non-shell permission kind has no allowlist and must be denied");
  }
);

test(
  "a permission.requested event during a write-capable turn is approved unconditionally",
  { timeout: 5000 },
  async () => {
    const capture = withCaptureScenario({
      permissionEvent: {
        requestId: "perm-5",
        permissionRequest: { kind: "shell", fullCommandText: "npm install left-pad", intention: "add a dependency" }
      }
    });
    const result = await runCopilotTurn(process.cwd(), {
      prompt: "fix it",
      model: "claude-haiku-4.5",
      readOnly: false,
      ...capture
    });
    assert.equal(result.status, 0);

    const reply = readCapturedCalls(capture.capturePath).find(
      (call) => call.method === "session.permissions.handlePendingPermissionRequest"
    );
    assert.ok(reply);
    assert.deepEqual(reply.params.result, { kind: "approve-once" });
  }
);

test("read-only turns exclude only the real write tools (create, edit), not bash", async () => {
  const capture = withCaptureScenario({});
  await runCopilotTurn(process.cwd(), {
    prompt: "go",
    model: "claude-haiku-4.5",
    readOnly: true,
    ...capture
  });

  const created = readCapturedCalls(capture.capturePath).find((call) => call.method === "session.create");
  assert.ok(created);
  assert.deepEqual(created.params.excludedTools, ["create", "edit"]);
  assert.ok(!created.params.excludedTools.includes("bash"), "self-collect reviews need bash and must not exclude it");
});

test("session.info events with infoType 'configuration' are surfaced into the progress log", async () => {
  const messages = [];
  await runCopilotTurn(process.cwd(), {
    prompt: "go",
    model: "claude-haiku-4.5",
    readOnly: true,
    onProgress: (event) => messages.push(event.message),
    ...withScenario({
      events: [
        { type: "assistant.turn_start", data: {} },
        { type: "session.info", data: { infoType: "configuration", message: 'Unknown tool name in the tool excludedlist: "write"' } },
        { type: "assistant.message", data: { content: "done" } },
        { type: "assistant.turn_end", data: { status: "completed" } }
      ]
    })
  });
  assert.ok(
    messages.some((message) => message.includes('Unknown tool name in the tool excludedlist: "write"')),
    "expected the configuration session.info message to reach progress reporting"
  );
});

test("session.info events with a non-configuration infoType are not surfaced", async () => {
  const messages = [];
  await runCopilotTurn(process.cwd(), {
    prompt: "go",
    model: "claude-haiku-4.5",
    readOnly: true,
    onProgress: (event) => messages.push(event.message),
    ...withScenario({
      events: [
        { type: "assistant.turn_start", data: {} },
        { type: "session.info", data: { infoType: "timing", message: "some timing detail" } },
        { type: "assistant.message", data: { content: "done" } },
        { type: "assistant.turn_end", data: { status: "completed" } }
      ]
    })
  });
  assert.ok(!messages.some((message) => message.includes("some timing detail")));
});

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
