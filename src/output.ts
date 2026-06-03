import type { ChangeSet, DoctorReport, PlanReport, VerifyReport } from "./types.js";
import type { CostReport } from "./cost.js";
import type { DeployReport } from "./deploy.js";
import type { ProvisionReport } from "./provision.js";

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printDoctor(report: DoctorReport): void {
  console.log("Flarecel Doctor");
  console.log("");
  console.log(`Project: ${report.project.name ?? "unknown"}`);
  console.log(`Framework: ${report.project.framework}`);
  console.log(`Readiness: ${report.readinessScore}/100`);
  console.log(`Status: ${report.status}`);
  console.log("");

  if (report.issues.length === 0) {
    console.log("No issues found.");
  } else {
    console.log("Issues:");
    for (const issue of report.issues) {
      const file = issue.file ? ` (${issue.file})` : "";
      console.log(`- [${issue.severity}] ${issue.title}${file}`);
      console.log(`  ${issue.message}`);
      if (issue.recommendedCommand) console.log(`  Next: ${issue.recommendedCommand}`);
    }
  }

  printNextActions(report.nextActions);
}

export function printPlan(report: PlanReport): void {
  console.log("Flarecel Plan");
  console.log("");
  console.log(`Project: ${report.project.name ?? "unknown"}`);
  console.log(`Status: ${report.status}`);
  console.log("");

  for (const [index, step] of report.steps.entries()) {
    console.log(`${index + 1}. [${step.status}] ${step.title}`);
    console.log(`   ${step.reason}`);
    if (step.command) console.log(`   ${step.command}`);
  }

  printNextActions(report.nextActions);
}

export function printChangeSet(changeSet: ChangeSet): void {
  console.log(changeSet.title);
  console.log("");

  if (changeSet.changes.length === 0) {
    console.log("No file changes planned.");
  } else {
    console.log("Planned file changes:");
    for (const change of changeSet.changes) {
      console.log(`- ${change.path}: ${change.reason}`);
    }
  }

  if (changeSet.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of changeSet.warnings) console.log(`- ${warning}`);
  }

  printNextActions(changeSet.nextActions);
}

export function printVerify(report: VerifyReport): void {
  console.log("Flarecel Verify");
  console.log("");
  console.log(`Project: ${report.project.name ?? "unknown"}`);
  console.log(`Status: ${report.status}`);
  console.log("");

  for (const check of report.checks) {
    console.log(`- [${check.status}] ${check.id}: ${check.message}`);
  }

  printNextActions(report.nextActions);
}

export function printProvision(report: ProvisionReport): void {
  console.log("Flarecel Provision");
  console.log("");
  console.log(`Status: ${report.status}`);
  console.log("");

  if (report.actions.length === 0) {
    console.log("No Cloudflare resource actions found.");
  } else {
    for (const action of report.actions) {
      const command = action.command.length > 0 ? `\n   ${action.command.join(" ")}` : "";
      console.log(`- [${action.status}] ${action.title}${command}`);
      console.log(`  ${action.reason}`);
      if (action.stderr) console.log(`  stderr: ${action.stderr.trim()}`);
    }
  }

  if (report.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of report.warnings) console.log(`- ${warning}`);
  }

  printNextActions(report.nextActions);
}

export function printCost(report: CostReport): void {
  console.log("Flarecel Cost");
  console.log("");
  console.log(`Project: ${report.project.name ?? "unknown"}`);
  console.log(`Plan: ${report.plan}`);
  console.log(`Estimated monthly cost: $${report.estimatedMonthlyUsd.toFixed(2)} ${report.currency}`);
  console.log("");

  for (const item of report.lineItems) {
    console.log(`- ${item.label}: $${item.estimatedUsd.toFixed(2)}`);
    console.log(`  ${item.usage} ${item.unit}; billable ${item.billable}`);
  }

  if (report.vercelComparison) {
    const v = report.vercelComparison;
    const cheaper = v.monthlyDeltaUsd >= 0 ? "cheaper on Cloudflare" : "cheaper on Vercel";
    console.log("");
    console.log("Vercel comparison (EXPERIMENTAL):");
    console.log(`  ${v.disclaimer}`);
    console.log(`  Vercel (${v.source}): $${v.vercelMonthlyUsd.toFixed(2)} / Cloudflare: $${v.cloudflareMonthlyUsd.toFixed(2)}`);
    console.log(`  Delta: $${Math.abs(v.monthlyDeltaUsd).toFixed(2)} ${cheaper}`);
  }

  if (report.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of report.warnings) console.log(`- ${warning}`);
  }

  console.log("");
  console.log("Sources:");
  for (const source of report.sources) console.log(`- ${source.name}: ${source.url}`);

  printNextActions(report.nextActions);
}

export function printDeploy(report: DeployReport): void {
  console.log("Flarecel Deploy");
  console.log("");
  console.log(`Mode: ${report.mode}`);
  console.log(`Status: ${report.status}`);
  console.log(`Verify: ${report.verifyStatus}`);
  console.log(`Command: ${report.command.join(" ") || "unknown"}`);
  console.log("");

  if (report.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of report.warnings) console.log(`- ${warning}`);
    console.log("");
  }

  if (report.cost) {
    console.log(`Estimated monthly cost before production: $${report.cost.estimatedMonthlyUsd.toFixed(2)} ${report.cost.currency}`);
    console.log("");
  }

  if (report.stdout) {
    console.log("stdout:");
    console.log(report.stdout.trim());
    console.log("");
  }

  if (report.stderr) {
    console.log("stderr:");
    console.log(report.stderr.trim());
    console.log("");
  }

  printNextActions(report.nextActions);
}

function printNextActions(actions: string[]): void {
  if (actions.length === 0) return;

  console.log("");
  console.log("Next actions:");
  for (const action of actions) console.log(`- ${action}`);
}
