import type { RunManifest } from "../types/index.js";
import type { NavigatorOutcome } from "../crawler/funnel_navigator.js";

export function printRunSummary(manifest: RunManifest, outcome: NavigatorOutcome, runDir: string): void {
  const { counts, milestones } = manifest;
  const lines = [
    "",
    "=== Funnel run summary ===",
    `run_id:     ${manifest.run_id}`,
    `funnel_id:  ${manifest.funnel_id}`,
    `mode:       ${manifest.mode}`,
    `state:      ${manifest.state}`,
    `status:     ${manifest.status}`,
    `business:   ${manifest.business_name ?? "unknown"}`,
    `start_url:  ${manifest.funnel_url}`,
    `pages:      ${counts.pages}   forms: ${counts.forms}   screenshots: ${counts.screenshots}`,
    "",
    "Milestones:",
    `  landing analysed:      ${tick(milestones.landing_analyzed)}`,
    `  form located:          ${tick(milestones.form_located)}`,
    `  form submitted:        ${tick(milestones.form_submitted)}`,
    `  scheduling detected:   ${tick(milestones.scheduling_detected)}`,
    `  booking confirmed:     ${tick(milestones.booking_confirmed)}`,
    `  confirmation analysed: ${tick(milestones.confirmation_analyzed)}`,
  ];

  if (outcome.manual_gates.length) {
    lines.push("", "Manual steps:");
    for (const gate of outcome.manual_gates) {
      lines.push(
        `  - ${gate.kind}: ${gate.status} via ${gate.signal} after ${Math.round(gate.waited_ms / 1000)}s`,
        `    ${gate.detail}`,
      );
    }
  }

  lines.push("", "Funnel path:");
  for (const step of outcome.report.funnel_path) {
    lines.push(`  ${step.label || step.page_type}\n    ${step.url}`);
  }

  const severities = counts.issues_by_severity;
  lines.push(
    "",
    `Issues: ${counts.issues} (critical ${severities.critical}, high ${severities.high}, medium ${severities.medium}, low ${severities.low})`,
  );
  const top = [...(outcome.landing?.detected_issues ?? []), ...(outcome.confirmation?.detected_issues ?? [])]
    .filter((issue) => issue.severity === "critical" || issue.severity === "high")
    .slice(0, 8);
  for (const issue of top) {
    lines.push(`  - [${issue.severity}] ${issue.page_role}: ${issue.title}`);
  }

  if (outcome.report.errors.length) {
    lines.push("", "Errors:");
    for (const error of outcome.report.errors) lines.push(`  - [${error.stage}] ${error.error}`);
  }

  if (manifest.notes.length) {
    lines.push("", "Notes:");
    for (const note of [...new Set(manifest.notes)]) lines.push(`  - ${note}`);
  }

  lines.push("", `Output: ${runDir}`, "");
  console.log(lines.join("\n"));
}

function tick(value: boolean): string {
  return value ? "yes" : "no";
}
