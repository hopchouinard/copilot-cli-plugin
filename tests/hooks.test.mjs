import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseStopReviewOutput } from "../plugins/copilot/scripts/stop-review-gate-hook.mjs";
import { resolveStateDir } from "../plugins/copilot/scripts/lib/state.mjs";
import { run, makeTempDir, initGitRepo } from "./helpers.mjs";

const SESSION_HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "copilot",
  "scripts",
  "session-lifecycle-hook.mjs"
);

// Isolate CLAUDE_PLUGIN_DATA and HOME the same way tests/task.test.mjs and
// tests/setup.test.mjs do, so a real ~/.copilot/settings.json or a leftover
// state dir on the machine running these tests can't leak in.
function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-home-"));
  const repo = makeTempDir("copilot-ws-");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return;
      }
      throw error;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("an ALLOW first line permits the stop", () => {
  assert.deepEqual(parseStopReviewOutput("ALLOW: nothing to review"), { ok: true, reason: null });
});

test("a BLOCK first line blocks and carries the reason", () => {
  const result = parseStopReviewOutput("BLOCK: the retry loop never terminates\nmore detail");
  assert.equal(result.ok, false);
  assert.match(result.reason, /retry loop never terminates/);
});

test("empty output blocks rather than silently allowing", () => {
  assert.equal(parseStopReviewOutput("").ok, false);
});

test("an unrecognised first line blocks rather than guessing", () => {
  const result = parseStopReviewOutput("Sure! Here is my review of the changes.");
  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected answer/i);
});

test("session start does nothing when CLAUDE_ENV_FILE is not set", () => {
  const repo = tempWorkspace();
  const env = { ...process.env };
  delete env.CLAUDE_ENV_FILE;

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-current", cwd: repo })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("session start escapes exported values so sourcing CLAUDE_ENV_FILE round-trips a value with a single quote", () => {
  const repo = tempWorkspace();
  const envDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-envfile-"));
  const envFile = path.join(envDir, "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const trickyTranscriptPath = "/tmp/transcripts/o'brien's session.jsonl";

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: { ...process.env, CLAUDE_ENV_FILE: envFile },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      cwd: repo,
      transcript_path: trickyTranscriptPath
    })
  });

  assert.equal(result.status, 0, result.stderr);

  const sourced = run("bash", ["-c", `source "${envFile}" && printf '%s' "$CLAUDE_TRANSCRIPT_PATH"`]);
  assert.equal(sourced.status, 0, sourced.stderr);
  assert.equal(sourced.stdout, trickyTranscriptPath);
});

test("session end reaps only the running job for the ending session and leaves the completed job intact", async () => {
  const repo = tempWorkspace();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  const completedLog = path.join(jobsDir, "task-completed.log");
  const completedJobFile = path.join(jobsDir, "task-completed.json");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "task-completed" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-running",
            status: "running",
            sessionId: "sess-current",
            // A different copilotSessionId on purpose: reaping must key off
            // sessionId, never copilotSessionId.
            copilotSessionId: "copilot-rpc-session-irrelevant-here",
            pid: sleeper.pid,
            logFile: runningLog,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          },
          {
            id: "task-completed",
            status: "completed",
            sessionId: "sess-current",
            copilotSessionId: "copilot-rpc-session-also-irrelevant",
            logFile: completedLog,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: { ...process.env, COPILOT_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-current", cwd: repo })
  });
  assert.equal(result.status, 0, result.stderr);

  await waitForProcessExit(sleeper.pid);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs.map((job) => job.id), ["task-completed"]);
  assert.equal(fs.existsSync(completedLog), true, "the completed job's log file must survive");
  assert.equal(fs.existsSync(completedJobFile), true, "the completed job's job file must survive");
  assert.equal(fs.existsSync(runningLog), false, "the reaped job's log file must be pruned");
});

test("session end reaps by job.sessionId, not job.copilotSessionId", () => {
  const repo = tempWorkspace();
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const log = path.join(jobsDir, "task-mismatched.log");
  fs.writeFileSync(log, "running\n", "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-mismatched",
            status: "running",
            // sessionId does NOT match the ending session...
            sessionId: "sess-a-different-claude-session",
            // ...but copilotSessionId happens to equal it. A hook that
            // filtered on the wrong field would wrongly reap this job.
            copilotSessionId: "sess-current",
            pid: sleeper.pid,
            logFile: log,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: { ...process.env, COPILOT_COMPANION_SESSION_ID: "sess-current" },
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "sess-current", cwd: repo })
  });
  assert.equal(result.status, 0, result.stderr);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs.map((job) => job.id), ["task-mismatched"]);
  assert.equal(fs.existsSync(log), true);

  let alive = true;
  try {
    process.kill(sleeper.pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, true, "a job whose sessionId does not match must not be reaped or killed");

  process.kill(sleeper.pid, "SIGTERM");
});
