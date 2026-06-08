import path from "node:path";
import { existsSync } from "node:fs";
import { runCommand } from "./exec.js";
import { redactSecrets } from "./redact.js";
import type { ProjectContext } from "./types.js";

export interface RollbackReport {
  status: "planned" | "confirmation-required" | "succeeded" | "failed" | "blocked";
  action: "versions" | "rollback";
  command: string[];
  executed: boolean;
  versionId?: string;
  warnings: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  nextActions: string[];
}

function wranglerInvocation(ctx: ProjectContext): string[] {
  const local = path.join(ctx.cwd, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  return existsSync(local) ? [local] : ["npx", "wrangler"];
}

// read-only: list recent Worker versions. Safe to run anytime.
export async function listVersions(ctx: ProjectContext): Promise<RollbackReport> {
  const [bin, ...base] = wranglerInvocation(ctx);
  const command = [bin, ...base, "versions", "list"];
  const result = await runCommand(bin, [...base, "versions", "list"], ctx.cwd, { timeoutMs: 60_000 });
  const ok = result.code === 0;
  return {
    status: ok ? "succeeded" : "failed",
    action: "versions",
    command,
    executed: true,
    warnings: ok ? [] : ["Could not list versions. Ensure wrangler is installed and you are logged in (wrangler login)."],
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
    exitCode: result.code,
    nextActions: ok
      ? ["flarecel rollback <version-id> --yes to revert production to a previous version."]
      : ["wrangler login", "flarecel verify --json"]
  };
}

// gated: rollback production to a previous version. Like production deploy,
// requires explicit --yes (the caller passes confirmed=true).
export async function createRollbackPlan(ctx: ProjectContext, versionId?: string): Promise<RollbackReport> {
  const [bin, ...base] = wranglerInvocation(ctx);
  const tail = ["rollback", ...(versionId ? [versionId] : []), "--message", "Rolled back via Flarecel"];
  const command = [bin, ...base, ...tail];
  return {
    status: "confirmation-required",
    action: "rollback",
    command,
    executed: false,
    versionId,
    warnings: [
      "Rollback immediately changes which version serves production traffic.",
      versionId ? `Target version: ${versionId}.` : "No version id given; wrangler will roll back to the last deployment at 100% traffic.",
      "Bindings/secrets are taken from the target version; review before confirming."
    ],
    nextActions: [versionId ? `flarecel rollback ${versionId} --yes` : "flarecel rollback --yes"]
  };
}

export async function executeRollback(ctx: ProjectContext, plan: RollbackReport): Promise<RollbackReport> {
  if (plan.status === "blocked") return plan;
  const [bin, ...rest] = plan.command;
  // wrangler prompts interactively; --yes skips it.
  const result = await runCommand(bin, [...rest, "--yes"], ctx.cwd, { timeoutMs: 5 * 60_000 });
  const ok = result.code === 0;
  return {
    ...plan,
    status: ok ? "succeeded" : "failed",
    executed: true,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
    exitCode: result.code,
    nextActions: ok
      ? ["Verify production is healthy in the Cloudflare dashboard.", "flarecel cost --json"]
      : ["Review stderr.", "flarecel rollback (no id) to target the last stable deployment."]
  };
}
