import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTranscriptDigest, resolveClaudeSessionPath } from "../plugins/copilot/scripts/lib/claude-session-transfer.mjs";
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
    assert.equal(resolveClaudeSessionPath(process.cwd(), { source: file }), file);
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
