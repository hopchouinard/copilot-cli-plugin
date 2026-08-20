// Regression coverage for the sixteen defects raised on PR #1 by the
// GitHub Copilot reviewer and the Codex reviewer. One test (or group) per
// finding, named after the behaviour that was wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isCatalogStale, normalizeCatalog, catalogHasModel } from "../plugins/copilot/scripts/lib/models.mjs";
import { isAllowedReadOnlyCommand, findLatestTaskSession } from "../plugins/copilot/scripts/lib/copilot.mjs";
import { renderReviewResult, describeReviewShape } from "../plugins/copilot/scripts/lib/render.mjs";
import { detectDefaultBranch, collectReviewContext, resolveReviewTarget } from "../plugins/copilot/scripts/lib/git.mjs";
import {
  listJobs,
  setConfig,
  resolveStateFile,
  resolveStateDir,
  withStateLock
} from "../plugins/copilot/scripts/lib/state.mjs";
import { buildCostCheck, buildSetupReport } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { run, makeTempDir, initGitRepo } from "./helpers.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(TESTS_DIR, "fake-copilot-fixture.mjs");
const STOP_HOOK = path.join(TESTS_DIR, "..", "plugins", "copilot", "scripts", "stop-review-gate-hook.mjs");

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-home-"));
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
}

function withScenario(scenario) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-scn-")), "scenario.json");
  fs.writeFileSync(file, JSON.stringify(scenario), "utf8");
  return { binary: FIXTURE, env: { ...process.env, FAKE_COPILOT_SCRIPT: file } };
}

function gitRepo() {
  const cwd = makeTempDir("copilot-repo-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  return cwd;
}

// ---------------------------------------------------------------------------
// Copilot reviewer: isCatalogStale treated an unparseable cachedAt as fresh.
// ---------------------------------------------------------------------------

test("a catalog whose cachedAt cannot be parsed is stale, not fresh", () => {
  for (const cachedAt of ["not-a-date", "", "2026-13-45T99:99:99Z"]) {
    assert.equal(isCatalogStale({ models: [], cachedAt }), true, `cachedAt=${JSON.stringify(cachedAt)}`);
  }
  assert.equal(isCatalogStale({ models: [], cachedAt: new Date().toISOString() }), false);
});

// ---------------------------------------------------------------------------
// Codex P1: the read-only allowlist validated only the executable name, so
// `find . -delete` and `find . -exec rm -rf {} +` were approved.
// ---------------------------------------------------------------------------

test("read-only mode denies mutating and executing arguments to inspection commands", () => {
  const denied = [
    "find . -delete",
    "find . -exec rm -rf {} +",
    "find . -execdir rm {} +",
    "find . -ok rm {} +",
    "find . -type f -fprint /tmp/out",
    "find . -type f -fprintf /tmp/out %p",
    "find . -fls /tmp/out",
    "git diff --output=/tmp/leak",
    "git diff --ext-diff",
    "rg --pre=/bin/sh needle",
    "rg -z needle",
    "tail -f server.log",
    "cat --secret-flag file"
  ];
  for (const command of denied) {
    assert.equal(isAllowedReadOnlyCommand(command), false, `should be denied: ${command}`);
  }
});

test("read-only mode still approves ordinary inspection commands", () => {
  const allowed = [
    "git status --short",
    "git diff --stat",
    "git diff -U3 main...HEAD",
    "git log --oneline -20",
    "git log -5",
    "git show --stat HEAD",
    "git ls-files --others --exclude-standard",
    "ls -la src/",
    "cat README.md",
    "rg -n TODO src/",
    "rg -C2 needle .",
    "grep -rn pattern .",
    "find . -name *.js -type f",
    "find . -maxdepth 2 -type d -prune",
    "head -n 50 file.txt",
    "tail -20 log.txt",
    "wc -l file.txt"
  ];
  for (const command of allowed) {
    assert.equal(isAllowedReadOnlyCommand(command), true, `should be allowed: ${command}`);
  }
});

test("shell chaining and control characters still deny regardless of the verb", () => {
  for (const command of ["git status; rm -rf /", "git status\nrm -rf /", "ls `whoami`", "cat x > /tmp/y"]) {
    assert.equal(isAllowedReadOnlyCommand(command), false, `should be denied: ${JSON.stringify(command)}`);
  }
});

// ---------------------------------------------------------------------------
// Codex P1: an untracked symlink was followed, embedding its target's
// contents in the prompt sent to Copilot.
// ---------------------------------------------------------------------------

test("an untracked symlink pointing outside the repository is named but never read", () => {
  const cwd = gitRepo();
  const outside = makeTempDir("copilot-secret-");
  const secretPath = path.join(outside, "id_rsa");
  fs.writeFileSync(secretPath, "PRIVATE-KEY-MATERIAL-DO-NOT-LEAK\n");
  fs.symlinkSync(secretPath, path.join(cwd, "secrets"));

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}));

  assert.match(context.content, /### secrets/);
  assert.match(context.content, /skipped: symlink pointing outside the repository/);
  assert.equal(context.content.includes("PRIVATE-KEY-MATERIAL-DO-NOT-LEAK"), false);
});

test("an untracked symlink pointing inside the repository is still read", () => {
  const cwd = gitRepo();
  fs.writeFileSync(path.join(cwd, "target.txt"), "in-repo-content\n");
  fs.symlinkSync(path.join(cwd, "target.txt"), path.join(cwd, "link.txt"));

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}));

  assert.match(context.content, /in-repo-content/);
});

// ---------------------------------------------------------------------------
// Codex P2: origin/HEAD was reported without its remote qualifier, producing
// a ref `git merge-base` cannot resolve in a feature-only checkout.
// ---------------------------------------------------------------------------

test("the detected default branch keeps its remote qualifier when no local branch exists", () => {
  const cwd = gitRepo();
  run("git", ["update-ref", "refs/remotes/origin/main", "main"], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd, shell: false });
  run("git", ["checkout", "-b", "feature/only"], { cwd });
  // Delete the local default branch: the remote-tracking ref is now the only
  // way to name it, exactly as in a single-branch clone.
  run("git", ["branch", "-D", "main"], { cwd, shell: false });

  const detected = detectDefaultBranch(cwd);

  assert.equal(detected, "origin/main");
  assert.equal(run("git", ["merge-base", "HEAD", detected], { cwd, shell: false }).status, 0);
});

test("the detected default branch drops the qualifier when the local branch does exist", () => {
  const cwd = gitRepo();
  run("git", ["update-ref", "refs/remotes/origin/main", "main"], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd, shell: false });
  run("git", ["checkout", "-b", "feature/only"], { cwd });

  assert.equal(detectDefaultBranch(cwd), "main");
});

// ---------------------------------------------------------------------------
// Codex P2: valid JSON of the wrong shape threw inside the renderer, after
// the premium request had already been paid for.
// ---------------------------------------------------------------------------

test("valid JSON that does not match the review schema falls back to raw output", () => {
  const options = { reviewLabel: "Copilot Review", targetLabel: "branch diff" };
  const wrongShapes = [
    { verdict: "ok", summary: "s", findings: { first: {} } },
    { verdict: "ok", summary: "s", next_steps: "do the thing" },
    { summary: "no verdict" },
    "just a string",
    [1, 2, 3]
  ];

  for (const parsed of wrongShapes) {
    const raw = JSON.stringify(parsed);
    const rendered = renderReviewResult({ parsed, parseError: null, rawOutput: raw }, options);
    assert.match(rendered, /did not match the review schema/, `shape: ${raw}`);
    assert.ok(rendered.includes(raw), `raw output must survive for shape: ${raw}`);
  }
});

test("a conforming review still renders its findings", () => {
  const parsed = {
    verdict: "changes_requested",
    summary: "one problem",
    findings: [
      {
        severity: "high",
        title: "Null deref",
        file: "a.js",
        line_start: 1,
        line_end: 2,
        confidence: "high",
        body: "b",
        recommendation: "r"
      }
    ],
    next_steps: ["fix it"]
  };
  assert.equal(describeReviewShape(parsed), null);
  const rendered = renderReviewResult({ parsed, parseError: null, rawOutput: "{}" }, {
    reviewLabel: "Copilot Review",
    targetLabel: "branch diff"
  });
  assert.match(rendered, /\[high\] Null deref/);
  assert.match(rendered, /Next steps/);
});

// ---------------------------------------------------------------------------
// Codex P1: a session with no recorded cwd matched every repository, so
// --resume could continue another workspace's task here.
// ---------------------------------------------------------------------------

test("a task session from another working directory is never resumed", async () => {
  const cwd = tempWorkspace();
  const elsewhere = makeTempDir("copilot-other-repo-");
  const found = await findLatestTaskSession(
    cwd,
    withScenario({
      sessions: [{ sessionId: "other-repo-session", name: "Copilot Companion Task: theirs", context: { cwd: elsewhere } }]
    })
  );
  assert.equal(found, null);
});

test("a task session with no recorded working directory is never resumed", async () => {
  const cwd = tempWorkspace();
  const found = await findLatestTaskSession(
    cwd,
    withScenario({
      sessions: [{ sessionId: "context-less-session", name: "Copilot Companion Task: unknown", context: null }]
    })
  );
  assert.equal(found, null);
});

// ---------------------------------------------------------------------------
// Codex P1: the cost guard priced runs off a stale or incomplete catalog, and
// an unknown multiplier silently bypassed the confirmation.
// ---------------------------------------------------------------------------

test("an unresolvable cost trips the guard instead of bypassing it", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "modelCatalog", normalizeCatalog({ models: [{ id: "known", billing: { multiplier: 1 } }] }));
  setConfig(cwd, "reviewModel", "a-model-not-in-the-catalog");

  // refreshCatalog:false keeps this hermetic — no Copilot binary is reachable
  // here, which is itself one of the ways the cost can end up unknown.
  const check = await buildCostCheck(cwd, { role: "review", refreshCatalog: false });

  assert.equal(check.costUnknown, true);
  assert.equal(check.exceeds, true);
});

test("an unresolvable cost does not trip a disabled guard", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "modelCatalog", normalizeCatalog({ models: [{ id: "known", billing: { multiplier: 1 } }] }));
  setConfig(cwd, "reviewModel", "a-model-not-in-the-catalog");
  setConfig(cwd, "costWarnThreshold", 0);

  const check = await buildCostCheck(cwd, { role: "review", refreshCatalog: false });

  assert.equal(check.costUnknown, true);
  assert.equal(check.exceeds, false);
});

test("the cost guard refreshes the roster when the cached catalog cannot price the model", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "modelCatalog", normalizeCatalog({ models: [{ id: "known", billing: { multiplier: 1 } }] }));
  setConfig(cwd, "reviewModel", "claude-sonnet-4.6");
  assert.equal(catalogHasModel("claude-sonnet-4.6", { models: [{ id: "known" }] }), false);

  const check = await buildCostCheck(cwd, {
    role: "review",
    ...withScenario({ models: [{ id: "claude-sonnet-4.6", billing: { multiplier: 9 } }] })
  });

  assert.equal(check.catalogRefreshed, true);
  assert.equal(check.multiplier, 9);
  assert.equal(check.exceeds, true);
});

// ---------------------------------------------------------------------------
// Codex P2: the queued job record was written after its worker was spawned.
// ---------------------------------------------------------------------------

test("a background job is readable from the store before its worker starts", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");
  const { enqueueBackgroundTask } = await import("../plugins/copilot/scripts/copilot-companion.mjs");

  let jobsVisibleAtSpawn = null;
  const result = enqueueBackgroundTask(
    cwd,
    cwd,
    {
      binary: FIXTURE,
      spawnWorker: () => {
        // Exactly the moment the real detached worker would call readStoredJob.
        jobsVisibleAtSpawn = listJobs(cwd).map((job) => job.id);
        return { pid: 4242 };
      }
    },
    "background me",
    false
  );

  assert.ok(jobsVisibleAtSpawn, "the worker spawn seam must have been used");
  assert.ok(
    jobsVisibleAtSpawn.includes(result.id),
    `job ${result.id} must already be stored when the worker starts, saw ${JSON.stringify(jobsVisibleAtSpawn)}`
  );
  assert.equal(result.pid, 4242);
});

// ---------------------------------------------------------------------------
// Codex P2: the shared effort default was validated against the task model
// only, so a review-model-incompatible value could be persisted.
// ---------------------------------------------------------------------------

test("a shared effort default is rejected when the review model does not accept it", async () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "no-effort-model");
  setConfig(cwd, "taskModel", "high-effort-model");

  await assert.rejects(
    () =>
      buildSetupReport(cwd, {
        effort: "high",
        ...withScenario({
          models: [
            { id: "no-effort-model", billing: { multiplier: 1 }, capabilities: { supports: {} } },
            {
              id: "high-effort-model",
              billing: { multiplier: 1 },
              capabilities: { supports: { reasoning_effort: ["low", "high"] } }
            }
          ]
        })
      }),
    /no-effort-model/
  );
});

// ---------------------------------------------------------------------------
// Copilot reviewer + Codex P2: the state file was written non-atomically and
// its read-modify-write was unserialized.
// ---------------------------------------------------------------------------

test("concurrent writers in separate processes do not lose each other's jobs", async () => {
  const cwd = tempWorkspace();
  const stateModule = path.join(TESTS_DIR, "..", "plugins", "copilot", "scripts", "lib", "state.mjs");
  const writer = `
    import { upsertJob } from ${JSON.stringify(stateModule)};
    const [cwd, id] = process.argv.slice(2);
    for (let i = 0; i < 40; i += 1) {
      upsertJob(cwd, { id, status: "running", phase: "step-" + i });
    }
  `;
  const writerPath = path.join(makeTempDir("copilot-writer-"), "writer.mjs");
  fs.writeFileSync(writerPath, writer, "utf8");

  const env = { ...process.env, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA, HOME: process.env.HOME };
  const [first, second] = await Promise.all([
    new Promise((resolve) => {
      const child = run("node", [writerPath, cwd, "job-alpha"], { cwd, env });
      resolve(child);
    }),
    new Promise((resolve) => {
      const child = run("node", [writerPath, cwd, "job-beta"], { cwd, env });
      resolve(child);
    })
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);

  const ids = listJobs(cwd).map((job) => job.id).sort();
  assert.deepEqual(ids, ["job-alpha", "job-beta"]);
});

test("the state file is always published whole, never truncated in place", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-haiku-4.5");
  const stateFile = resolveStateFile(cwd);

  // A reader can always parse it, and no temp file is left behind.
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(stateFile, "utf8")));
  const leftovers = fs.readdirSync(path.dirname(stateFile)).filter((name) => name.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
});

// ---------------------------------------------------------------------------
// Copilot reviewer: an unusable gate exited with no decision (a silent allow),
// and the internal-error path emitted a block on a non-zero exit, which
// Claude Code discards.
// ---------------------------------------------------------------------------

function runStopHook(cwd, input, env = {}) {
  return run("node", [STOP_HOOK], {
    cwd,
    env: {
      ...process.env,
      // No `copilot` on PATH: getCopilotAvailability fails, which is the
      // "gate enabled but unusable" condition.
      PATH: path.dirname(process.execPath),
      ...env
    },
    input: JSON.stringify(input)
  });
}

test("an enabled-but-unusable review gate blocks instead of silently allowing", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "stopReviewGate", true);

  const result = runStopHook(cwd, { cwd, session_id: "s1" });

  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout.trim());
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /cannot run/i);
  assert.match(decision.reason, /disable-review-gate/);
});

test("a disabled review gate still allows silently", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "stopReviewGate", false);

  const result = runStopHook(cwd, { cwd, session_id: "s1" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
});

test("an internal gate failure emits its block decision on exit 0", () => {
  const cwd = tempWorkspace();
  // Malformed hook input makes readHookInput throw before any other logic.
  const result = run("node", [STOP_HOOK], {
    cwd,
    env: { ...process.env },
    input: "{not json"
  });

  assert.equal(result.status, 0, "a non-zero exit makes Claude Code discard the decision on stdout");
  const decision = JSON.parse(result.stdout.trim());
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /unexpected internal error/i);
});

test("the gate timeout message states the timeout it actually uses", () => {
  const source = fs.readFileSync(STOP_HOOK, "utf8");
  const declared = /const STOP_REVIEW_TIMEOUT_MS = (\d+) \* 60 \* 1000;/.exec(source);
  assert.ok(declared, "STOP_REVIEW_TIMEOUT_MS must be declared in minutes");
  // The message interpolates the constant rather than restating it, so the
  // two cannot drift apart again.
  assert.match(source, /timed out after \$\{STOP_REVIEW_TIMEOUT_MS \/ 60000\} minutes/);
});

// ---------------------------------------------------------------------------
// Codex P2: `totalPremiumRequestCost` is a session total, but it was stored
// as one job's cost, double-counting every resumed session.
// ---------------------------------------------------------------------------

test("a resumed session reports only the spend of this turn, not the session total", async () => {
  const cwd = tempWorkspace();
  const { runCopilotTurn } = await import("../plugins/copilot/scripts/lib/copilot.mjs");

  const result = await runCopilotTurn(cwd, {
    model: "claude-haiku-4.5",
    prompt: "continue",
    sessionId: "prior-session-1",
    ...withScenario({
      sessions: [{ sessionId: "prior-session-1", name: "Copilot Companion Task: earlier" }],
      priorMetrics: { totalPremiumRequestCost: 1, totalNanoAiu: 1000 },
      metrics: { totalPremiumRequestCost: 3, totalNanoAiu: 4000 },
      finalMessage: "done"
    })
  });

  assert.equal(result.usage.premiumRequests, 2, "3 total minus 1 already spent before this turn");
  assert.equal(result.usage.aiu, 3000);
});

test("a fresh session reports the full metric, since its baseline is zero", async () => {
  const cwd = tempWorkspace();
  const { runCopilotTurn } = await import("../plugins/copilot/scripts/lib/copilot.mjs");

  const result = await runCopilotTurn(cwd, {
    model: "claude-haiku-4.5",
    prompt: "go",
    ...withScenario({ metrics: { totalPremiumRequestCost: 3, totalNanoAiu: 4000 }, finalMessage: "done" })
  });

  assert.equal(result.usage.premiumRequests, 3);
});

// ---------------------------------------------------------------------------
// Codex P2: an assistant.message armed an unconditional 250ms completion
// timer, so a model that narrates before calling a tool had its turn
// truncated to the preamble.
// ---------------------------------------------------------------------------

test("a tool call that outlives the completion fallback does not truncate the turn", async () => {
  const cwd = tempWorkspace();
  const { runCopilotTurn } = await import("../plugins/copilot/scripts/lib/copilot.mjs");

  const result = await runCopilotTurn(cwd, {
    model: "claude-haiku-4.5",
    prompt: "review this",
    ...withScenario({
      events: [
        { type: "session.start", data: {} },
        { type: "assistant.turn_start", data: {} },
        // The model narrates first — this is what used to arm the timer.
        { type: "assistant.message", data: { content: "Let me look at the diff first." } },
        { type: "command.execute", data: { command: "git diff" } },
        // Longer than INFERRED_COMPLETION_MS (250ms) by a clear margin.
        { type: "command.completed", delayMs: 900, data: { command: "git diff", exitCode: 0 } },
        { type: "assistant.message", data: { content: "THE ACTUAL REVIEW" } },
        { type: "session.idle", data: {} }
      ]
    })
  });

  assert.equal(result.finalMessage, "THE ACTUAL REVIEW");
  assert.equal(result.commandExecutions.length, 1);
});

test("the completion fallback still resolves a single-round turn that never sends session.idle", async () => {
  const cwd = tempWorkspace();
  const { runCopilotTurn } = await import("../plugins/copilot/scripts/lib/copilot.mjs");

  const result = await runCopilotTurn(cwd, {
    model: "claude-haiku-4.5",
    absoluteTimeoutMs: 10_000,
    prompt: "answer",
    ...withScenario({
      events: [
        { type: "session.start", data: {} },
        { type: "assistant.turn_start", data: {} },
        { type: "assistant.message", data: { content: "the answer" } }
      ]
    })
  });

  assert.equal(result.finalMessage, "the answer");
  assert.equal(result.status, 0);
});

test("a message emitted while a command is already running does not arm the fallback", async () => {
  const cwd = tempWorkspace();
  const { runCopilotTurn } = await import("../plugins/copilot/scripts/lib/copilot.mjs");

  const result = await runCopilotTurn(cwd, {
    model: "claude-haiku-4.5",
    prompt: "review this",
    ...withScenario({
      events: [
        { type: "session.start", data: {} },
        { type: "assistant.turn_start", data: {} },
        { type: "command.execute", data: { command: "git diff" } },
        // Narration streams out while the tool is still running.
        { type: "assistant.message", data: { content: "Still reading the diff." } },
        { type: "command.completed", delayMs: 900, data: { command: "git diff", exitCode: 0 } },
        { type: "assistant.message", data: { content: "THE ACTUAL REVIEW" } },
        { type: "session.idle", data: {} }
      ]
    })
  });

  assert.equal(result.finalMessage, "THE ACTUAL REVIEW");
});

// ---------------------------------------------------------------------------
// Second review round — Copilot reviewer: a writer that timed out waiting for
// the lock still ran the unconditional release, deleting the real holder's
// lock directory and letting a third process run concurrently with it.
// ---------------------------------------------------------------------------

function lockPathFor(cwd) {
  return path.join(resolveStateDir(cwd), ".state.lock");
}

function takeForeignLock(cwd, token = "someone-else") {
  const lockPath = lockPathFor(cwd);
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, "owner"), token, "utf8");
  return lockPath;
}

test("a writer that times out waiting does not release the real holder's lock", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-haiku-4.5");
  const lockPath = takeForeignLock(cwd);

  let ran = false;
  // Short timeout so this does not sit for the real 10s ceiling.
  withStateLock(cwd, () => {
    ran = true;
  }, { timeoutMs: 60 });

  assert.equal(ran, true, "a timed-out writer must still do its work rather than drop it");
  assert.equal(fs.existsSync(lockPath), true, "the real holder's lock must survive");
  assert.equal(fs.readFileSync(path.join(lockPath, "owner"), "utf8"), "someone-else");
});

test("a holder whose lock was broken as stale does not release its successor's lock", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-haiku-4.5");
  const lockPath = lockPathFor(cwd);

  withStateLock(cwd, () => {
    // Simulate this holder overrunning LOCK_STALE_MS: another process breaks
    // the lock and takes it while we are still inside the critical section.
    fs.rmSync(lockPath, { recursive: true, force: true });
    takeForeignLock(cwd, "successor");
  });

  assert.equal(fs.existsSync(lockPath), true, "the successor's lock must survive");
  assert.equal(fs.readFileSync(path.join(lockPath, "owner"), "utf8"), "successor");
});

test("an uncontended writer takes and releases the lock cleanly", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-haiku-4.5");
  const lockPath = lockPathFor(cwd);

  let heldDuring = null;
  withStateLock(cwd, () => {
    heldDuring = fs.existsSync(lockPath);
  });

  assert.equal(heldDuring, true, "the lock must actually be held inside the critical section");
  assert.equal(fs.existsSync(lockPath), false, "and released afterwards");
});

test("a stale lock is broken despite carrying its holder's owner file", () => {
  const cwd = tempWorkspace();
  setConfig(cwd, "reviewModel", "claude-haiku-4.5");
  const lockPath = takeForeignLock(cwd, "dead-process");
  // Backdate well past LOCK_STALE_MS (30s).
  const longAgo = new Date(Date.now() - 120_000);
  fs.utimesSync(lockPath, longAgo, longAgo);

  let ran = false;
  withStateLock(cwd, () => {
    ran = true;
    assert.equal(fs.readFileSync(path.join(lockPath, "owner"), "utf8").startsWith(`${process.pid}-`), true);
  }, { timeoutMs: 60 });

  assert.equal(ran, true);
  assert.equal(fs.existsSync(lockPath), false, "we owned it, so we released it");
});
