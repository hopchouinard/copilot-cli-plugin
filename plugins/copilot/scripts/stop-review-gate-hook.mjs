#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCopilotAuthStatus, getCopilotAvailability } from "./lib/copilot.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// hooks.json declares the Stop hook's own timeout at 900s (15 min). This
// inner spawnSync timeout must leave real margin under that: after
// spawnSync returns (or is killed), this process still has to log premium
// usage, build the JSON decision payload, and flush stdout — and everything
// before spawnSync (reading stdin, resolving the workspace, the auth check)
// already ate into the outer budget. Setting this equal to the outer
// timeout means a genuine timeout reads as "no decision" (an unintended
// allow) instead of a block, which is the one failure mode the gate exists
// to avoid.
const STOP_REVIEW_TIMEOUT_MS = 14 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

async function buildSetupNote(cwd) {
  const availability = getCopilotAvailability(cwd);
  if (!availability.available) {
    return `Copilot is not set up for the review gate. ${availability.detail}. Run /copilot:setup.`;
  }

  const auth = await getCopilotAuthStatus(cwd);
  if (auth.loggedIn) {
    return null;
  }

  const detail = auth.detail ? ` ${auth.detail}.` : "";
  return `Copilot is not set up for the review gate.${detail} Run /copilot:setup and, if needed, !copilot login.`;
}

// Anything other than a well-formed ALLOW/BLOCK first line is treated as a
// failure and blocks the stop. A gate that silently allows on malformed
// output (empty, a preamble, a timeout, a failed run) is not a gate.
export function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Copilot review task returned no final output. Run /copilot:rescue --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Copilot stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Copilot review task returned an unexpected answer. Run /copilot:rescue --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "copilot-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Copilot review task timed out after 15 minutes. Run /copilot:rescue --wait manually or bypass the gate.",
      usage: null
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The stop-time Copilot review task failed: ${detail}`
        : "The stop-time Copilot review task failed. Run /copilot:rescue --wait manually or bypass the gate.",
      usage: null
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return { ...parseStopReviewOutput(payload?.rawOutput), usage: payload?.usage ?? null };
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Copilot review task returned invalid JSON. Run /copilot:rescue --wait manually or bypass the gate.",
      usage: null
    };
  }
}

// Every gate firing is a billable premium request against the user's Copilot
// quota, charged at the resolved task model's multiplier. Report what it
// actually cost rather than softening or omitting this.
function logPremiumUsage(usage) {
  if (!usage || typeof usage.premiumRequests !== "number") {
    return;
  }
  const modelNote = usage.model ? ` on ${usage.model}` : "";
  logNote(
    `Stop-time review gate consumed ${usage.premiumRequests} premium request(s)${modelNote} against your Copilot quota.`
  );
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Copilot task ${runningJob.id} is still running. Check /copilot:status and use /copilot:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = await buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  logPremiumUsage(review.usage);

  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // A gate whose failure mode is silent-allow is not a gate: an unrelated
    // internal crash (bad hook input, a state-file read failure, anything
    // before runStopReview) must still block, not just log and exit non-zero
    // with no decision on stdout.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    emitDecision({
      decision: "block",
      reason: `The stop-time review gate hit an unexpected internal error and cannot confirm the previous turn is safe to stop on: ${message}`
    });
    process.exitCode = 1;
  });
}
