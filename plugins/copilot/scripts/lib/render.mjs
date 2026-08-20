import { DEFAULT_MAX_STATUS_JOBS } from "./job-control.mjs";
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

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

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

  if (!parsed.parsed) {
    lines.push("Copilot did not return parseable JSON.");
    lines.push("");
    lines.push(`Parse error: ${parsed.parseError}`);
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

export { formatUsage };
