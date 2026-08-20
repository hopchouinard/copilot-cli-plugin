import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set by the SessionStart hook (session-lifecycle-hook.mjs) so a transfer
// run without --source can find the current Claude Code transcript. Kept as
// its own literal here (rather than importing the hook's constant) so this
// module has no dependency on the hook module.
export const TRANSCRIPT_PATH_ENV = "CLAUDE_TRANSCRIPT_PATH";

function isContainedIn(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function realpathIfExists(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

// This command reads a file off disk and ships its contents to a remote
// service (Copilot). A source that resolves outside ~/.claude/projects would
// let a crafted --source (or a stray/malicious CLAUDE_TRANSCRIPT_PATH)
// exfiltrate an arbitrary file from the user's machine, so containment is
// checked twice:
//   1. Against the lexically resolved path (path.resolve only normalizes
//      "." / ".." segments — it does not touch the raw input, so this alone
//      already defeats a "../../.ssh/id_rsa" style traversal).
//   2. Against the fully symlink-resolved real path, so a symlink planted
//      inside ~/.claude/projects that points outside it can't be used to
//      read an arbitrary file either.
// Both checks run on the *resolved* result, never on the raw input string.
export function resolveClaudeSessionPath(cwd, options = {}) {
  const source = options.source ?? process.env[TRANSCRIPT_PATH_ENV];
  if (!source) {
    throw new Error(
      "No Claude transcript found. Pass --source <path>, or start a new Claude session so the SessionStart hook can record it."
    );
  }

  const resolved = path.resolve(cwd, source);
  const projectsRoot = path.join(os.homedir(), ".claude", "projects");

  if (!isContainedIn(resolved, projectsRoot)) {
    throw new Error(`The transfer source must live under ~/.claude/projects. Got: ${resolved}`);
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Transcript not found: ${resolved}`);
  }

  const realResolved = fs.realpathSync(resolved);
  const realProjectsRoot = realpathIfExists(projectsRoot);
  if (!isContainedIn(realResolved, realProjectsRoot)) {
    throw new Error(`The transfer source must live under ~/.claude/projects. Got: ${resolved}`);
  }

  return resolved;
}

function readEntries(jsonlPath) {
  return fs
    .readFileSync(jsonlPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function textOf(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

export function buildTranscriptDigest(jsonlPath) {
  const entries = readEntries(jsonlPath);
  const userMessages = entries.filter((entry) => entry.type === "user").map((entry) => textOf(entry.message?.content));
  const assistantMessages = entries
    .filter((entry) => entry.type === "assistant")
    .map((entry) => textOf(entry.message?.content))
    .filter(Boolean);

  const filesTouched = [];
  const commands = [];

  for (const entry of entries) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block.type !== "tool_use") {
        continue;
      }
      if (EDIT_TOOLS.has(block.name) && block.input?.file_path && !filesTouched.includes(block.input.file_path)) {
        filesTouched.push(block.input.file_path);
      }
      if (block.name === "Bash" && block.input?.command) {
        commands.push(block.input.command);
      }
    }
  }

  const goal = userMessages.find(Boolean) ?? "(no user message found)";
  const decisions = assistantMessages.slice(-5);
  const openThreads = userMessages.slice(-1);

  const markdown = [
    "# Transferred Claude Code session",
    "",
    "This is a **primer**, not replayed turn history. GitHub Copilot CLI has no",
    "session-import API, so the Claude conversation below has been condensed into",
    "a briefing. Treat it as context, not as your own prior output.",
    "",
    "## Original goal",
    "",
    goal,
    "",
    "## Files touched",
    "",
    filesTouched.length > 0 ? filesTouched.map((file) => `- ${file}`).join("\n") : "(none recorded)",
    "",
    "## Commands run",
    "",
    commands.length > 0 ? commands.slice(-10).map((command) => `- \`${command}\``).join("\n") : "(none recorded)",
    "",
    "## Where the conversation left off",
    "",
    decisions.length > 0 ? decisions.join("\n\n") : "(no assistant output recorded)",
    "",
    "## Most recent instruction",
    "",
    openThreads.join("\n") || "(none)",
    ""
  ].join("\n");

  return { goal, decisions, filesTouched, commands, openThreads, markdown };
}
