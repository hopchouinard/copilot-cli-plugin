#!/usr/bin/env node
import path from "node:path";
import process from "node:process";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { getCopilotAvailability, getCopilotAuthStatus, fetchModelCatalog } from "./lib/copilot.mjs";
import { resolveModel, validateEffort, readUserSettings, readRepoSettings, isCatalogStale } from "./lib/models.mjs";
import { getConfig, setConfig } from "./lib/state.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import { renderSetupReport } from "./lib/render.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

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

  if (options.effort !== undefined) {
    const probe = resolveModel({ role: "task", config, env: process.env });
    validateEffort(probe.model, options.effort, modelCatalog);
    setConfig(workspaceRoot, "effort", options.effort);
    actionsTaken.push(`Set the default reasoning effort to ${options.effort}.`);
    config = getConfig(workspaceRoot);
  }

  const userSettings = readUserSettings();
  const repoSettings = readRepoSettings(workspaceRoot);
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

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
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
