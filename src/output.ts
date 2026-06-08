import type { ChangeSet, DoctorReport, Issue, PlanReport, VerifyReport } from "./types.js";
import type { CostReport } from "./cost.js";
import type { CloudflareConnectionReport, CloudflareResourceCheck, CloudflareResourceStatus } from "./cloudflare.js";
import type { DeployReport } from "./deploy.js";
import type { EnvReport, EnvVarReport } from "./env.js";
import type { ProgressReport, ProgressStageStatus } from "./progress.js";
import type { ProvisionReport } from "./provision.js";
import { c, sym, banner, box, bar, rule, statusLabel, severityIcon, label } from "./ui.js";
import { formatCloudflareAuthStatus, formatVercelAuthStatus } from "./auth-status.js";

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
    const groups = groupDoctorIssues(report.issues);
    const rawLabel = groups.length === report.issues.length
      ? `${report.issues.length}`
      : `${report.issues.length} findings, ${groups.length} groups`;
    console.log(c.bold(`Issues ${c.dim(`(${rawLabel})`)}`));
    for (const group of groups.slice(0, MAX_HUMAN_DOCTOR_GROUPS)) {
      printDoctorIssueGroup(group);
    }
    if (groups.length > MAX_HUMAN_DOCTOR_GROUPS) {
      const hidden = groups.slice(MAX_HUMAN_DOCTOR_GROUPS).reduce((sum, group) => sum + group.count, 0);
      console.log(`${c.gray("...")} ${c.gray(`${hidden} more findings hidden. Run`)} ${c.cyan("flarecel doctor --json")} ${c.gray("for the complete list.")}`);
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

export function printProgress(report: ProgressReport): void {
  console.log(banner("Progress"));
  console.log("");
  console.log(box([
    `${label("Project")} ${c.bold(report.project.name ?? "unknown")}   ${label("Framework")} ${c.cyan(report.project.framework)}`,
    `${label("Status")} ${statusLabel(report.status)}`,
    c.dim(formatCloudflareAuthStatus(report.cloudflareAuth))
  ]));
  console.log("");

  console.log(c.bold("Path"));
  for (const stage of report.stages) {
    console.log(`${progressIcon(stage.status)} ${c.bold(stage.title)} ${c.dim(`[${stage.status}]`)}`);
    console.log(`   ${c.gray(stage.explanation)}`);
    console.log(`   ${c.cyan(stage.command)}`);
  }

  printNextActions(report.nextActions);
}

export function printChangeSet(changeSet: ChangeSet): void {
  const tone = changeSet.status === "error" ? c.red : c.bold;
  console.log(tone(changeSet.title));
  if (changeSet.vercelAuth) console.log(c.dim(formatVercelAuthStatus(changeSet.vercelAuth)));
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
  console.log(c.dim(formatCloudflareAuthStatus(report.cloudflareAuth)));
  console.log("");

  for (const check of report.checks) {
    console.log(`${severityIcon(check.status)} ${c.bold(check.id)} ${c.gray(sym.dot)} ${c.gray(check.message)}`);
  }

  printNextActions(report.nextActions);
}

export function printCloudflareConnection(report: CloudflareConnectionReport): void {
  console.log(banner("Cloudflare connection"));
  console.log("");
  console.log(box([
    `${label("Project")} ${c.bold(report.project.name ?? "unknown")}   ${label("Framework")} ${c.cyan(report.project.framework)}`,
    `${label("Status")} ${connectionStatusLabel(report.status)}`,
    c.dim(formatCloudflareAuthStatus(report.cloudflareAuth)),
    c.dim(report.account.message)
  ]));
  console.log("");

  console.log(c.bold("App needs"));
  for (const resource of report.resources) {
    printCloudflareResource(resource);
  }

  printWarnings(report.warnings);
  printNextActions(report.nextActions);
}

export function printEnvReport(report: EnvReport): void {
  console.log(banner(report.mode === "secrets" ? "Secrets plan" : "Environment audit"));
  console.log("");
  console.log(box([
    `${label("Project")} ${c.bold(report.project.name ?? "unknown")}   ${label("Framework")} ${c.cyan(report.project.framework)}`,
    `${label("Status")} ${statusLabel(report.status)}`,
    `${label("Found")} ${c.bold(String(report.summary.total))} ${c.dim(`(${report.summary.secret} secret, ${report.summary.public} public, ${report.summary.config} config)`)}`
  ]));
  console.log("");

  if (report.variables.length === 0) {
    console.log(c.dim(report.mode === "secrets" ? "No secret-looking env names found." : "No env names found."));
  } else {
    for (const variable of report.variables) {
      printEnvVariable(variable);
    }
  }

  printWarnings(report.warnings);
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
  const planLabels: Record<CostReport["plan"], string> = {
    free: c.cyan("free"),
    paid: c.cyan("paid"),
    unknown: c.yellow("unknown")
  };
  const confidenceText = c.dim(`${report.planConfidence} confidence`);
  const planSuffix = report.plan === "unknown"
    ? c.dim("(not detected)")
    : report.planAssumed
      ? c.dim("(assumed)")
      : "";
  const planText = `${planLabels[report.plan]} ${planSuffix} ${confidenceText}`.replace(/\s+/g, " ").trim();
  const live = report.usageSource === "cloudflare-live";
  const headerNote = live
    ? c.dim(`Workers/R2/D1/KV usage is REAL (last ${report.usageWindowDays ?? 30}d, priced at published rates).`)
    : c.dim("Forecast from assumed usage — not your Cloudflare account or a real bill.");

  // for an unknown plan we lead with the RANGE, not a single confident number,
  // and explain the Free $0 vs Paid $5 split so non-technical users get it.
  const headlineLine = report.plan === "unknown"
    ? `${label("Baseline range")} ${c.bold(report.recommendedDisplay)} ${c.dim(report.currency)} ${c.dim("\u2014 not a single guaranteed number")}`
    : `${label("Projected monthly")} ${c.bold(c.green(`$${report.estimatedMonthlyUsd.toFixed(2)}`))} ${c.dim(report.currency)} ${c.dim(live ? "from real Workers usage" : "for the usage below")}`;
  const secondLine = report.plan === "unknown"
    ? `${label("If it matters")} ${c.dim("Workers Free may be $0/mo for testing & low traffic; Workers Paid starts at $5/mo before usage.")}`
    : `${label("Likely range")} ${c.bold(`$${report.estimatedMonthlyUsdLow.toFixed(2)} - $${report.estimatedMonthlyUsdHigh.toFixed(2)}`)} ${c.dim("depending on traffic")}`;

  console.log(box([
    `${label("Project")} ${c.bold(report.project.name ?? "unknown")}   ${label("Plan")} ${planText}`,
    headlineLine,
    secondLine,
    headerNote
  ]));
  console.log("");
  if (report.plan === "unknown") {
    console.log(`${c.yellow(sym.warn)} ${c.dim("Plan not detected. Pass")} ${c.bold("--plan free")} ${c.dim("or")} ${c.bold("--plan paid")} ${c.dim("to pin it, or")} ${c.bold("--cloudflare-live")} ${c.dim("to price real usage.")}`);
    console.log("");
  }

  for (const item of report.lineItems) {
    console.log(`${c.green(sym.bullet)} ${c.bold(item.label)} ${c.dim(sym.dot)} ${c.green(`$${item.estimatedUsd.toFixed(2)}`)}`);
    console.log(`  ${c.gray(`${item.usage} ${item.unit}; billable ${item.billable}`)}`);
  }

  if (report.vercelComparison) {
    const v = report.vercelComparison;
    const sourceLabel = v.source === "vercel-cli" ? "your real bill" : v.source;
    const cheaper = v.monthlyDeltaUsd >= 0 ? c.green(`cheaper on Cloudflare (${v.savingsPct}%)`) : c.yellow(`cheaper on Vercel (${Math.abs(v.savingsPct)}%)`);
    console.log("");
    console.log(`${c.yellow(sym.warn)} ${c.bold("Vercel comparison")} ${c.dim("(EXPERIMENTAL)")}`);
    if (report.vercelAuth) console.log(`  ${c.dim(formatVercelAuthStatus(report.vercelAuth))}`);
    console.log(`  ${c.dim(v.disclaimer)}`);
    console.log(`  ${label(`Vercel (${sourceLabel})`)} ${c.bold(`$${v.vercelMonthlyUsd.toFixed(2)}`)}   ${label("Cloudflare")} ${c.bold(`$${v.cloudflareMonthlyUsd.toFixed(2)}`)}`);
    console.log(`  ${label("Delta")} ${c.bold(`$${Math.abs(v.monthlyDeltaUsd).toFixed(2)}`)} ${cheaper}`);
  }

  printWarnings(report.warnings);

  console.log("");
  console.log(c.dim(`Based on ${report.sources.length} Cloudflare pricing pages \u00b7 prices verified ${report.pricingVerifiedOn} \u00b7 see --json for source URLs.`));

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

function printEnvVariable(variable: EnvVarReport): void {
  const tone = variable.classification === "secret"
    ? c.yellow
    : variable.classification === "public"
      ? c.cyan
      : c.white;
  const configured = variable.configuredInWranglerVars ? c.green("configured") : c.gray("not configured");
  const shownSources = variable.sources.slice(0, 4).join(", ");
  const hiddenSources = variable.sources.length > 4 ? `, +${variable.sources.length - 4} more` : "";
  console.log(`${c.green(sym.bullet)} ${c.bold(variable.name)} ${c.dim(sym.dot)} ${tone(variable.classification)} ${c.dim(sym.dot)} ${c.gray(variable.recommendedTarget)} ${c.dim(sym.dot)} ${configured}`);
  console.log(`  ${c.gray(variable.reason)}`);
  console.log(`  ${c.dim("sources:")} ${c.gray(`${shownSources}${hiddenSources}`)}`);
  if (variable.command) console.log(`  ${c.dim(sym.arrow)} ${c.cyan(variable.command)}`);
}

const MAX_HUMAN_DOCTOR_GROUPS = 8;

interface DoctorIssueGroup {
  issue: Issue;
  count: number;
  files: string[];
}

function groupDoctorIssues(issues: Issue[]): DoctorIssueGroup[] {
  const groups = new Map<string, DoctorIssueGroup>();
  for (const issue of issues) {
    const key = [
      issue.id,
      issue.severity,
      issue.title,
      issue.message,
      issue.recommendedCommand ?? ""
    ].join("\0");
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (issue.file) existing.files.push(issue.file);
      continue;
    }
    groups.set(key, {
      issue,
      count: 1,
      files: issue.file ? [issue.file] : []
    });
  }
  return [...groups.values()];
}

function printDoctorIssueGroup(group: DoctorIssueGroup): void {
  const { issue } = group;
  const singleFile = group.count === 1 && issue.file ? c.gray(` (${issue.file})`) : "";
  const count = group.count > 1 ? c.dim(` ${sym.dot} ${group.count} findings`) : "";
  console.log(`${severityIcon(issue.severity)} ${c.bold(issue.title)} ${c.dim(`[${issue.severity}]`)}${count}${singleFile}`);
  console.log(`  ${c.gray(issue.message)}`);
  if (group.count > 1 && group.files.length > 0) {
    const shown = group.files.slice(0, 3).join(", ");
    const rest = group.files.length - 3;
    console.log(`  ${c.gray(`Files: ${shown}${rest > 0 ? `, +${rest} more` : ""}`)}`);
  }
  if (issue.recommendedCommand) console.log(`  ${c.dim(sym.arrow)} ${c.cyan(issue.recommendedCommand)}`);
}

function printCloudflareResource(resource: CloudflareResourceCheck): void {
  const binding = resource.binding ? c.dim(` (${resource.binding})`) : "";
  console.log(`${resourceStatusIcon(resource.status)} ${c.bold(resourceLabel(resource))}${binding} ${c.dim(sym.dot)} ${resourceStatusText(resource.status)}`);
  console.log(`   ${c.gray(resource.message)}`);
  if (resource.command) console.log(`   ${c.dim(sym.arrow)} ${c.cyan(resource.command)}`);
}

function resourceLabel(resource: CloudflareResourceCheck): string {
  if (resource.status === "not-used") return resource.name;
  if (resource.type === "worker") return resource.name;
  return `${resource.type.toUpperCase()} ${resource.name}`;
}

function connectionStatusLabel(status: CloudflareConnectionReport["status"]): string {
  if (status === "ready") return c.green(status);
  if (status === "action-required") return c.yellow(status);
  if (status === "needs-auth") return c.red(status);
  return c.red(status);
}

function resourceStatusIcon(status: CloudflareResourceStatus): string {
  switch (status) {
    case "connected":
    case "configured":
    case "not-used":
      return c.green(sym.ok);
    case "not-checked":
      return c.yellow(sym.warn);
    case "missing":
    case "blocked":
      return c.red(sym.err);
    case "needs-id":
    case "unknown":
      return c.yellow(sym.warn);
  }
}

function resourceStatusText(status: CloudflareResourceStatus): string {
  switch (status) {
    case "connected":
      return c.green("connected");
    case "configured":
      return c.green("configured");
    case "not-used":
      return c.gray("not used");
    case "not-checked":
      return c.yellow("not checked");
    case "missing":
      return c.red("missing");
    case "needs-id":
      return c.yellow("needs id");
    case "unknown":
      return c.yellow("unknown");
    case "blocked":
      return c.red("blocked");
  }
}

function printWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  console.log("");
  console.log(c.bold(c.yellow(`Warnings ${c.dim(`(${warnings.length})`)}`)));
  for (const warning of warnings) console.log(`${c.yellow(sym.warn)} ${c.gray(warning)}`);
}

function progressIcon(status: ProgressStageStatus): string {
  switch (status) {
    case "done":
      return c.green(sym.ok);
    case "todo":
      return c.yellow(sym.pending);
    case "blocked":
      return c.red(sym.err);
    case "optional":
      return c.blue(sym.info);
  }
}

function printNextActions(actions: string[]): void {
  if (actions.length === 0) return;
  console.log("");
  console.log(c.bold("Next actions"));
  for (const action of actions) console.log(`${c.dim(sym.arrow)} ${c.cyan(action)}`);
}
