import { createCostEstimate, type CostReport } from "./cost.js";
import { runCommand } from "./exec.js";
import { redactSecrets } from "./redact.js";
import { runVerify } from "./verify.js";
import type { PackageManager, ProjectContext, Status, VerifyReport } from "./types.js";

export interface DeployOptions {
  mode: "preview" | "production";
}

export interface DeployReport {
  status: "planned" | "blocked" | "confirmation-required" | "succeeded" | "failed";
  mode: "preview" | "production";
  command: string[];
  executed: boolean;
  requiresConfirmation: boolean;
  verifyStatus: Status;
  verify: VerifyReport;
  cost?: CostReport;
  warnings: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  nextActions: string[];
}

export function createDeployPlan(ctx: ProjectContext, options: DeployOptions): DeployReport {
  const verify = runVerify(ctx);
  const command = deployCommand(ctx, options.mode);
  const warnings: string[] = [];

  if (verify.status === "blocking" || verify.status === "unsupported" || verify.status === "secrets-missing") {
    warnings.push("Deploy is blocked until verification passes.");
  }

  if (options.mode === "production") {
    warnings.push("Production deploys can immediately serve live traffic.");
    warnings.push("Run flarecel cost --json and review Cloudflare billing assumptions before production.");
  }

  if (command.length === 0) {
    warnings.push("Flarecel could not determine a deploy command for this project.");
  }

  const status = verify.status === "blocking" || verify.status === "unsupported" || verify.status === "secrets-missing" || command.length === 0
    ? "blocked"
    : "planned";

  return {
    status,
    mode: options.mode,
    command,
    executed: false,
    requiresConfirmation: true,
    verifyStatus: verify.status,
    verify,
    // production deploys assume the conservative Paid floor on purpose: a
    // pre-production gate should over-state, not under-state, the bill.
    cost: options.mode === "production" ? createCostEstimate(ctx, { plan: "paid" }) : undefined,
    warnings,
    nextActions: status === "blocked"
      ? verify.nextActions
      : [
        options.mode === "production"
          ? "flarecel deploy --production --yes"
          : "flarecel deploy --preview --yes"
      ]
  };
}

export function markDeployConfirmationRequired(report: DeployReport): DeployReport {
  if (report.status === "blocked") return report;

  return {
    ...report,
    status: "confirmation-required",
    requiresConfirmation: true,
    nextActions: [
      report.mode === "production"
        ? "flarecel deploy --production --yes"
        : "flarecel deploy --preview --yes"
    ]
  };
}

export async function executeDeployPlan(ctx: ProjectContext, report: DeployReport): Promise<DeployReport> {
  if (report.status === "blocked") return report;

  const [command, ...args] = report.command;
  const result = await runCommand(command, args, ctx.cwd, { timeoutMs: 10 * 60_000 });

  const succeeded = result.code === 0;
  return {
    ...report,
    status: succeeded ? "succeeded" : "failed",
    executed: true,
    requiresConfirmation: false,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
    exitCode: result.code,
    nextActions: succeeded
      ? report.mode === "production"
        ? ["Monitor the deployment in Cloudflare dashboard.", "flarecel cost --json"]
        : ["Review the uploaded preview version.", "flarecel deploy --production --yes"]
      : deployFailureNextActions(report, result.stderr || result.stdout)
  };
}

function deployFailureNextActions(report: DeployReport, output: string): string[] {
  if (report.mode === "preview" && isMissingWorkerError(output)) {
    return [
      "This Worker does not exist yet, so Cloudflare cannot upload a preview version.",
      "Bootstrap it once with flarecel deploy --production --yes, then retry flarecel deploy --preview --yes.",
      "If you have multiple Cloudflare accounts, set account_id in wrangler config or CLOUDFLARE_ACCOUNT_ID."
    ];
  }

  return ["Review stderr.", "flarecel verify --json"];
}

function isMissingWorkerError(output: string): boolean {
  return /\b10007\b/.test(output) || /Worker does not exist/i.test(output);
}

function deployCommand(ctx: ProjectContext, mode: "preview" | "production"): string[] {
  if (ctx.framework === "nextjs") {
    const scriptName = mode === "production" ? "deploy" : "upload";
    if (!ctx.packageJson?.scripts?.[scriptName]) return [];
    return packageManagerRun(ctx.packageManager, scriptName);
  }

  return mode === "production"
    ? ["npx", "wrangler", "deploy"]
    : ["npx", "wrangler", "versions", "upload", "--preview-alias", "flarecel-preview"];
}

function packageManagerRun(packageManager: PackageManager, scriptName: string): string[] {
  if (packageManager === "pnpm") return ["pnpm", "run", scriptName];
  if (packageManager === "yarn") return ["yarn", scriptName];
  if (packageManager === "bun") return ["bun", "run", scriptName];
  return ["npm", "run", scriptName];
}
