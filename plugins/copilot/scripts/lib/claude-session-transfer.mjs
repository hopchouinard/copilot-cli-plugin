import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set by the SessionStart hook (session-lifecycle-hook.mjs) so a transfer
// run without --source can find the current Claude Code transcript. This is
// the canonical definition — session-lifecycle-hook.mjs imports it from
// here rather than hardcoding its own copy, so the two can't drift apart
// with no test catching it.
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
// checked in three ways, all against *resolved* results, never the raw
// input string:
//   1. Against the lexically resolved path (path.resolve only normalizes
//      "." / ".." segments — it does not touch the raw input, so this alone
//      already defeats a "../../.ssh/id_rsa" style traversal).
//   2. Against the fully symlink-resolved real path, so a symlink planted
//      inside ~/.claude/projects that points outside it can't be used to
//      read an arbitrary file either.
//   3. Against the link count of that real path. realpathSync only resolves
//      *symlinks* — a hardlink is a second directory entry pointing at the
//      same inode elsewhere on disk, so it passes both checks above
//      unchanged. A genuine Claude Code transcript is never hardlinked, so
//      any source with more than one link is rejected outright.
// The function also returns the symlink-resolved path, not the lexical one:
// returning the lexical path would leave a check-then-use race open — a
// symlink that resolves inside the root at check time could be repointed
// outside it before the caller's readFileSync re-traverses it fresh.
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

  if (fs.lstatSync(realResolved).nlink > 1) {
    throw new Error(`The transfer source must live under ~/.claude/projects. Got: ${resolved}`);
  }

  return realResolved;
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

// Best-effort redaction of high-confidence credential shapes in a recorded
// shell command before it enters the digest. This is pattern matching, not
// a guarantee — it catches the common, recognizable shapes (Authorization
// headers, Bearer tokens, and TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL-named
// assignments) and nothing more. Callers must not describe this as complete;
// see the explicit "best-effort, not guaranteed" disclaimer carried in both
// the digest markdown and the rendered transfer output.
export function redactCredentials(command) {
  let redacted = String(command ?? "");

  // Authorization: header with a quoted value, e.g. curl -H "Authorization: Bearer xyz"
  redacted = redacted.replace(
    /(Authorization\s*:\s*)(["'])(Bearer\s+)?((?:(?!\2).)*)\2/gi,
    (_match, prefix, quote, bearer = "") => `${prefix}${quote}${bearer}<redacted>${quote}`
  );

  // Authorization: header with an unquoted value
  redacted = redacted.replace(
    /(Authorization\s*:\s*)(Bearer\s+)?([^\s"']+)/gi,
    (_match, prefix, bearer = "") => `${prefix}${bearer}<redacted>`
  );

  // A bare "Bearer <token>" not preceded by "Authorization:"
  redacted = redacted.replace(/\bBearer\s+([^\s"']+)/gi, "Bearer <redacted>");

  // NAME=value / NAME="value" assignments where NAME looks secret-ish —
  // keeps the assignment shape (name, quoting) but drops the value.
  //
  // The name's prefix is OPTIONAL but must end at an underscore boundary,
  // and the keyword itself is bounded by a negative lookahead forbidding a
  // trailing identifier character. TOKEN, KEY, SECRET, PASSWORD, and
  // CREDENTIAL are exactly the bare names the requirement calls out, and
  // they are everyday shell/CI idioms on their own (`TOKEN=$X`,
  // `KEY=... deploy.sh`) — a mandatory prefix character would make the
  // named case simply not match. But an UNBOUNDED keyword over-redacts:
  // without the lookahead, "KEYBOARD", "--keyfile", "TOKENIZER", and
  // "SECRETARY" all matched too (a *different* kind of wrong — mangling an
  // unrelated file path or word in the digest, not a leak, but still
  // wrong). The lookahead requires the keyword to end the identifier (or
  // to be followed by another underscore-delimited segment), so
  // "AWS_SECRET_ACCESS_KEY" still matches in full while "KEYBOARD" does not
  // match at all.
  //
  // An optional numeric suffix — `_?\d+` — is allowed between the keyword
  // and the lookahead, so rotated/numbered credential names like `KEY2`,
  // `TOKEN_2`, and `AWS_ACCESS_KEY_2` still match (a plausible, common
  // real-world shape). This does not reopen the over-redaction hole: a
  // *letter* suffix ("BOARD", "IZER", "ARY", ...) still fails the
  // lookahead exactly as before, since the numeric-suffix alternative only
  // ever consumes digits (and an optional leading underscore) — "TOKENS"
  // and "KEYS" still fall through untouched.
  //
  // The value is one alternation with three fully-bounded branches, each
  // chosen so the match can never stop short of the real value boundary
  // and leave a marker sitting beside untouched secret text:
  //   1. Quoted and terminated — spans spaces via a not-the-closing-quote
  //      loop, up to the real closing quote.
  //   2. Quoted but NEVER terminated (e.g. `TOKEN="abc` with no closing
  //      quote before the string ends) — redacts from the opening quote
  //      through the end of the string. Without this branch, branch 1
  //      fails outright (no closing quote to find), the pattern falls
  //      through to the unquoted branch, and THAT branch's [^\s"']* can't
  //      cross the quote character it just saw either — so it matches
  //      zero-width right after "=" and the marker gets spliced in next to
  //      the live secret. This branch exists specifically so that can't
  //      happen: a value that opens with a quote is never left partially
  //      unconsumed.
  //   3. Unquoted — up to the next space/quote, or empty if none.
  //
  // The empty-span guard is a SINGLE rule applied uniformly to whichever
  // branch matched, not a per-branch special case: this class of bug
  // (marker inserted beside a value the pattern didn't actually capture)
  // has recurred twice already, each time in a branch nobody had checked.
  // If the captured value — terminated-quoted, unterminated-quoted, or
  // unquoted, whichever fired — is the empty string, the match is
  // returned unchanged and no marker is inserted at all, so `TOKEN=""`
  // stays `TOKEN=""` rather than becoming `TOKEN="<redacted>"`, and any
  // future branch added here inherits the same protection for free.
  redacted = redacted.replace(
    /\b((?:[A-Za-z0-9_]*_)?(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)(?:_?\d+)?(?![A-Za-z0-9]))(\s*=\s*)(?:(["'])(?:((?:(?!\3)[\s\S])*)\3|([\s\S]*))|([^\s"']*))/gi,
    (match, name, eq, quote, terminatedValue, unterminatedValue, unquotedValue) => {
      const value = terminatedValue !== undefined ? terminatedValue : unterminatedValue !== undefined ? unterminatedValue : unquotedValue;
      if (!value) {
        return match;
      }
      if (quote !== undefined) {
        // terminatedValue is defined (even as "", already excluded above)
        // only when branch 1 (a real closing quote) matched; branch 2's
        // unterminatedValue never gets a closing quote to echo back, since
        // none existed.
        const closingQuote = terminatedValue !== undefined ? quote : "";
        return `${name}${eq}${quote}<redacted>${closingQuote}`;
      }
      return `${name}${eq}<redacted>`;
    }
  );

  return redacted;
}

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
        commands.push(redactCredentials(block.input.command));
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
    "Commands likely to contain credentials are redacted on a best-effort",
    "basis (Authorization headers, Bearer tokens, and",
    "TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL-named assignments). This is pattern",
    "matching, not a guarantee — it can miss secrets in other shapes.",
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
