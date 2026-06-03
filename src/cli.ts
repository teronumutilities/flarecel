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
import { createVercelMigration } from "./migrate.js";
import { explainIssue, listExplainableIds } from "./explain.js";
import { applyProvisionPlan, createProvisionPlan } from "./provision.js";
import { createFixChangeSet, createKitChangeSet, createRecipeChangeSet, listKits } from "./recipes.js";
import { runVerify, runRuntimeCheck } from "./verify.js";
import { setColorEnabled, c, startSpinner, splash, playVersus } from "./ui.js";
import type { ChangeSet } from "./types.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Hard guard: never emit ANSI when an agent/machine is the consumer.
  if (hasFlag(args, "no-color") || hasFlag(args, "json") || getFlag(args, "format") === "patch") {
    setColorEnabled(false);
  }

  if (args.command === "help" || hasFlag(args, "help") || hasFlag(args, "h")) {
    // Bare `flarecel` in a real terminal: play the boot animation first.
    if (process.argv.slice(2).length === 0 && process.stdout.isTTY) {
      await playVersus();
      console.log("");
    }
    printHelp(hasFlag(args, "all") || hasFlag(args, "full"));
    return;
  }

  if (args.command === "vs") {
    await playVersus();
    return;
  }

  const cwd = path.resolve(getFlag(args, "cwd") ?? process.cwd());
  const ctx = await detectProject(cwd);

  if (args.command === "doctor") {
    const report = runDoctor(ctx);
    if (hasFlag(args, "fix")) {
      await runDoctorFix(cwd, ctx, args, report);
      return;
    }
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

  if (args.command === "explain") {
    const id = args.positionals.shift();
    if (!id) {
      if (hasFlag(args, "json")) printJson({ ids: listExplainableIds() });
      else console.log(`Usage: flarecel explain <issue-id>\nKnown ids: ${listExplainableIds().join(", ")}`);
      return;
    }
    const explanation = explainIssue(id);
    if (!explanation) {
      fail(`No explanation for "${id}". Run flarecel doctor --json to see issue ids.`);
      process.exitCode = 4;
      return;
    }
    if (hasFlag(args, "json")) {
      printJson(explanation);
    } else {
      console.log(`Flarecel — ${explanation.id}`);
      console.log("");
      console.log(`What this is: ${explanation.what}`);
      console.log(`Why it matters: ${explanation.why}`);
      console.log(`What Flarecel changes: ${explanation.change}`);
      console.log(`Is it safe: ${explanation.safety}`);
      if (explanation.verifiedBy) console.log(`Confirm the fix: flarecel verify --json (check "${explanation.verifiedBy}")`);
    }
    return;
  }

  if (args.command === "migrate") {
    const target = args.positionals.shift();
    if (target !== "vercel") {
      fail("Only `flarecel migrate vercel` is supported.");
      process.exitCode = 4;
      return;
    }
    const changeSet = await createVercelMigration(ctx);
    await handleChangeSet(cwd, args, changeSet);
    return;
  }

  if (args.command === "kit") {
    const kitName = args.positionals.shift();
    if (!kitName) {
      fail(`Missing kit name. Available: ${listKits().join(", ")}`);
      process.exitCode = 4;
      return;
    }
    const changeSet = await createKitChangeSet(ctx, kitName);
    await handleChangeSet(cwd, args, changeSet);
    return;
  }

  if (args.command === "verify") {
    const report = runVerify(ctx);
    if (hasFlag(args, "runtime")) {
      report.checks.push(runRuntimeCheck(ctx));
    }
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

      const spin = hasFlag(args, "json") ? null : startSpinner("Provisioning Cloudflare resources…");
      const applied = await applyProvisionPlan(ctx, report);
      spin?.stop();
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
    let payload;
    if (wantsExecution) {
      const spin = hasFlag(args, "json") ? null : startSpinner(`Deploying (${production ? "production" : "preview"})…`);
      payload = await executeDeployPlan(ctx, plan);
      spin?.stop();
    } else {
      payload = markDeployConfirmationRequired(plan);
    }

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

async function runDoctorFix(
  cwd: string,
  ctx: Awaited<ReturnType<typeof detectProject>>,
  args: ReturnType<typeof parseArgs>,
  report: ReturnType<typeof runDoctor>
): Promise<void> {
  const apply = hasFlag(args, "apply") && hasFlag(args, "yes");
  let changeSet = await createFixChangeSet(ctx, report);
  if (apply && changeSet.status === "planned") {
    changeSet = await applyChangeSet(cwd, changeSet);
  }

  // Re-detect after a real apply so verify reflects the patched state.
  const verifyCtx = apply ? await detectProject(cwd) : ctx;
  const verify = runVerify(verifyCtx);

  if (hasFlag(args, "json")) {
    printJson({ doctor: report, fix: changeSet, verify });
  } else {
    printDoctor(report);
    console.log("");
    printChangeSet(changeSet);
    console.log("");
    printVerify(verify);
  }
  process.exitCode = exitCodeForStatus(verify.status);
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

function printHelp(full = false): void {
  console.log(splash());
  console.log("");
  console.log(c.dim("Agent-friendly Cloudflare Workers deployment assistant."));
  console.log("");

  // Grouped + color-coded so the surface is scannable, not a 50-line wall.
  const groups: Array<{ title: string; paint: (s: string) => string; cmds: string[] }> = [
    { title: "Diagnose", paint: c.cyan, cmds: ["doctor", "doctor --fix", "plan", "explain <id>", "verify", "cost"] },
    { title: "Fix & migrate", paint: c.green, cmds: ["fix --dry-run", "fix --apply --yes", "migrate vercel"] },
    { title: "Add features", paint: c.magenta, cmds: ["add r2 uploads", "add db d1 --orm drizzle", "add auth better-auth", "add isr", "add stripe", "add resend", "add <recipe>"] },
    { title: "Kits", paint: c.yellow, cmds: ["kit saas", "kit ai-app", "kit realtime", "kit creator", "kit internal-tool"] },
    { title: "Ship", paint: c.orange, cmds: ["provision", "deploy --preview --yes", "deploy --production --yes", "open", "mcp"] }
  ];

  for (const group of groups) {
    console.log(`${c.bold(group.paint(group.title))}`);
    for (const cmd of group.cmds) console.log(`  ${group.paint("flarecel " + cmd)}`);
    console.log("");
  }

  console.log(`${c.dim("Global flags:")} ${c.gray("--json  --dry-run  --format patch  --yes  --no-color  --cwd <path>")}`);
  console.log(`${c.dim("Agent loop:")}   ${c.gray("doctor \u2192 plan \u2192 fix --dry-run \u2192 fix --apply --yes \u2192 verify \u2192 deploy --preview")}`);

  if (full) {
    console.log("");
    console.log(c.bold("All add recipes"));
    for (const r of [
      "next-opennext", "r2 uploads", "kv cache", "db d1 --orm prisma", "db neon|supabase|turso|planetscale|mongodb",
      "auth clerk|supabase|authjs|cloudflare-access", "backend convex", "redis upstash", "turnstile --form signup",
      "rate-limit --route /api/* --limit 20/min", "cron <name> --schedule \"0 0 * * *\"", "workers-ai", "vectorize <index>",
      "ai-gateway --provider openai", "observability", "durable-object <name>", "workflow <name>", "browser-run", "queue <name>"
    ]) console.log(`  ${c.magenta("flarecel add " + r)}`);
  } else {
    console.log(c.dim(`\nRun ${c.cyan("flarecel help --all")} for every recipe.`));
  }
}

function fail(message: string): void {
  console.error(`Error: ${message}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
