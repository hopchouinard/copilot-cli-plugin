#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// The Claude Code session id, exported at SessionStart so later companion
// commands and SessionEnd can find the jobs that belong to this session. This
// is deliberately distinct from a job's copilotSessionId (the Copilot RPC
// session, used for `copilot --resume=<id>`) — reaping must key off this one.
export const SESSION_ID_ENV = "COPILOT_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const TRANSCRIPT_PATH_ENV = "CLAUDE_TRANSCRIPT_PATH";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  // Only jobs that are BOTH this session's AND still queued/running are
  // reaped. Finished, failed, and cancelled jobs for this session stay in
  // state — they are exactly what /copilot:result and the 50-job history cap
  // exist to hold, and their results become unrecoverable the moment their
  // job/log files are pruned by saveState below.
  const reapableJobs = state.jobs.filter(
    (job) => job.sessionId === sessionId && (job.status === "queued" || job.status === "running")
  );
  if (reapableJobs.length === 0) {
    return;
  }

  for (const job of reapableJobs) {
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  // saveState prunes files for any job no longer present in the retained
  // list, so dropping only the reaped jobs here also deletes only their
  // job/log files.
  const reapedIds = new Set(reapableJobs.map((job) => job.id));
  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => !reapedIds.has(job.id))
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
