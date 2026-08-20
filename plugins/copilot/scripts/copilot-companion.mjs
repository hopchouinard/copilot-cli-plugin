#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  getCopilotAvailability,
  getCopilotAuthStatus,
  fetchModelCatalog,
  runCopilotTurn,
  parseStructuredOutput,
  buildTaskSessionName,
  findLatestTaskSession,
  interruptCopilotTurn,
  DEFAULT_CONTINUE_PROMPT
} from "./lib/copilot.mjs";
import { buildTranscriptDigest, resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import {
  buildStatusSnapshot,
  buildSingleJobSnapshot,
  resolveResultJob,
  resolveCancelableJob,
  readStoredJob
} from "./lib/job-control.mjs";
import {
  resolveModel,
  validateEffort,
  readUserSettings,
  readRepoSettings,
  catalogHasModel,
  isCatalogStale,
  cheapestModel
} from "./lib/models.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import {
  renderSetupReport,
  renderReviewResult,
  renderTaskResult,
  renderStatusReport,
  renderJobStatusReport,
  renderStoredJobResult,
  renderCancelReport,
  renderTransferResult
} from "./lib/render.mjs";
import { generateJobId, getConfig, setConfig, upsertJob, writeJobFile } from "./lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { describeCost, exceedsThreshold } from "./lib/usage.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split("\n")
    .map((candidate) => candidate.trim())
    .find(Boolean);
  return line || fallback;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    return argv[0]?.trim() ? splitRawArgumentString(argv[0]) : [];
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), { ...config, aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) } });
}

export async function buildSetupReport(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actionsTaken = [];

  for (const [flag, key] of [
    ["model", null],
    ["review-model", "reviewModel"],
    ["task-model", "taskModel"]
  ]) {
    const value = options[flag];
    if (!value) {
      continue;
    }
    if (flag === "model") {
      setConfig(workspaceRoot, "reviewModel", value);
      setConfig(workspaceRoot, "taskModel", value);
      actionsTaken.push(`Set both review and task models to ${value}.`);
    } else {
      setConfig(workspaceRoot, key, value);
      actionsTaken.push(`Set ${key} to ${value}.`);
    }
  }

  if (options["cost-warn-threshold"] !== undefined) {
    // Fix: an unparseable value (e.g. "abc") used to serialize to `null`
    // via an unvalidated Number() coercion, which render.mjs then printed
    // as "warn  disabled" while actionsTaken reported success — silently
    // turning off the money guard instead of rejecting the bad input.
    const threshold = Number(options["cost-warn-threshold"]);
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new Error(
        `Invalid --cost-warn-threshold "${options["cost-warn-threshold"]}": expected a number >= 0 (use 0 to disable).`
      );
    }
    setConfig(workspaceRoot, "costWarnThreshold", threshold);
    actionsTaken.push(`Set the cost warning threshold to ${threshold}x.`);
  }

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push("Enabled the stop-time review gate.");
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push("Disabled the stop-time review gate.");
  }

  const node = binaryAvailable("node", ["--version"], { cwd });
  const npm = binaryAvailable("npm", ["--version"], { cwd });
  const copilot = getCopilotAvailability(cwd, options);
  const auth = copilot.available
    ? await getCopilotAuthStatus(cwd, options)
    : { available: false, loggedIn: false, detail: copilot.detail, authType: null, login: null, host: null };

  let config = getConfig(workspaceRoot);
  let modelCatalog = config.modelCatalog;

  if (copilot.available && (isCatalogStale(modelCatalog) || options.refreshCatalog)) {
    modelCatalog = await fetchModelCatalog(cwd, options);
    setConfig(workspaceRoot, "modelCatalog", modelCatalog);
    config = getConfig(workspaceRoot);
  }

  const userSettings = readUserSettings();
  const repoSettings = readRepoSettings(workspaceRoot);

  if (options.effort !== undefined) {
    // `effort` is ONE setting shared by both roles, so validating it against
    // the task model alone let setup persist a value the review model does
    // not accept — after which every review died in validateEffort before it
    // could run, with the failure surfacing far from the setup call that
    // caused it. Both resolved models have to accept it.
    for (const role of ["review", "task"]) {
      const probe = resolveModel({ role, config, env: process.env, repoSettings, userSettings });
      validateEffort(probe.model, options.effort, modelCatalog);
    }
    setConfig(workspaceRoot, "effort", options.effort);
    actionsTaken.push(`Set the default reasoning effort to ${options.effort}.`);
    config = getConfig(workspaceRoot);
  }

  const resolved = {
    review: resolveModel({ role: "review", config, env: process.env, repoSettings, userSettings }),
    task: resolveModel({ role: "task", config, env: process.env, repoSettings, userSettings }),
    effort: config.effort
  };

  const nextSteps = [];
  if (!copilot.available) {
    nextSteps.push("Install Copilot CLI with `npm install -g @github/copilot`.");
  } else if (!auth.loggedIn) {
    nextSteps.push("Run `!copilot login`.");
  }
  if (!config.reviewModel && !config.taskModel) {
    nextSteps.push("Pick models with `/copilot:setup --model <id>` so runs have a predictable cost.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: `/copilot:setup --enable-review-gate`. Each firing costs a premium request.");
  }

  return {
    ready: node.available && copilot.available && auth.loggedIn,
    node,
    npm,
    copilot,
    auth,
    modelCatalog,
    resolved,
    costWarnThreshold: config.costWarnThreshold,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "model", "review-model", "task-model", "effort", "cost-warn-threshold"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const report = await buildSetupReport(cwd, options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderSetupReport(report));
}

export function buildReviewPrompt(rootDir, context, { template, focusText }) {
  const schema = fs.readFileSync(path.join(rootDir, "schemas", "review-output.schema.json"), "utf8");
  return interpolateTemplate(loadPromptTemplate(rootDir, template), {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
    OUTPUT_SCHEMA: schema
  });
}

async function executeReview(cwd, options, { reviewLabel, template }) {
  ensureGitRepository(cwd);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const catalog = config.modelCatalog;

  const { model } = resolveModel({
    role: "review",
    flagModel: options.model,
    config,
    env: process.env,
    repoSettings: readRepoSettings(workspaceRoot),
    userSettings: readUserSettings()
  });
  const effort = validateEffort(model, options.effort ?? config.effort, catalog);

  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const context = collectReviewContext(cwd, target);
  const prompt = buildReviewPrompt(ROOT_DIR, context, {
    template,
    focusText: options.focusText ?? ""
  });

  const result = await runCopilotTurn(context.repoRoot, {
    prompt,
    model,
    effort,
    readOnly: true,
    sessionName: `${reviewLabel}: ${target.label}`,
    onProgress: options.onProgress,
    binary: options.binary,
    env: options.env
  });

  const parsed = parseStructuredOutput(result.finalMessage, {
    failureMessage: result.error?.message ?? result.stderr
  });

  return {
    exitStatus: result.status,
    sessionId: result.sessionId,
    payload: {
      review: reviewLabel,
      target,
      model,
      effort,
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError,
      usage: result.usage
    },
    rendered: renderReviewResult(parsed, {
      reviewLabel,
      targetLabel: target.label,
      costLabel: describeCost(model, catalog).label,
      usage: result.usage
    }),
    summary: `${reviewLabel}: ${target.label}`,
    usage: result.usage
  };
}

export async function executeTask(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const catalog = config.modelCatalog;

  const { model } = resolveModel({
    role: "task",
    flagModel: options.model,
    config,
    env: process.env,
    repoSettings: readRepoSettings(workspaceRoot),
    userSettings: readUserSettings()
  });
  const effort = validateEffort(model, options.effort ?? config.effort, catalog);

  // A background job pre-mints its Copilot session id at enqueue time (see
  // enqueueBackgroundTask) so /copilot:cancel can interrupt it before the
  // worker has reported a single progress event. That id names a session
  // Copilot has never seen — it must be *created* with that id
  // (runCopilotTurn's newSessionId), not resumed. --resume-last, by
  // contrast, looks up a session that genuinely already exists and must be
  // resumed (runCopilotTurn's sessionId) — the real Copilot CLI rejects
  // session.resume for an id it has never created. This is deliberately
  // named copilotSessionId, not sessionId: job records reserve `sessionId`
  // for the Claude Code session id (see createJobRecord/SESSION_ID_ENV),
  // and conflating the two silently breaks per-session job filtering.
  const presetSessionId = options.copilotSessionId ?? null;
  let resumeSessionId = null;
  if (options.resumeLast) {
    const latest = await findLatestTaskSession(workspaceRoot, options);
    if (!latest) {
      throw new Error("No previous Copilot task session was found for this repository.");
    }
    resumeSessionId = latest.sessionId;
  }

  if (!options.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runCopilotTurn(workspaceRoot, {
    sessionId: resumeSessionId,
    newSessionId: presetSessionId,
    prompt: options.prompt,
    defaultPrompt: resumeSessionId ? DEFAULT_CONTINUE_PROMPT : "",
    model,
    effort,
    readOnly: !options.write,
    sessionName: resumeSessionId ? null : buildTaskSessionName(options.prompt),
    onProgress: options.onProgress,
    binary: options.binary,
    env: options.env
  });

  return {
    exitStatus: result.status,
    sessionId: result.sessionId,
    payload: {
      model,
      effort,
      mode: result.mode,
      sessionId: result.sessionId,
      rawOutput: result.finalMessage,
      touchedFiles: result.touchedFiles,
      usage: result.usage
    },
    rendered: renderTaskResult(result, { model, catalog, write: Boolean(options.write) }),
    summary: firstMeaningfulLine(result.finalMessage, options.prompt || "Copilot Task finished."),
    usage: result.usage
  };
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "copilot-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

// Exported so a test can assert the store/spawn ordering directly instead
// of racing a real detached worker.
export function enqueueBackgroundTask(cwd, workspaceRoot, options, prompt, resumeLast) {
  // Mint the Copilot session id now, before the worker process exists, so a
  // stored-but-not-yet-running job still carries the id /copilot:cancel
  // needs to interrupt it (spec §6.6 / §3.2). This is stored as
  // `copilotSessionId`, not `sessionId` — createJobRecord already uses
  // `sessionId` for the Claude Code session id (from SESSION_ID_ENV), which
  // filterJobsForCurrentSession and Task 13's SessionEnd reaping key off of.
  // Conflating the two would make per-session job filtering silently match
  // nothing.
  const copilotSessionId = randomUUID();
  const write = Boolean(options.write);

  const job = createJobRecord({
    id: generateJobId("task"),
    kind: "task",
    kindLabel: "rescue",
    title: "Copilot Task",
    workspaceRoot,
    jobClass: "task",
    summary: prompt || (resumeLast ? "Resume previous task" : "Task"),
    write,
    copilotSessionId
  });

  const logFile = createJobLogFile(job.workspaceRoot, job.id, job.title);
  appendLogLine(logFile, "Queued for background execution.");

  const request = {
    model: options.model,
    effort: options.effort,
    prompt,
    write,
    resumeLast,
    copilotSessionId
  };

  // Publish the job BEFORE the worker exists. Spawning first left a window
  // in which the detached child could reach handleTaskWorker, find no stored
  // job, and exit with its stdio discarded — after which the parent wrote a
  // queued record for a worker that was already dead, leaving a job stuck in
  // the queue forever with no error anywhere. The pid is patched in once the
  // child is running.
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  // Injectable so a test can observe the store at the exact moment the
  // worker would start, which is the invariant this ordering exists to hold.
  const spawnWorker = options.spawnWorker ?? spawnDetachedTaskWorker;
  const child = spawnWorker(cwd, job.id);
  const startedRecord = { ...queuedRecord, pid: child?.pid ?? null };
  writeJobFile(job.workspaceRoot, job.id, startedRecord);
  upsertJob(job.workspaceRoot, { id: job.id, pid: startedRecord.pid });

  return startedRecord;
}

// Fix M1: every documented rescue flow lands in the foreground path —
// commands/rescue.md and the copilot-cli-runtime skill both instruct the
// subagent to strip --background before calling `task`, so enqueueBackgroundTask
// below is effectively unreachable in practice. This routes the foreground
// path through the same job-tracking machinery handleReview uses
// (runTrackedJob), so a foreground rescue run appears in /copilot:status,
// can be interrupted by /copilot:cancel, and its spend reaches the session
// total — previously this path called executeTask directly with no job
// record at all. Exported (mirroring executeTask/executeTransfer) so tests
// can exercise the tracking wiring directly with an injected fixture binary.
export async function executeTrackedTask(cwd, options = {}) {
  const { prompt = "", resumeLast = false } = options;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const write = Boolean(options.write);
  const job = createJobRecord({
    id: generateJobId("task"),
    kind: "task",
    kindLabel: "rescue",
    title: "Copilot Task",
    workspaceRoot,
    jobClass: "task",
    summary: prompt || (resumeLast ? "Resume previous task" : "Task"),
    write
  });
  const logFile = createJobLogFile(job.workspaceRoot, job.id, job.title);
  const onProgress = createProgressReporter({
    logFile,
    onEvent: createJobProgressUpdater(workspaceRoot, job.id)
  });

  return runTrackedJob(
    { ...job, logFile },
    () => executeTask(cwd, { ...options, prompt, resumeLast, onProgress }),
    { logFile }
  );
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd"],
    booleanOptions: ["json", "write", "resume-last", "background", "wait"]
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const prompt = positionals.join(" ").trim();
  const resumeLast = Boolean(options["resume-last"]);

  if (options.background) {
    if (!prompt && !resumeLast) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
    }
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const job = enqueueBackgroundTask(cwd, workspaceRoot, options, prompt, resumeLast);
    const rendered = `${job.title} started in the background as ${job.id}. Check /copilot:status ${job.id} for progress.\n`;
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ jobId: job.id, status: "queued", copilotSessionId: job.copilotSessionId }, null, 2)}\n`
        : rendered
    );
    return;
  }

  const execution = await executeTrackedTask(cwd, { ...options, prompt, resumeLast });
  process.stdout.write(options.json ? `${JSON.stringify(execution.payload, null, 2)}\n` : execution.rendered);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const logFile = storedJob.logFile ?? createJobLogFile(workspaceRoot, storedJob.id, storedJob.title);
  const onProgress = createProgressReporter({
    logFile,
    onEvent: createJobProgressUpdater(workspaceRoot, storedJob.id)
  });

  // The worker must reuse the pre-minted copilotSessionId carried on the
  // stored job/request rather than letting executeTask mint a second one,
  // or a cancel issued before this line would target an id the worker
  // never actually uses.
  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () => executeTask(workspaceRoot, { ...request, onProgress }),
    { logFile }
  );
}

export async function findTaskResumeCandidate(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  let candidate = null;
  try {
    candidate = await findLatestTaskSession(workspaceRoot, options);
  } catch {
    candidate = null;
  }

  return { available: Boolean(candidate), sessionId: candidate?.sessionId ?? null };
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const report = await findTaskResumeCandidate(cwd, options);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${report.available ? `A resumable task session is available: ${report.sessionId}` : "No resumable task session was found."}\n`
  );
}

export async function buildCostCheck(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  let catalog = config.modelCatalog;

  const { model, source } = resolveModel({
    role: options.role === "review" ? "review" : "task",
    flagModel: options.model,
    config,
    env: process.env,
    repoSettings: readRepoSettings(workspaceRoot),
    userSettings: readUserSettings()
  });

  // This is the last checkpoint before a paid background run, and it was
  // pricing that run off whatever the cache happened to hold: a catalog past
  // its TTL, or one that predates the model the user just named. Both make
  // describeCost report "cost unknown", and an unknown multiplier used to
  // make exceedsThreshold return false — the expensive-run confirmation was
  // skipped precisely when the plugin knew least about the cost. Refresh
  // first when the cache cannot answer for this model.
  let catalogRefreshed = false;
  if (options.refreshCatalog !== false && (isCatalogStale(catalog) || !catalogHasModel(model, catalog))) {
    try {
      catalog = await fetchModelCatalog(cwd, options);
      setConfig(workspaceRoot, "modelCatalog", catalog);
      catalogRefreshed = true;
    } catch {
      // Copilot unreachable or too old. Keep the cached catalog; the
      // unknown-cost branch below is the fail-safe.
      catalog = config.modelCatalog;
    }
  }

  const cost = describeCost(model, catalog);
  const cheapest = cheapestModel(catalog);
  const thresholdActive = Number.isFinite(Number(config.costWarnThreshold)) && Number(config.costWarnThreshold) > 0;
  const costUnknown = typeof cost.multiplier !== "number";

  return {
    model,
    source,
    label: cost.label,
    multiplier: cost.multiplier,
    threshold: config.costWarnThreshold,
    // A cost we cannot establish is treated as expensive while the guard is
    // on. Confirming a run that turns out to be cheap wastes one question;
    // skipping the question on a run that turns out to be 14x does not.
    exceeds: costUnknown ? thresholdActive : exceedsThreshold(model, catalog, config.costWarnThreshold),
    costUnknown,
    catalogRefreshed,
    cheapest,
    cheapestLabel: cheapest ? describeCost(cheapest, catalog).label : null
  };
}

async function handleCostCheck(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["role", "model", "cwd"],
    booleanOptions: ["json"]
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const check = await buildCostCheck(cwd, options);
  process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const reference = positionals.join(" ").trim();

  if (reference) {
    const { job } = buildSingleJobSnapshot(cwd, reference);
    process.stdout.write(options.json ? `${JSON.stringify(job, null, 2)}\n` : renderJobStatusReport(job));
    return;
  }

  const all = Boolean(options.all);
  const report = buildStatusSnapshot(cwd, { all });
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : renderStatusReport({ ...report, all })
  );
}

async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const reference = positionals.join(" ").trim();

  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);

  process.stdout.write(
    options.json ? `${JSON.stringify({ job, storedJob }, null, 2)}\n` : renderStoredJobResult(job, storedJob)
  );
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const reference = positionals.join(" ").trim();

  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);

  // Interrupt the remote Copilot turn *before* killing the local worker
  // process — otherwise Copilot keeps burning premium requests on work
  // nobody is going to read after the worker is already dead.
  await interruptCopilotTurn(workspaceRoot, { sessionId: job.copilotSessionId });
  terminateProcessTree(job.pid);

  const completedAt = new Date().toISOString();
  const cancelledPatch = { id: job.id, status: "cancelled", phase: "cancelled", pid: null, completedAt };
  upsertJob(workspaceRoot, cancelledPatch);

  const storedJob = readStoredJob(workspaceRoot, job.id);
  if (storedJob) {
    writeJobFile(workspaceRoot, job.id, { ...storedJob, ...cancelledPatch });
  }

  const cancelledJob = { ...job, ...cancelledPatch };
  process.stdout.write(options.json ? `${JSON.stringify(cancelledJob, null, 2)}\n` : renderCancelReport(cancelledJob));
}

async function handleReview(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"]
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const focusText = positionals.join(" ").trim();

  if (focusText && !config.allowFocus) {
    throw new Error(
      `\`/copilot:review\` does not take focus text. Use \`/copilot:adversarial-review ${focusText}\` instead.`
    );
  }

  // Fix B (Task 16 follow-up): route reviews through the same job-tracking
  // machinery `task` uses (runTrackedJob), so a review — foreground or
  // backgrounded by Claude Code's Bash tool — appears in `/copilot:status`
  // and its result is retrievable via `/copilot:result`, exactly as
  // review.md tells the user it will. Previously executeReview ran with no
  // job record at all: status/result could never show a review.
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobKind = config.template === "adversarial-review" ? "adversarial-review" : "review";
  const job = createJobRecord({
    id: generateJobId("review"),
    kind: jobKind,
    kindLabel: jobKind,
    title: config.reviewLabel,
    workspaceRoot,
    jobClass: "review",
    summary: config.reviewLabel
  });
  const logFile = createJobLogFile(job.workspaceRoot, job.id, job.title);
  const onProgress = createProgressReporter({
    logFile,
    onEvent: createJobProgressUpdater(workspaceRoot, job.id)
  });

  const execution = await runTrackedJob(
    { ...job, logFile },
    () => executeReview(cwd, { ...options, focusText, onProgress }, config),
    { logFile }
  );
  process.stdout.write(options.json ? `${JSON.stringify(execution.payload, null, 2)}\n` : execution.rendered);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}

export async function executeTransfer(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const catalog = config.modelCatalog;

  const jsonlPath = resolveClaudeSessionPath(cwd, { source: options.source });
  const digest = buildTranscriptDigest(jsonlPath);

  const { model } = resolveModel({
    role: "task",
    flagModel: options.model,
    config,
    env: process.env,
    repoSettings: readRepoSettings(workspaceRoot),
    userSettings: readUserSettings()
  });
  const effort = validateEffort(model, options.effort ?? config.effort, catalog);

  // Mint a brand-new Copilot session id for the transfer and pass it as
  // newSessionId (session.create), never as sessionId (session.resume) —
  // this id has never existed in Copilot before this call, and the real
  // Copilot CLI rejects session.resume for an id it never created (verified
  // against 1.0.80: "Session not found"). See runCopilotTurn in
  // lib/copilot.mjs for the same distinction on the background-task path.
  const copilotSessionId = randomUUID();

  const prompt = `${digest.markdown}\n\nAcknowledge that you've received this briefing, then wait for further instructions from the user before taking any action.`;

  const result = await runCopilotTurn(workspaceRoot, {
    newSessionId: copilotSessionId,
    prompt,
    model,
    effort,
    readOnly: true,
    sessionName: "Transferred Claude Code session",
    onProgress: options.onProgress,
    binary: options.binary,
    env: options.env
  });

  return {
    exitStatus: result.status,
    // result.sessionId is what runCopilotTurn actually used when talking to
    // Copilot (it echoes back options.newSessionId here) — printing that,
    // rather than the copilotSessionId variable above, guarantees the id in
    // the resume command is the one Copilot will actually accept even if
    // this function's minting logic ever changes.
    copilotSessionId: result.sessionId,
    payload: {
      model,
      effort,
      copilotSessionId: result.sessionId,
      resumeCommand: `copilot --resume=${result.sessionId}`,
      source: jsonlPath,
      goal: digest.goal,
      filesTouched: digest.filesTouched,
      commands: digest.commands,
      acknowledgment: result.finalMessage,
      mode: result.mode,
      usage: result.usage
    },
    rendered: renderTransferResult(result, { model, catalog }),
    usage: result.usage
  };
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source", "model", "effort"],
    booleanOptions: ["json"]
  });

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const execution = await executeTransfer(cwd, options);
  process.stdout.write(options.json ? `${JSON.stringify(execution.payload, null, 2)}\n` : execution.rendered);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv, { reviewLabel: "Review", template: "review", allowFocus: false });
      break;
    case "adversarial-review":
      await handleReview(argv, { reviewLabel: "Adversarial Review", template: "adversarial-review", allowFocus: true });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "task-resume-candidate":
      await handleTaskResumeCandidate(argv);
      break;
    case "cost-check":
      await handleCostCheck(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      await handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand ?? "(none)"}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
