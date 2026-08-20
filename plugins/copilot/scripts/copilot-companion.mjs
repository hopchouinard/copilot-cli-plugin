#!/usr/bin/env node
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
  buildTaskSessionName
} from "./lib/copilot.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { resolveModel, validateEffort, readUserSettings, readRepoSettings, isCatalogStale } from "./lib/models.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, setConfig } from "./lib/state.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import { renderSetupReport, renderReviewResult } from "./lib/render.mjs";
import { describeCost } from "./lib/usage.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

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
    setConfig(workspaceRoot, "costWarnThreshold", Number(options["cost-warn-threshold"]));
    actionsTaken.push(`Set the cost warning threshold to ${options["cost-warn-threshold"]}x.`);
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
    const probe = resolveModel({ role: "task", config, env: process.env, repoSettings, userSettings });
    validateEffort(probe.model, options.effort, modelCatalog);
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
    usage: result.usage
  };
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

  const execution = await executeReview(cwd, { ...options, focusText }, config);
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
