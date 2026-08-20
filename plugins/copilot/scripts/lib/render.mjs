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

export { formatUsage };
