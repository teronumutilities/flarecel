import type { ChangeSet, DoctorReport, PlanReport, VerifyReport } from "./types.js";
import type { CostReport } from "./cost.js";
import type { DeployReport } from "./deploy.js";
import type { ProvisionReport } from "./provision.js";
import { c, sym, banner, box, bar, rule, statusLabel, severityIcon, label } from "./ui.js";

// JSON output is NEVER styled — agents depend on byte-clean output.
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printDoctor(report: DoctorReport): void {
  console.log(banner("Cloudflare readiness"));
  console.log("");
  console.log(box([
    `${label("Project")} ${c.bold(report.project.name ?? "unknown")}   ${label("Framework")} ${c.cyan(report.project.framework)}`,
    `${label("Readiness")} ${bar(report.readinessScore)}`,
    `${label("Status")} ${statusLabel(report.status)}`
  ]));
  console.log("");

  if (report.issues.length === 0) {
    console.log(`${c.green(sym.ok)} No issues found.`);
  } else {
    console.log(c.bold(`Issues ${c.dim(`(${report.issues.length})`)}`));
    for (const issue of report.issues) {
      const file = issue.file ? c.gray(` (${issue.file})`) : "";
      console.log(`${severityIcon(issue.severity)} ${c.bold(issue.title)} ${c.dim(`[${issue.severity}]`)}${file}`);
      console.log(`  ${c.gray(issue.message)}`);
      if (issue.recommendedCommand) console.log(`  ${c.dim(sym.arrow)} ${c.cyan(issue.recommendedCommand)}`);
    }
  }

  printNextActions(report.nextActions);
}

export function printPlan(report: PlanReport): void {
  console.log(banner("Migration plan"));
  console.log("");
  console.log(`${label("Project")} ${c.bold(report.project.name ?? "unknown")}   ${label("Status")} ${statusLabel(report.status)}`);
  console.log("");

  for (const [index, step] of report.steps.entries()) {
    const icon = step.status === "done" ? c.green(sym.ok) : step.status === "manual" ? c.yellow(sym.warn) : c.gray(sym.pending);
    console.log(`${icon} ${c.dim(`${index + 1}.`)} ${c.bold(step.title)} ${c.dim(`[${step.status}]`)}`);
    console.log(`   ${c.gray(step.reason)}`);
    if (step.command) console.log(`   ${c.cyan(step.command)}`);
  }

  printNextActions(report.nextActions);
}

export function printChangeSet(changeSet: ChangeSet): void {
  const tone = changeSet.status === "error" ? c.red : c.bold;
  console.log(tone(changeSet.title));
  console.log("");

  if (changeSet.changes.length === 0) {
    console.log(c.dim("No file changes planned."));
  } else {
    console.log(c.bold(`Planned file changes ${c.dim(`(${changeSet.changes.length})`)}`));
    for (const change of changeSet.changes) {
      console.log(`${c.green(sym.bullet)} ${c.cyan(change.path)} ${c.gray(sym.dot)} ${c.gray(change.reason)}`);
    }
  }

  printWarnings(changeSet.warnings);
  printNextActions(changeSet.nextActions);
}

export function printVerify(report: VerifyReport): void {
  console.log(banner("Verification"));
  console.log("");
  console.log(`${label("Project")} ${c.bold(report.project.name ?? "unknown")}   ${label("Status")} ${statusLabel(report.status)}`);
  console.log("");

  for (const check of report.checks) {
    console.log(`${severityIcon(check.status)} ${c.bold(check.id)} ${c.gray(sym.dot)} ${c.gray(check.message)}`);
  }

  printNextActions(report.nextActions);
}

export function printProvision(report: ProvisionReport): void {
  console.log(banner("Provisioning"));
  console.log("");
  console.log(`${label("Status")} ${statusLabel(report.status)}`);
  console.log("");

  if (report.actions.length === 0) {
    console.log(c.dim("No Cloudflare resource actions found."));
  } else {
    for (const action of report.actions) {
      console.log(`${severityIcon(action.status === "succeeded" ? "passed" : action.status === "failed" ? "failed" : "info")} ${c.bold(action.title)} ${c.dim(`[${action.status}]`)}`);
      if (action.command.length > 0) console.log(`   ${c.cyan(action.command.join(" "))}`);
      console.log(`   ${c.gray(action.reason)}`);
      if (action.stderr) console.log(`   ${c.red("stderr:")} ${c.gray(action.stderr.trim())}`);
    }
  }

  printWarnings(report.warnings);
  printNextActions(report.nextActions);
}

export function printCost(report: CostReport): void {
  console.log(banner("Cost estimate"));
  console.log("");
  console.log(box([
    `${label("Project")} ${c.bold(report.project.name ?? "unknown")}   ${label("Plan")} ${c.cyan(report.plan)}`,
    `${label("Estimated monthly")} ${c.bold(c.green(`$${report.estimatedMonthlyUsd.toFixed(2)}`))} ${c.dim(report.currency)}`
  ]));
  console.log("");

  for (const item of report.lineItems) {
    console.log(`${c.green(sym.bullet)} ${c.bold(item.label)} ${c.dim(sym.dot)} ${c.green(`$${item.estimatedUsd.toFixed(2)}`)}`);
    console.log(`  ${c.gray(`${item.usage} ${item.unit}; billable ${item.billable}`)}`);
  }

  if (report.vercelComparison) {
    const v = report.vercelComparison;
    const cheaper = v.monthlyDeltaUsd >= 0 ? c.green("cheaper on Cloudflare") : c.yellow("cheaper on Vercel");
    console.log("");
    console.log(`${c.yellow(sym.warn)} ${c.bold("Vercel comparison")} ${c.dim("(EXPERIMENTAL)")}`);
    console.log(`  ${c.dim(v.disclaimer)}`);
    console.log(`  ${label(`Vercel (${v.source})`)} ${c.bold(`$${v.vercelMonthlyUsd.toFixed(2)}`)}   ${label("Cloudflare")} ${c.bold(`$${v.cloudflareMonthlyUsd.toFixed(2)}`)}`);
    console.log(`  ${label("Delta")} ${c.bold(`$${Math.abs(v.monthlyDeltaUsd).toFixed(2)}`)} ${cheaper}`);
  }

  printWarnings(report.warnings);

  console.log("");
  console.log(c.dim("Sources:"));
  for (const source of report.sources) console.log(`  ${c.gray(sym.dot)} ${c.gray(`${source.name}: ${source.url}`)}`);

  printNextActions(report.nextActions);
}

export function printDeploy(report: DeployReport): void {
  console.log(banner(`Deploy ${c.dim(sym.dot)} ${report.mode}`));
  console.log("");
  console.log(box([
    `${label("Mode")} ${c.cyan(report.mode)}   ${label("Status")} ${statusLabel(report.status)}`,
    `${label("Verify")} ${statusLabel(report.verifyStatus)}`,
    `${label("Command")} ${c.bold(report.command.join(" ") || "unknown")}`
  ]));
  console.log("");

  printWarnings(report.warnings);

  if (report.cost) {
    console.log(`${label("Estimated monthly before production")} ${c.bold(c.green(`$${report.cost.estimatedMonthlyUsd.toFixed(2)}`))} ${c.dim(report.cost.currency)}`);
    console.log("");
  }

  if (report.stdout) {
    console.log(c.dim("stdout:"));
    console.log(report.stdout.trim());
    console.log("");
  }

  if (report.stderr) {
    console.log(c.red("stderr:"));
    console.log(report.stderr.trim());
    console.log("");
  }

  printNextActions(report.nextActions);
}

function printWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  console.log("");
  console.log(c.bold(c.yellow(`Warnings ${c.dim(`(${warnings.length})`)}`)));
  for (const warning of warnings) console.log(`${c.yellow(sym.warn)} ${c.gray(warning)}`);
}

function printNextActions(actions: string[]): void {
  if (actions.length === 0) return;
  console.log("");
  console.log(c.bold("Next actions"));
  for (const action of actions) console.log(`${c.dim(sym.arrow)} ${c.cyan(action)}`);
}
