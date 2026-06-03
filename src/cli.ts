#!/usr/bin/env node

import path from "node:path";
import { parseArgs, getFlag, hasFlag } from "./args.js";
import { createCostEstimate } from "./cost.js";
import { createDeployPlan, executeDeployPlan, markDeployConfirmationRequired } from "./deploy.js";
import { runDoctor, exitCodeForStatus } from "./doctor.js";
import { startMcpServer } from "./mcp.js";
import { writeOpenReport } from "./open-report.js";
import {
  printChangeSet,
  printCost,
  printDeploy,
  printDoctor,
  printJson,
  printPlan,
  printProvision,
  printVerify
} from "./output.js";
import { applyChangeSet, renderPatch } from "./patches.js";
import { createPlan } from "./plan.js";
import { detectProject } from "./project.js";
import { applyProvisionPlan, createProvisionPlan } from "./provision.js";
import { createFixChangeSet, createRecipeChangeSet } from "./recipes.js";
import { runVerify } from "./verify.js";
import type { ChangeSet } from "./types.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help" || hasFlag(args, "help") || hasFlag(args, "h")) {
    printHelp();
    return;
  }

  const cwd = path.resolve(getFlag(args, "cwd") ?? process.cwd());
  const ctx = await detectProject(cwd);

  if (args.command === "doctor") {
    const report = runDoctor(ctx);
    if (hasFlag(args, "json")) printJson(report);
    else printDoctor(report);
    process.exitCode = exitCodeForStatus(report.status);
    return;
  }

  if (args.command === "plan") {
    const report = createPlan(runDoctor(ctx));
    if (hasFlag(args, "json")) printJson(report);
    else printPlan(report);
    process.exitCode = exitCodeForStatus(report.status);
    return;
  }

  if (args.command === "fix") {
    const report = runDoctor(ctx);
    const changeSet = await createFixChangeSet(ctx, report);
    await handleChangeSet(cwd, args, changeSet);
    return;
  }

  if (args.command === "add") {
    const recipeName = args.positionals.shift();
    if (!recipeName) {
      fail("Missing recipe name. Example: flarecel add r2 uploads");
      process.exitCode = 4;
      return;
    }

    const changeSet = await createRecipeChangeSet(ctx, recipeName, {
      positionals: args.positionals,
      flags: args.flags
    });
    await handleChangeSet(cwd, args, changeSet);
    return;
  }

  if (args.command === "verify") {
    const report = runVerify(ctx);
    if (hasFlag(args, "json")) printJson(report);
    else printVerify(report);
    process.exitCode = exitCodeForStatus(report.status);
    return;
  }

  if (args.command === "provision") {
    const report = createProvisionPlan(ctx);

    if (hasFlag(args, "apply")) {
      if (!hasFlag(args, "yes")) {
        fail("Provisioning Cloudflare resources requires --apply --yes.");
        process.exitCode = 5;
        return;
      }

      const applied = applyProvisionPlan(ctx, report);
      if (hasFlag(args, "json")) printJson(applied);
      else printProvision(applied);
      process.exitCode = applied.status === "failed" ? 2 : 0;
      return;
    }

    if (hasFlag(args, "json")) printJson(report);
    else printProvision(report);
    return;
  }

  if (args.command === "open") {
    const report = runDoctor(ctx);
    const outputPath = await writeOpenReport(ctx, report);
    if (hasFlag(args, "json")) {
      printJson({ status: "ready", reportPath: outputPath });
    } else {
      console.log(`Flarecel report written to ${outputPath}`);
      console.log("Open that file in a browser to view the local report.");
    }
    return;
  }

  if (args.command === "mcp") {
    if (!hasFlag(args, "json")) {
      await startMcpServer();
      return;
    }

    const payload = {
      status: "ready",
      message: "Run `flarecel mcp` without --json to start the stdio MCP server.",
      tools: [
        "detect_project",
        "run_doctor",
        "generate_plan",
        "preview_patch",
        "apply_patch",
        "verify_project",
        "plan_provisioning",
        "estimate_cost",
        "deploy_preview",
        "list_recipes"
      ]
    };
    printJson(payload);
    return;
  }

  if (args.command === "deploy") {
    const production = hasFlag(args, "production");
    const plan = createDeployPlan(ctx, { mode: production ? "production" : "preview" });
    const wantsExecution = hasFlag(args, "yes") && !hasFlag(args, "dry-run");
    const payload = wantsExecution
      ? executeDeployPlan(ctx, plan)
      : markDeployConfirmationRequired(plan);

    if (hasFlag(args, "json")) printJson(payload);
    else printDeploy(payload);

    if (payload.status === "blocked") process.exitCode = 2;
    else if (payload.status === "confirmation-required") process.exitCode = production ? 5 : 0;
    else if (payload.status === "failed") process.exitCode = 2;
    return;
  }

  if (args.command === "cost") {
    const report = createCostEstimate(ctx, args.flags);
    if (hasFlag(args, "json")) printJson(report);
    else printCost(report);
    return;
  }

  fail(`Unknown command: ${args.command}`);
  process.exitCode = 4;
}

async function handleChangeSet(cwd: string, args: ReturnType<typeof parseArgs>, changeSet: ChangeSet): Promise<void> {
  const wantsPatch = getFlag(args, "format") === "patch";
  const wantsApply = hasFlag(args, "apply");

  if (changeSet.status === "error") {
    if (hasFlag(args, "json")) printJson(changeSet);
    else printChangeSet(changeSet);
    process.exitCode = 4;
    return;
  }

  if (wantsApply && !hasFlag(args, "yes")) {
    fail("Applying file changes requires --apply --yes.");
    process.exitCode = 5;
    return;
  }

  if (wantsApply) {
    const applied = await applyChangeSet(cwd, changeSet);
    if (hasFlag(args, "json")) printJson(applied);
    else printChangeSet(applied);
    return;
  }

  if (hasFlag(args, "json")) {
    printJson(changeSet);
    return;
  }

  if (wantsPatch) {
    const patch = renderPatch(changeSet.changes);
    if (patch) process.stdout.write(patch);
    else printChangeSet(changeSet);
    return;
  }

  printChangeSet(changeSet);
}

function printHelp(): void {
  console.log(`Flarecel

Agent-friendly Cloudflare Workers deployment assistant.

Usage:
  flarecel doctor [--json] [--cwd <path>]
  flarecel plan [--json]
  flarecel fix [--dry-run] [--format patch]
  flarecel fix --apply --yes
  flarecel add next-opennext [--dry-run] [--format patch]
  flarecel add r2 uploads [--dry-run] [--format patch]
  flarecel add db d1 --orm drizzle [--dry-run] [--format patch]
  flarecel add kv cache [--dry-run] [--format patch]
  flarecel add turnstile --form signup
  flarecel add rate-limit --route /api/generate --limit 20/min
  flarecel add cron daily-cleanup --schedule "0 0 * * *"
  flarecel add workers-ai --model @cf/meta/llama-3.1-8b-instruct
  flarecel add vectorize docs-search --dimensions 768 --metric cosine
  flarecel add ai-gateway --provider openai
  flarecel add observability --sampling 1
  flarecel add durable-object room
  flarecel add workflow onboarding --schedule "0 9 * * *"
  flarecel add browser-run
  flarecel add queue emails
  flarecel verify [--json]
  flarecel provision [--json]
  flarecel provision --apply --yes
  flarecel cost [--json] [--requests 1000000] [--cpu-ms 7]
  flarecel open
  flarecel mcp
  flarecel deploy --preview --yes
  flarecel deploy --production --yes

Agent loop:
  doctor --json -> plan --json -> fix --dry-run --format patch -> fix --apply --yes -> verify --json -> cost --json -> deploy --preview --yes
`);
}

function fail(message: string): void {
  console.error(`Error: ${message}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
