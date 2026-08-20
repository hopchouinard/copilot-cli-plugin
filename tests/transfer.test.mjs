import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTranscriptDigest,
  redactCredentials,
  resolveClaudeSessionPath
} from "../plugins/copilot/scripts/lib/claude-session-transfer.mjs";
import { executeTransfer } from "../plugins/copilot/scripts/copilot-companion.mjs";
import { setConfig } from "../plugins/copilot/scripts/lib/state.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-copilot-fixture.mjs");

function transcript(lines) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-tx-")), "session.jsonl");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return file;
}

// Isolates HOME to a throwaway directory containing a real
// ~/.claude/projects tree, so tests never touch (or depend on) the
// developer's actual Claude Code transcripts.
function isolatedHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-home-"));
  const projectsRoot = path.join(home, ".claude", "projects");
  fs.mkdirSync(projectsRoot, { recursive: true });
  return { home, projectsRoot };
}

function tempWorkspace() {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-data-"));
  return fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ws-"));
}

function withScenario(scenario) {
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

test("the digest captures the first user message as the goal", () => {
  const file = transcript([
    { type: "user", message: { role: "user", content: "Add retry logic to the uploader" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Sure." }] } }
  ]);
  assert.match(buildTranscriptDigest(file).goal, /retry logic to the uploader/);
});

test("the digest lists files touched by edit tool calls", () => {
  const file = transcript([
    { type: "user", message: { role: "user", content: "go" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/src/upload.js" } }]
      }
    }
  ]);
  assert.deepEqual(buildTranscriptDigest(file).filesTouched, ["/repo/src/upload.js"]);
});

test("the digest markdown states plainly that it is a primer, not replayed history", () => {
  const file = transcript([{ type: "user", message: { role: "user", content: "go" } }]);
  assert.match(buildTranscriptDigest(file).markdown, /primer/i);
});

test("a source outside ~/.claude/projects is rejected", () => {
  assert.throws(() => resolveClaudeSessionPath(process.cwd(), { source: "/etc/passwd" }), /~\/\.claude\/projects/);
});

test("a .. traversal that starts inside ~/.claude/projects but escapes it is rejected", () => {
  const { home, projectsRoot } = isolatedHome();
  const secret = path.join(home, ".ssh", "id_rsa");
  fs.mkdirSync(path.dirname(secret), { recursive: true });
  fs.writeFileSync(secret, "private key material", "utf8");

  const traversal = path.join(projectsRoot, "..", "..", ".ssh", "id_rsa");
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.throws(() => resolveClaudeSessionPath(process.cwd(), { source: traversal }), /~\/\.claude\/projects/);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("a symlink inside ~/.claude/projects that points outside it is rejected", () => {
  const { home, projectsRoot } = isolatedHome();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-outside-"));
  const secret = path.join(outsideDir, "secret.txt");
  fs.writeFileSync(secret, "outside content", "utf8");

  const projectDir = path.join(projectsRoot, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  const link = path.join(projectDir, "session.jsonl");
  fs.symlinkSync(secret, link);

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.throws(() => resolveClaudeSessionPath(process.cwd(), { source: link }), /~\/\.claude\/projects/);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("a transcript that lives under ~/.claude/projects resolves cleanly", () => {
  const { home, projectsRoot } = isolatedHome();
  const projectDir = path.join(projectsRoot, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, "session.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: "go" } }), "utf8");

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // Compare against the realpath, not the lexical `file` string: on this
    // machine os.tmpdir() itself sits behind a symlink (/var -> /private/var
    // on macOS), so the two can legitimately differ even with no
    // transfer-specific symlink involved.
    assert.equal(resolveClaudeSessionPath(process.cwd(), { source: file }), fs.realpathSync(file));
  } finally {
    process.env.HOME = originalHome;
  }
});

test("a hardlink inside ~/.claude/projects pointing at a file outside it is rejected", () => {
  // Regression test for a real, reproduced escape: fs.realpathSync only
  // resolves symlinks. A hardlink is a second directory entry pointing at
  // the same inode elsewhere on disk, so it passes both the lexical and the
  // symlink-resolved containment checks unchanged unless nlink is checked
  // too. This must fail against code that only checks realpath containment.
  const { home, projectsRoot } = isolatedHome();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-outside-"));
  const secretFile = path.join(outsideDir, "secret.jsonl");
  fs.writeFileSync(
    secretFile,
    JSON.stringify({ type: "user", message: { role: "user", content: "TOP SECRET KEY MATERIAL" } }),
    "utf8"
  );

  const projectDir = path.join(projectsRoot, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  const hardlink = path.join(projectDir, "session.jsonl");
  fs.linkSync(secretFile, hardlink);
  assert.ok(fs.lstatSync(hardlink).nlink > 1, "test setup sanity check: expected a real hardlink (nlink > 1)");

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.throws(() => resolveClaudeSessionPath(process.cwd(), { source: hardlink }), /~\/\.claude\/projects/);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("a symlink inside ~/.claude/projects pointing to another file inside it resolves to the real target, not the symlink path", () => {
  // Guards against a check-then-use race: if the function returned the
  // lexical (symlink) path instead of the resolved real path, a caller's
  // later readFileSync would re-traverse the symlink fresh — and it could
  // have been repointed outside the root in between.
  const { home, projectsRoot } = isolatedHome();
  const realDir = path.join(projectsRoot, "proj-real");
  fs.mkdirSync(realDir, { recursive: true });
  const realFile = path.join(realDir, "real-session.jsonl");
  fs.writeFileSync(realFile, JSON.stringify({ type: "user", message: { role: "user", content: "go" } }), "utf8");

  const linkDir = path.join(projectsRoot, "proj-link");
  fs.mkdirSync(linkDir, { recursive: true });
  const link = path.join(linkDir, "session.jsonl");
  fs.symlinkSync(realFile, link);

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const resolved = resolveClaudeSessionPath(process.cwd(), { source: link });
    assert.equal(resolved, fs.realpathSync(realFile));
    assert.notEqual(resolved, link);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("missing --source and missing env var produces a helpful error, not a crash", () => {
  const originalEnv = process.env.CLAUDE_TRANSCRIPT_PATH;
  delete process.env.CLAUDE_TRANSCRIPT_PATH;
  try {
    assert.throws(() => resolveClaudeSessionPath(process.cwd(), {}), /No Claude transcript found/);
  } finally {
    if (originalEnv !== undefined) {
      process.env.CLAUDE_TRANSCRIPT_PATH = originalEnv;
    }
  }
});

test("a malformed jsonl line is skipped rather than crashing the digest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-tx-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "Add retries" } }),
      "{not valid json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } })
    ].join("\n"),
    "utf8"
  );

  const digest = buildTranscriptDigest(file);
  assert.match(digest.goal, /Add retries/);
  assert.deepEqual(digest.decisions, ["Done."]);
});

test("an empty transcript still produces a digest instead of throwing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-tx-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, "", "utf8");

  const digest = buildTranscriptDigest(file);
  assert.equal(digest.goal, "(no user message found)");
  assert.deepEqual(digest.filesTouched, []);
  assert.match(digest.markdown, /primer/i);
});

test("a transcript with no assistant messages notes that plainly instead of erroring", () => {
  const file = transcript([{ type: "user", message: { role: "user", content: "go" } }]);
  const digest = buildTranscriptDigest(file);
  assert.deepEqual(digest.decisions, []);
  assert.match(digest.markdown, /no assistant output recorded/);
});

test("transfer mints a new Copilot session via session.create, not session.resume", async () => {
  const { home, projectsRoot } = isolatedHome();
  const projectDir = path.join(projectsRoot, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  const source = path.join(projectDir, "session.jsonl");
  fs.writeFileSync(source, JSON.stringify({ type: "user", message: { role: "user", content: "Ship the thing" } }), "utf8");

  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  const scenario = withScenario({ finalMessage: "Got it, standing by." });
  try {
    const execution = await executeTransfer(cwd, { source, ...scenario });
    const calls = readCapturedCalls(scenario.capturePath);
    assert.ok(calls.some((call) => call.method === "session.create"), "expected session.create to be called");
    assert.ok(!calls.some((call) => call.method === "session.resume"), "session.resume must not be called");

    const createCall = calls.find((call) => call.method === "session.create");
    assert.equal(execution.payload.copilotSessionId, createCall.params.sessionId);
    assert.match(execution.rendered, new RegExp(`copilot --resume=${execution.payload.copilotSessionId}`));
  } finally {
    process.env.HOME = originalHome;
  }
});

test("the transfer output states plainly that this is a primer, not a full history transfer", async () => {
  const { home, projectsRoot } = isolatedHome();
  const projectDir = path.join(projectsRoot, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  const source = path.join(projectDir, "session.jsonl");
  fs.writeFileSync(source, JSON.stringify({ type: "user", message: { role: "user", content: "Ship the thing" } }), "utf8");

  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const execution = await executeTransfer(cwd, { source, ...withScenario({ finalMessage: "Standing by." }) });
    assert.match(execution.rendered, /primer/i);
    assert.match(execution.rendered, /no\s+session-import API/i);
  } finally {
    process.env.HOME = originalHome;
  }
});

test("redactCredentials drops an Authorization: Bearer value while keeping the shape", () => {
  const redacted = redactCredentials('curl -H "Authorization: Bearer sk-live-abc123XYZ" https://api.example.com');
  assert.doesNotMatch(redacted, /sk-live-abc123XYZ/);
  assert.match(redacted, /Authorization: Bearer <redacted>/);
});

test("redactCredentials drops a bare Bearer token", () => {
  const redacted = redactCredentials("echo Bearer sk-live-abc123XYZ");
  assert.doesNotMatch(redacted, /sk-live-abc123XYZ/);
  assert.match(redacted, /Bearer <redacted>/);
});

test("redactCredentials drops a secret-ish named assignment", () => {
  const redacted = redactCredentials("export GITHUB_TOKEN=ghp_abcdef1234567890");
  assert.doesNotMatch(redacted, /ghp_abcdef1234567890/);
  assert.match(redacted, /GITHUB_TOKEN=<redacted>/);
});

test("redactCredentials leaves an ordinary command untouched", () => {
  assert.equal(redactCredentials("npm test -- --coverage"), "npm test -- --coverage");
});

test("redactCredentials redacts the bare keyword names, not just prefixed ones", () => {
  // Regression guard: the assignment regex used to require at least one
  // identifier character before the keyword, so "TOKEN=x" / "KEY=x" /
  // "PASSWORD=x" / "CREDENTIAL=x" (the exact bare names the requirement
  // lists first, and everyday shell/CI idioms on their own) passed through
  // unredacted while only prefixed names like "GITHUB_TOKEN=x" worked.
  for (const name of ["TOKEN", "KEY", "PASSWORD", "CREDENTIAL"]) {
    const redacted = redactCredentials(`${name}=realsecretvalue`);
    assert.doesNotMatch(redacted, /realsecretvalue/, `${name} leaked its value`);
    assert.match(redacted, new RegExp(`${name}=<redacted>`), `${name} was not redacted at all`);
  }
});

test("redactCredentials fully redacts a quoted value that contains spaces, never leaving the marker beside the live secret", () => {
  // Regression guard: the optional-quote value pattern couldn't span a
  // space inside quotes, so it backtracked to a zero-width match right
  // after "=" and inserted the marker there — producing
  // `MY_TOKEN=<redacted>"abc def ghi"`, which reads as redacted while the
  // real secret sits untouched immediately next to the word "redacted".
  // Absent redaction is honest; that output is actively misleading.
  const redacted = redactCredentials('MY_TOKEN="abc def ghi" some-cmd');
  assert.equal(redacted, 'MY_TOKEN="<redacted>" some-cmd');
  assert.doesNotMatch(redacted, /abc def ghi/);
});

test("redactCredentials never emits <redacted> directly adjacent to the real secret, across a corpus of realistic command shapes", () => {
  // The invariant that stops this class of bug returning: for every shape
  // this function claims to handle, the marker must never sit immediately
  // next to (nor anywhere ahead of) the plaintext it was supposed to
  // replace. Shapes this function does NOT claim to handle — single-quoted
  // escaping edge cases, bare positional tokens, URL-embedded credentials —
  // are deliberately out of this corpus; those stay honestly unredacted,
  // which the disclaimer covers, and are not this test's concern.
  const corpus = [
    { command: "export GITHUB_TOKEN=ghp_realsecret123", secret: "ghp_realsecret123" },
    { command: "export TOKEN=ghp_realsecret123", secret: "ghp_realsecret123" },
    { command: "KEY=abc123 deploy.sh", secret: "abc123" },
    { command: 'PASSWORD="correct horse battery"', secret: "correct horse battery" },
    { command: 'MY_TOKEN="abc def ghi" some-cmd', secret: "abc def ghi" },
    { command: "SECRET='multi word phrase' next-thing", secret: "multi word phrase" },
    { command: "CREDENTIAL=supersecretvalue --flag", secret: "supersecretvalue" },
    { command: 'curl -H "Authorization: Bearer sk-live-abc123XYZ"', secret: "sk-live-abc123XYZ" },
    { command: "echo Bearer sk-live-abc123XYZ", secret: "sk-live-abc123XYZ" },
    { command: "API_KEY=xyz789 --deploy", secret: "xyz789" }
  ];

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const { command, secret } of corpus) {
    const redacted = redactCredentials(command);
    const escapedSecret = escapeRegExp(secret);
    assert.doesNotMatch(redacted, new RegExp(escapedSecret), `secret leaked verbatim in: ${redacted}`);
    assert.doesNotMatch(
      redacted,
      new RegExp(`<redacted>["']?${escapedSecret}|${escapedSecret}["']?<redacted>`),
      `"<redacted>" sat directly next to the real secret in: ${redacted}`
    );
  }
});

test("the digest redacts credential-shaped commands before they reach the markdown", () => {
  const file = transcript([
    { type: "user", message: { role: "user", content: "go" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Bash", input: { command: 'curl -H "Authorization: Bearer sk-live-abc123XYZ"' } }
        ]
      }
    }
  ]);
  const digest = buildTranscriptDigest(file);
  assert.doesNotMatch(digest.markdown, /sk-live-abc123XYZ/);
  assert.match(digest.markdown, /Authorization: Bearer <redacted>/);
});

test("the digest markdown states plainly that command redaction is best-effort, not guaranteed", () => {
  const file = transcript([{ type: "user", message: { role: "user", content: "go" } }]);
  const markdown = buildTranscriptDigest(file).markdown;
  assert.match(markdown, /best-effort/i);
  assert.match(markdown, /not a guarantee/i);
});

test("transfer runs read-only (plan mode)", async () => {
  const { home, projectsRoot } = isolatedHome();
  const projectDir = path.join(projectsRoot, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  const source = path.join(projectDir, "session.jsonl");
  fs.writeFileSync(source, JSON.stringify({ type: "user", message: { role: "user", content: "Ship the thing" } }), "utf8");

  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const execution = await executeTransfer(cwd, { source, ...withScenario({ finalMessage: "Standing by." }) });
    assert.equal(execution.payload.mode, "plan");
  } finally {
    process.env.HOME = originalHome;
  }
});

test("the rendered transfer output states plainly that command redaction is best-effort, not guaranteed", async () => {
  const { home, projectsRoot } = isolatedHome();
  const projectDir = path.join(projectsRoot, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  const source = path.join(projectDir, "session.jsonl");
  fs.writeFileSync(source, JSON.stringify({ type: "user", message: { role: "user", content: "Ship the thing" } }), "utf8");

  const cwd = tempWorkspace();
  setConfig(cwd, "taskModel", "claude-haiku-4.5");

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const execution = await executeTransfer(cwd, { source, ...withScenario({ finalMessage: "Standing by." }) });
    assert.match(execution.rendered, /best-effort/i);
    assert.match(execution.rendered, /not a guarantee/i);
  } finally {
    process.env.HOME = originalHome;
  }
});
