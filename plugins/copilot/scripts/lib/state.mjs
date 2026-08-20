import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "copilot-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_DIR_NAME = ".state.lock";
// A holder that dies mid-transaction (SIGKILL, a crashed worker) leaves its
// lock directory behind forever. Any lock older than this is treated as
// abandoned and broken. It must comfortably exceed a real transaction, which
// is a handful of synchronous file operations.
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 20;

let writeCounter = 0;

// `fs.writeFileSync` truncates and then fills, so a concurrent reader can
// observe a half-written file. loadState swallows the resulting JSON.parse
// failure and returns defaultState() — and saveState then treats that empty
// default as the authoritative previous state, dropping every tracked job
// AND deleting their job/log files on disk. Writing to a sibling temp file
// and renaming makes publication atomic: a reader sees either the whole old
// file or the whole new one, never a torn one.
function writeFileAtomic(targetPath, contents) {
  writeCounter += 1;
  const tempPath = `${targetPath}.tmp-${process.pid}-${writeCounter}`;
  try {
    fs.writeFileSync(tempPath, contents, "utf8");
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw error;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Atomic publication alone does not serialize a read-modify-write: two
// background jobs reporting a phase change at the same moment can each load
// the same snapshot, patch only their own job, and write — and the second
// write silently discards the first job's update. `mkdir` is atomic and
// fails with EEXIST when the directory exists, which makes it a usable
// interprocess mutex with no dependencies.
//
// Reentrant within a process: updateState holds the lock and then calls
// saveState, which takes it again. Without the depth counter that is an
// immediate self-deadlock.
let lockDepth = 0;

function acquireLock(lockPath, deadline) {
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      let heldSince = null;
      try {
        heldSince = fs.statSync(lockPath).mtimeMs;
      } catch {
        // The holder released it between mkdir and stat — retry immediately.
        continue;
      }
      if (Date.now() - heldSince > LOCK_STALE_MS) {
        try {
          fs.rmdirSync(lockPath);
        } catch {
          // Someone else broke the same stale lock first; retry.
        }
        continue;
      }
      if (Date.now() > deadline) {
        // Timing out must not abandon the caller's write. Proceeding without
        // the lock restores exactly the pre-lock behaviour (atomic publish,
        // unserialized RMW) rather than throwing away a completed paid turn's
        // bookkeeping.
        return;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

export function withStateLock(cwd, fn) {
  if (lockDepth > 0) {
    lockDepth += 1;
    try {
      return fn();
    } finally {
      lockDepth -= 1;
    }
  }

  ensureStateDir(cwd);
  const lockPath = path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
  acquireLock(lockPath, Date.now() + LOCK_TIMEOUT_MS);
  lockDepth = 1;
  try {
    return fn();
  } finally {
    lockDepth = 0;
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // Already broken as stale by another process; nothing to release.
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false,
      costWarnThreshold: 6,
      reviewModel: null,
      taskModel: null,
      effort: null,
      modelCatalog: null
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateLocked(cwd, state));
}

function saveStateLocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function updateState(cwd, mutate) {
  // The load, the mutation, and the write are one transaction — see
  // withStateLock. Reads outside it are safe without the lock because
  // writeFileAtomic publishes by rename.
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateLocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  // Background workers read this file while the parent rewrites it; publish
  // by rename for the same reason state.json does.
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
