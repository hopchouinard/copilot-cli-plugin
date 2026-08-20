import { DEFAULT_MAX_STATUS_JOBS } from "./job-control.mjs";
import { orderedCatalogModels } from "./models.mjs";
import { describeCost, formatUsage } from "./usage.mjs";

function line(label, value) {
  return `${label.padEnd(8)}${value}`;
}

export function renderSetupReport(report) {
  const lines = [];

  lines.push(report.ready ? "Copilot is ready." : "Copilot is not ready yet.");
  lines.push("");
  lines.push(line("node", report.node.detail));
  lines.push(line("copilot", report.copilot.detail));
  lines.push(line("auth", report.auth.detail));
  lines.push("");

  for (const role of ["review", "task"]) {
    const resolved = report.resolved[role];
    const cost = describeCost(resolved.model, report.modelCatalog);
    const multiplier = typeof cost.multiplier === "number" ? `${cost.multiplier}x` : "-";
    lines.push(`${role.padEnd(8)}${resolved.model.padEnd(24)}${multiplier.padEnd(8)}from ${resolved.source}`);
  }

  lines.push(line("effort", report.resolved.effort ?? "(model default)"));
  lines.push(line("warn", report.costWarnThreshold > 0 ? `at ${report.costWarnThreshold}x` : "disabled"));
  lines.push(line("gate", report.reviewGateEnabled ? "enabled" : "disabled"));

  if (report.actionsTaken.length > 0) {
    lines.push("");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
  }

  if (report.nextSteps.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

// The numbered model table. Replaces a 4-option picker that could only ever
// offer a third of the roster: an AskUserQuestion caps at four choices, so
// eight of twelve models were unreachable except by the user knowing an id to
// type into "Other". A table has no such cap, and the row number is what the
// user types back.
//
// The ordering comes from orderedCatalogModels so the number shown here is the
// number resolveModelSelection maps back — the two cannot drift apart.
export function renderModelTable(catalog, options = {}) {
  const models = orderedCatalogModels(catalog);
  if (models.length === 0) {
    return "No model catalog is cached. Run `/copilot:setup` while Copilot is reachable to fetch one.\n";
  }

  const inUse = new Map();
  for (const [role, model] of [
    ["review", options.review],
    ["task", options.task]
  ]) {
    if (!model) {
      continue;
    }
    inUse.set(model, [...(inUse.get(model) ?? []), role]);
  }

  const rows = models.map((model, index) => ({
    number: String(index + 1),
    id: String(model.id),
    cost:
      typeof model.multiplier === "number"
        ? `${model.multiplier}x`
        : typeof model.discountPercent === "number"
          ? `${model.discountPercent}% off`
          : "unknown",
    efforts: (model.reasoningEfforts ?? []).join(", ") || "(none)",
    inUse: (inUse.get(model.id) ?? []).join(", ")
  }));

  const width = (key, header) => Math.max(header.length, ...rows.map((row) => row[key].length));
  const numberWidth = width("number", "#");
  const idWidth = width("id", "MODEL");
  const costWidth = width("cost", "COST");
  const effortsWidth = width("efforts", "EFFORT LEVELS");

  const formatRow = (number, id, cost, efforts, mark) =>
    [
      number.padStart(numberWidth),
      id.padEnd(idWidth),
      cost.padEnd(costWidth),
      mark ? efforts.padEnd(effortsWidth) : efforts,
      mark
    ]
      .filter((cell) => cell !== "")
      .join("  ")
      .trimEnd();

  const anyInUse = rows.some((row) => row.inUse);
  const tableLines = [formatRow("#", "MODEL", "COST", "EFFORT LEVELS", anyInUse ? "IN USE" : "")];
  for (const row of rows) {
    tableLines.push(formatRow(row.number, row.id, row.cost, row.efforts, anyInUse ? row.inUse : ""));
  }

  tableLines.push("");
  tableLines.push(`Reply with a number (1-${rows.length}) or a model id.`);
  return `${tableLines.join("\n")}\n`;
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

// Copilot has no output-schema parameter, so the review contract is enforced
// by the prompt alone and `JSON.parse` succeeding proves nothing about shape.
// Valid-but-wrong JSON — `findings` as an object, or a bare string — used to
// reach the renderer, where spreading a non-iterable threw AFTER the premium
// request had already been paid for: the job was marked failed and the raw
// review the user paid for was discarded. Anything that does not conform is
// routed down the existing raw-output path instead, so the text always
// survives.
export function describeReviewShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "expected a JSON object";
  }
  if (value.findings !== undefined && !Array.isArray(value.findings)) {
    return "`findings` must be an array";
  }
  if (value.next_steps !== undefined && !Array.isArray(value.next_steps)) {
    return "`next_steps` must be an array";
  }
  if (typeof value.verdict !== "string" || !value.verdict.trim()) {
    return "`verdict` must be a non-empty string";
  }
  if (typeof value.summary !== "string") {
    return "`summary` must be a string";
  }
  for (const [index, finding] of (value.findings ?? []).entries()) {
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
      return `findings[${index}] must be an object`;
    }
  }
  return null;
}

export function renderReviewResult(parsed, options = {}) {
  const lines = [`# ${options.reviewLabel} — ${options.targetLabel}`, ""];

  if (options.costLabel) {
    lines.push(`model  ${options.costLabel}`);
  }
  const usageLine = formatUsage(options.usage);
  if (usageLine) {
    lines.push(`usage  ${usageLine}`);
  }
  if (options.costLabel || usageLine) {
    lines.push("");
  }

  const shapeError = parsed.parsed ? describeReviewShape(parsed.parsed) : null;
  if (!parsed.parsed || shapeError) {
    lines.push("Copilot did not return parseable JSON.");
    lines.push("");
    lines.push(`Parse error: ${shapeError ? `response did not match the review schema: ${shapeError}` : parsed.parseError}`);
    lines.push("");
    lines.push("Raw output:");
    lines.push("");
    lines.push(parsed.rawOutput);
    return `${lines.join("\n")}\n`;
  }

  const result = parsed.parsed;
  lines.push(`Verdict: ${result.verdict}`);
  lines.push("");
  lines.push(result.summary);
  lines.push("");

  const findings = [...(result.findings ?? [])].sort(
    (left, right) => (SEVERITY_ORDER[left.severity] ?? 9) - (SEVERITY_ORDER[right.severity] ?? 9)
  );

  if (findings.length === 0) {
    lines.push("No findings.");
  } else {
    for (const finding of findings) {
      lines.push(`## [${finding.severity}] ${finding.title}`);
      lines.push(`${finding.file}:${finding.line_start}-${finding.line_end} (confidence ${finding.confidence})`);
      lines.push("");
      lines.push(finding.body);
      lines.push("");
      lines.push(`Recommendation: ${finding.recommendation}`);
      lines.push("");
    }
  }

  if ((result.next_steps ?? []).length > 0) {
    lines.push("## Next steps");
    for (const step of result.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderTaskResult(result, options = {}) {
  const lines = [`# Copilot Task`, ""];
  lines.push(`model  ${describeCost(options.model, options.catalog).label}`);
  const usageLine = formatUsage(result.usage);
  if (usageLine) {
    lines.push(`usage  ${usageLine}`);
  }
  lines.push("");
  lines.push(result.finalMessage || "(no output)");
  if (options.write && result.touchedFiles.length > 0) {
    lines.push("");
    lines.push("Copilot edited these files:");
    for (const file of result.touchedFiles) {
      lines.push(`- ${file}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderStatusReport(report) {
  const allJobs = report.jobs ?? [];
  // --all shows every retained job; without it, cap the table to the same
  // compact window buildStatusSnapshot uses for `recent`, so the flag
  // actually changes what's rendered instead of being silently ignored.
  const jobs = report.all ? allJobs : allJobs.slice(0, DEFAULT_MAX_STATUS_JOBS);

  const rows = [
    "| job | kind | status | phase | premium | summary |",
    "| --- | --- | --- | --- | --- | --- |"
  ];

  for (const job of jobs) {
    const premium = typeof job.usage?.premiumRequests === "number" ? String(job.usage.premiumRequests) : "-";
    rows.push(
      `| ${job.id} | ${job.kindLabel ?? job.kind ?? "-"} | ${job.status} | ${job.phase ?? "-"} | ${premium} | ${job.summary ?? "-"} |`
    );
  }

  if (jobs.length === 0) {
    rows.push("| - | - | - | - | - | no jobs for this session |");
  }

  const lines = [rows.join("\n")];
  if (report.usageTotal) {
    lines.push("");
    lines.push(
      `Session total: ${report.usageTotal.premiumRequests} premium request${report.usageTotal.premiumRequests === 1 ? "" : "s"} across ${report.usageTotal.jobs} job${report.usageTotal.jobs === 1 ? "" : "s"}.`
    );
  }

  return `${lines.join("\n")}\n`;
}

export function renderJobStatusReport(job) {
  const lines = [`# ${job.title ?? job.id}`, ""];
  lines.push(`id      ${job.id}`);
  lines.push(`status  ${job.status}`);
  lines.push(`phase   ${job.phase ?? "-"}`);
  if (job.sessionId) {
    lines.push(`session ${job.sessionId}`);
  }
  const usageLine = formatUsage(job.usage);
  if (usageLine) {
    lines.push(`usage   ${usageLine}`);
  }
  if (job.errorMessage) {
    lines.push("");
    lines.push(`Error: ${job.errorMessage}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  if (!storedJob?.rendered) {
    return renderJobStatusReport(job);
  }
  const usageLine = formatUsage(storedJob.usage ?? job.usage);
  const suffix = usageLine ? `\nusage  ${usageLine}\n` : "";
  // The resume line must use the Copilot RPC session id (copilotSessionId),
  // never the Claude Code session id (sessionId) that job filtering keys
  // off of — crossing them is the exact defect this project has already
  // shipped once (see job-control.mjs / tracked-jobs.mjs comments).
  const resume = job.copilotSessionId
    ? `\nResume in Copilot: copilot --resume=${job.copilotSessionId}\n`
    : "";
  return `${storedJob.rendered}${suffix}${resume}`;
}

export function renderCancelReport(job) {
  return `Cancelled ${job.id} (${job.title ?? job.kind ?? "job"}).\n`;
}

export function renderTransferResult(result, options = {}) {
  const lines = [
    "# Copilot session transfer",
    "",
    "This is a **primer**, not replayed turn history. GitHub Copilot CLI has no",
    "session-import API, so the Claude Code conversation was condensed into a",
    "briefing and sent as the opening message of a new Copilot session. Copilot",
    "does not know your prior turns beyond what that briefing describes.",
    "",
    "The briefing includes commands recorded during this session. Values that",
    "look like credentials (Authorization headers, Bearer tokens, and",
    "TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL-named assignments) are redacted before",
    "sending, on a best-effort basis. This is pattern matching, not a guarantee",
    "— review the commands yourself if you're not sure they're clean.",
    "",
    `model  ${describeCost(options.model, options.catalog).label}`
  ];
  const usageLine = formatUsage(result.usage);
  if (usageLine) {
    lines.push(`usage  ${usageLine}`);
  }
  lines.push("");
  lines.push(`Copilot session ID: ${result.sessionId}`);
  lines.push("");
  lines.push("Resume it with:");
  lines.push("");
  lines.push(`  copilot --resume=${result.sessionId}`);
  lines.push("");
  lines.push("Copilot's acknowledgment:");
  lines.push("");
  lines.push(result.finalMessage || "(no acknowledgment captured)");
  return `${lines.join("\n")}\n`;
}

export { formatUsage };
