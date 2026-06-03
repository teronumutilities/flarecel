import { spawnSync } from "node:child_process";
import { createCostEstimate, type CostReport } from "./cost.js";
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

  if (verify.status === "blocking" || verify.status === "unsupported") {
    warnings.push("Deploy is blocked until verification passes.");
  }

  if (options.mode === "production") {
    warnings.push("Production deploys can immediately serve live traffic.");
    warnings.push("Run flarecel cost --json and review Cloudflare billing assumptions before production.");
  }

  if (command.length === 0) {
    warnings.push("Flarecel could not determine a deploy command for this project.");
  }

  const status = verify.status === "blocking" || verify.status === "unsupported" || command.length === 0
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
    cost: options.mode === "production" ? createCostEstimate(ctx) : undefined,
    warnings,
    nextActions: status === "blocked"
      ? ["flarecel verify --json", "flarecel fix --dry-run --format patch"]
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

export function executeDeployPlan(ctx: ProjectContext, report: DeployReport): DeployReport {
  if (report.status === "blocked") return report;

  const [command, ...args] = report.command;
  const result = spawnSync(command, args, {
    cwd: ctx.cwd,
    encoding: "utf8"
  });

  const succeeded = result.status === 0;
  return {
    ...report,
    status: succeeded ? "succeeded" : "failed",
    executed: true,
    requiresConfirmation: false,
    stdout: redactSecrets(result.stdout ?? ""),
    stderr: redactSecrets(result.stderr ?? (result.error ? result.error.message : "")),
    exitCode: result.status,
    nextActions: succeeded
      ? report.mode === "production"
        ? ["Monitor the deployment in Cloudflare dashboard.", "flarecel cost --json"]
        : ["Review the uploaded preview version.", "flarecel deploy --production --yes"]
      : ["Review stderr.", "flarecel verify --json"]
  };
}

function deployCommand(ctx: ProjectContext, mode: "preview" | "production"): string[] {
  if (ctx.framework === "nextjs") {
    const scriptName = mode === "production" ? "deploy" : "upload";
    if (!ctx.packageJson?.scripts?.[scriptName]) return [];
    return packageManagerRun(ctx.packageManager, scriptName);
  }

  return mode === "production"
    ? ["npx", "wrangler", "deploy"]
    : ["npx", "wrangler", "versions", "upload"];
}

function packageManagerRun(packageManager: PackageManager, scriptName: string): string[] {
  if (packageManager === "pnpm") return ["pnpm", "run", scriptName];
  if (packageManager === "yarn") return ["yarn", scriptName];
  if (packageManager === "bun") return ["bun", "run", scriptName];
  return ["npm", "run", scriptName];
}
