#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { listAddOnCommands, ADD_ONS } from "./addons.js";
import { parseArgs, getFlag, hasFlag } from "./args.js";
import { createCostEstimate } from "./cost.js";
import { fetchVercelUsage } from "./vercel-usage.js";
import { fetchCloudflareUsage } from "./cloudflare-usage.js";
import { createDeployPlan, executeDeployPlan, markDeployConfirmationRequired } from "./deploy.js";
import { runDoctor, exitCodeForStatus } from "./doctor.js";
import { startMcpServer } from "./mcp.js";
import { startMenu, COMMAND_GROUPS } from "./menu.js";
import { listCatalog, isRemoteAddonRef, fetchRemoteAddon } from "./user-addons.js";
import { createSecretsMigration } from "./migrate-secrets.js";
import { createCloudflareConnectionReport } from "./cloudflare.js";
import { listVersions, createRollbackPlan, executeRollback } from "./rollback.js";
import { createComposeChangeSet, type ComposeStep } from "./compose.js";
import { createEnvReport, type EnvReport } from "./env.js";
import { writeOpenReport } from "./open-report.js";
import {
  printChangeSet,
  printCost,
  printDeploy,
  printDoctor,
  printCloudflareConnection,
  printEnvReport,
  printJson,
  printPlan,
  printProgress,
  printProvision,
  printVerify
} from "./output.js";
import { applyChangeSet, renderPatch } from "./patches.js";
import { createPlan } from "./plan.js";
import { detectProject } from "./project.js";
import { createVercelMigration } from "./migrate.js";
import { createProgress } from "./progress.js";
import { explainIssue, listExplainableIds } from "./explain.js";
import { saveBaseline, diffBaseline } from "./baseline.js";
import { diagnoseError } from "./diagnose.js";
import { writeManifest, createRemoveChangeSet, applyRemove } from "./manifest.js";
import { whyFile } from "./why.js";
import { applyProvisionPlan, createProvisionPlan } from "./provision.js";
import { createFixChangeSet, createAddOnChangeSet, externalIntegrationAddOn } from "./addon-dispatch.js";
import { runVerify, runRuntimeCheck } from "./verify.js";
import { redactSecrets } from "./redact.js";
import { setColorEnabled, c, sym, banner, startSpinner, splash, playVersus, visibleWidth } from "./ui.js";
import {
  cloudflareAuthStatus,
  cloudflareAuthStatusAsync,
  formatCloudflareAuthStatus,
  formatVercelAuthStatus,
  vercelAuthStatus,
  vercelAuthStatusAsync,
  type LoginStatus
} from "./auth-status.js";
import type { ChangeSet } from "./types.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // hard guard: never emit ANSI when an agent/machine is the consumer.
  if (hasFlag(args, "no-color") || hasFlag(args, "json") || getFlag(args, "format") === "patch") {
    setColorEnabled(false);
  }

  const cwd = path.resolve(getFlag(args, "cwd") ?? process.cwd());

  if (args.command === "help" || hasFlag(args, "help") || hasFlag(args, "h")) {
    // bare `flarecel` in a real terminal: play the boot animation first.
    if (process.argv.slice(2).length === 0 && process.stdout.isTTY) {
      await playVersus();
      console.log("");
    }
    const full = hasFlag(args, "all") || hasFlag(args, "full");
    if (!full && process.stdout.isTTY && !hasFlag(args, "no-color")) {
      await printCompactHelpWithInlineAuth(cwd);
      return;
    }
    printHelp(cwd, full, full ? null : createAuthReport(cwd, 2500));
    return;
  }

  if (args.command === "vs") {
    await playVersus();
    return;
  }

  if (args.command === "menu") {
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      printHelp(cwd, true); // non-interactive: degrade to the static surface
      return;
    }
    await startMenu(process.argv[1], cwd);
    return;
  }

  if (args.command === "auth") {
    if (hasFlag(args, "preview-animation")) {
      console.log(banner("Auth animation"));
      console.log("");
      if (shouldPulseVercelTitle()) await printPulsingVercelTitle();
      else {
        console.log(authSetupTitle("Vercel"));
        console.log(c.gray("Animation preview needs a real TTY with color enabled."));
      }
      return;
    }

    const target = args.positionals[0];
    if (target) {
      await handleAuthLogin(cwd, target, args);
      return;
    }
    const report = await createAuthReportWithSpinner(cwd, hasFlag(args, "json") ? null : "Checking auth status…", 8000);
    if (hasFlag(args, "json")) printJson(report);
    else await printAuthReport(report);
    return;
  }

  if (args.command === "catalog") {
    const sub = args.positionals[0] ?? "list";
    if (sub !== "list") { fail(`Unknown catalog subcommand: ${sub}. Try "flarecel catalog list".`); process.exitCode = 4; return; }
    let entries;
    try {
      entries = listCatalog(cwd, ADD_ONS);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      process.exitCode = 4;
      return;
    }
    if (hasFlag(args, "json")) { printJson({ addOns: entries }); return; }
    console.log(banner("Add-on catalog"));
    console.log("");
    for (const e of entries) {
      const src = e.source === "project" ? c.yellow("project override")
        : e.source === "catalog" ? c.magenta("catalog")
        : c.gray("built-in");
      console.log(`${c.green(sym.bullet)} ${c.bold(e.name)} ${c.dim(sym.dot)} ${src}`);
      if (e.title !== e.name) console.log(`  ${c.gray(e.title)}`);
      console.log(`  ${c.dim(sym.arrow)} ${c.cyan(`flarecel add ${e.name}`)}`);
    }
    console.log("");
    console.log(c.dim(`${entries.length} add-ons \u00b7 built-ins + bundled catalog + your .flarecel/addons/*.json.`));
    return;
  }

  const ctx = await detectProject(cwd);

  if (args.command === "progress" || args.command === "onboard" || args.command === "onboarding") {
    const report = createProgress(ctx);
    if (hasFlag(args, "json")) printJson(report);
    else printProgress(report);
    return;
  }

  if (args.command === "cloudflare") {
    const spin = hasFlag(args, "json") ? null : startSpinner("Talking to Cloudflare…");
    const report = await createCloudflareConnectionReport(ctx);
    spin?.stop();
    if (hasFlag(args, "json")) printJson(report);
    else printCloudflareConnection(report);
    process.exitCode = exitCodeForCloudflareConnection(report.status);
    return;
  }

  if (args.command === "env") {
    const report = await createEnvReport(ctx, { secretsOnly: hasFlag(args, "secrets") });
    if (hasFlag(args, "json")) printJson(report);
    else printEnvReport(report);
    process.exitCode = exitCodeForEnvReport(report);
    return;
  }

  if (args.command === "secrets") {
    const sub = args.positionals.shift() ?? "plan";
    if (sub !== "plan") {
      fail("Supported: `flarecel secrets plan --json`.");
      process.exitCode = 4;
      return;
    }
    const report = await createEnvReport(ctx, { secretsOnly: true });
    if (hasFlag(args, "json")) printJson(report);
    else printEnvReport(report);
    process.exitCode = exitCodeForEnvReport(report);
    return;
  }

  if (args.command === "doctor") {
    const report = runDoctor(ctx);
    if (hasFlag(args, "fix")) {
      await runDoctorFix(cwd, ctx, args, report);
      return;
    }
    if (hasFlag(args, "baseline")) {
      const p = await saveBaseline(cwd, report);
      if (hasFlag(args, "json")) printJson({ status: "saved", path: p });
      else console.log(`Baseline saved to ${p}`);
      return;
    }
    if (hasFlag(args, "diff")) {
      const diff = await diffBaseline(cwd, report);
      if (!diff) { fail("No baseline found. Run flarecel doctor --baseline first."); process.exitCode = 4; return; }
      if (hasFlag(args, "json")) printJson(diff);
      else {
        console.log(`New issues: ${diff.new.length}`);
        for (const i of diff.new) console.log(`  + [${i.severity}] ${i.title}`);
        console.log(`Resolved: ${diff.resolved.length}`);
        for (const i of diff.resolved) console.log(`  - ${i.title}`);
      }
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
    const addOnName = args.positionals.shift();
    if (!addOnName) {
      fail("Missing add-on name. Example: flarecel add r2 uploads");
      process.exitCode = 4;
      return;
    }

    // remote add-on: fetch + validate via the no-code pipeline. Network-flagged
    // and never auto-applied unless the user explicitly passes --trust.
    if (isRemoteAddonRef(addOnName)) {
      let remote;
      try {
        remote = await fetchRemoteAddon(addOnName);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        process.exitCode = 4;
        return;
      }
      const changeSet = await externalIntegrationAddOn(ctx, remote.spec);
      const trusted = hasFlag(args, "trust") && hasFlag(args, "apply") && hasFlag(args, "yes");
      if (!trusted) {
        // show the spec for review; do not write, even with --apply --yes.
        if (hasFlag(args, "json")) printJson({ ...changeSet, status: "review-required", source: "remote", url: addOnName });
        else {
          printChangeSet({ ...changeSet, status: changeSet.status });
          console.log("");
          console.log(`${c.yellow(sym.warn)} ${c.gray("Remote add-on. Review the change set above, then re-run with --apply --yes --trust to write.")}`);
        }
        process.exitCode = 5;
        return;
      }
      const applied = await applyChangeSet(cwd, changeSet);
      if (applied.status === "applied") await writeManifest(cwd, remote.name, changeSet);
      if (hasFlag(args, "json")) printJson(applied);
      else printChangeSet(applied);
      return;
    }

    const changeSet = await createAddOnChangeSet(ctx, addOnName, {
      positionals: args.positionals,
      flags: args.flags
    });
    await handleChangeSet(cwd, args, changeSet, addOnName);
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

  if (args.command === "diagnose") {
    let text = args.positionals.join(" ");
    if (!text && !process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      text = Buffer.concat(chunks).toString("utf8");
    }
    if (!text) { fail("Provide error text as an argument, or pipe it via stdin."); process.exitCode = 4; return; }
    const matches = diagnoseError(text);
    if (hasFlag(args, "json")) printJson({ matches });
    else if (matches.length === 0) console.log("No known patterns matched.");
    else for (const m of matches) console.log(`${m.explanation}\n  → ${m.suggestion}\n`);
    return;
  }

  if (args.command === "why") {
    const filePath = args.positionals.shift();
    if (!filePath) { fail("Usage: flarecel why <file-path>"); process.exitCode = 4; return; }
    const result = whyFile(cwd, filePath);
    if (hasFlag(args, "json")) printJson(result);
    else if (result.sources.length === 0) console.log(`No add-on manifest found for ${filePath}. Run flarecel add <add-on> --apply --yes first.`);
    else for (const s of result.sources) console.log(`${s.addOn} (${s.timestamp}): ${s.reason}`);
    return;
  }

  if (args.command === "remove") {
    const addOn = args.positionals.shift();
    if (!addOn) { fail("Usage: flarecel remove <add-on>"); process.exitCode = 4; return; }
    const result = await createRemoveChangeSet(cwd, addOn, hasFlag(args, "force"));
    if (result.status === "not-found") { fail(`No manifest for "${addOn}". Only applied add-ons can be removed.`); process.exitCode = 4; return; }
    if (result.status === "refused") {
      fail(`Files modified since apply. Use --force to revert anyway.`);
      for (const c of result.conflicts) console.error(`  ${c.path} (changed)`);
      process.exitCode = 5; return;
    }
    if (hasFlag(args, "apply") && hasFlag(args, "yes")) {
      const applied = await applyRemove(cwd, result);
      if (hasFlag(args, "json")) printJson(applied);
      else console.log(`Removed ${addOn}: ${applied.changes.length} file(s) reverted.`);
    } else {
      if (hasFlag(args, "json")) printJson(result);
      else { console.log(`Would revert ${result.changes.length} file(s) from ${addOn}.`); for (const c of result.changes) console.log(`  ${c.path}`); }
    }
    return;
  }

  if (args.command === "migrate") {
    const target = args.positionals.shift();
    if (target === "secrets") {
      const vercelAuth = vercelAuthStatus(cwd, 3000);
      const changeSet = { ...(await createSecretsMigration(ctx)), vercelAuth };
      if (hasFlag(args, "json")) printJson(changeSet);
      else printChangeSet(changeSet);
      if (changeSet.status === "error") process.exitCode = 3;
      return;
    }
    if (target !== "vercel") {
      fail("Supported: `flarecel migrate vercel` or `flarecel migrate secrets`.");
      process.exitCode = 4;
      return;
    }
    const vercelAuth = vercelAuthStatus(cwd, 3000);
    const changeSet = { ...(await createVercelMigration(ctx)), vercelAuth };
    await handleChangeSet(cwd, args, changeSet);
    return;
  }

  if (args.command === "compose") {
    if (args.positionals.length === 0) {
      fail("Missing add-ons. Example: flarecel compose r2 + kv + observability --dry-run");
      process.exitCode = 4;
      return;
    }
    const steps = parseComposeSteps(args.positionals, args.flags);
    const changeSet = await createComposeChangeSet(ctx, steps);
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
        "get_progress",
        "preview_patch",
        "preview_compose",
        "apply_patch",
        "verify_project",
        "plan_provisioning",
        "estimate_cost",
        "deploy_preview",
        "list_recipes",
        "migrate_vercel",
        "audit_env",
        "plan_secrets",
        "explain_issue",
        "diagnose_error"
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

  if (args.command === "versions") {
    const spin = hasFlag(args, "json") ? null : startSpinner("Listing Worker versions…");
    const report = await listVersions(ctx);
    spin?.stop();
    if (hasFlag(args, "json")) printJson(report);
    else { console.log(report.stdout || report.stderr || "(no output)"); printNextActionsLine(report.nextActions); }
    process.exitCode = report.status === "failed" ? 2 : 0;
    return;
  }

  if (args.command === "rollback") {
    const versionId = args.positionals.shift();
    const plan = await createRollbackPlan(ctx, versionId);
    const wantsExecution = hasFlag(args, "yes") && !hasFlag(args, "dry-run");
    let payload = plan;
    if (wantsExecution) {
      const spin = hasFlag(args, "json") ? null : startSpinner("Rolling back production…");
      payload = await executeRollback(ctx, plan);
      spin?.stop();
    }
    if (hasFlag(args, "json")) printJson(payload);
    else {
      printWarningsLine(payload.warnings);
      if (payload.stdout || payload.stderr) console.log(payload.stdout || payload.stderr);
      printNextActionsLine(payload.nextActions);
    }
    if (payload.status === "confirmation-required") process.exitCode = 5;
    else if (payload.status === "failed") process.exitCode = 2;
    return;
  }

  if (args.command === "cost") {
    const flags = { ...args.flags };
    let liveUsage;
    if (hasFlag(args, "cloudflare-live")) {
      const spin = hasFlag(args, "json") ? null : startSpinner("Reading real Cloudflare usage…");
      const outcome = await fetchCloudflareUsage(ctx);
      spin?.stop();
      if (outcome.ok) {
        liveUsage = outcome.usage;
        // real binding usage fills any flag the user did not set explicitly.
        for (const [key, value] of Object.entries(outcome.metered)) {
          if (flags[key] === undefined) flags[key] = value;
        }
      } else {
        const detail = redactSecrets(outcome.error.detail);
        const nextActions = [
          ...(outcome.error.nextAction ? [outcome.error.nextAction] : []),
          "Run flarecel cost --json without --cloudflare-live for an assumption-based estimate."
        ];
        if (hasFlag(args, "json")) {
          printJson({
            status: "error",
            command: "cost",
            usageSource: "cloudflare-live",
            error: {
              reason: outcome.error.reason,
              detail,
              nextAction: outcome.error.nextAction
            },
            nextActions
          });
        } else {
          fail(`Could not read live Cloudflare usage: ${detail}`);
          printNextActionsLine(nextActions);
        }
        process.exitCode = liveCloudflareCostExitCode(outcome.error.reason);
        return;
      }
    }
    let vercelAuth;
    if (flags.compare === "vercel" && hasFlag(args, "vercel-live") && typeof flags["vercel-monthly-usd"] !== "string") {
      vercelAuth = vercelAuthStatus(cwd, 3000);
      if (vercelAuth.state === "in") {
        const usage = await fetchVercelUsage(cwd);
        if (usage) flags["vercel-live-usd"] = String(usage.monthlyUsd);
        else fail("Could not read live Vercel usage. Falling back to estimate.");
      } else {
        fail("Vercel live usage needs an authenticated Vercel CLI. Falling back to estimate.");
      }
    }
    const report = createCostEstimate(ctx, flags, liveUsage);
    if (vercelAuth) report.vercelAuth = vercelAuth;
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

  // re-detect after a real apply so verify reflects the patched state.
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

// split a `+`-separated add-on list into compose steps. Each segment's first
// token is the add-on name; remaining tokens are its positionals. Flags are
// parsed globally and shared across steps (each add-on reads only what it
// knows). For per-add-on flag fidelity, agents should use the MCP
// preview_compose tool, which takes a structured add-on list.
function parseComposeSteps(positionals: string[], flags: Record<string, string | boolean>): ComposeStep[] {
  const steps: ComposeStep[] = [];
  let current: string[] = [];
  for (const token of positionals) {
    if (token === "+") {
      if (current.length > 0) { steps.push(toComposeStep(current, flags)); current = []; }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) steps.push(toComposeStep(current, flags));
  return steps;
}

function toComposeStep(tokens: string[], flags: Record<string, string | boolean>): ComposeStep {
  const [addOn, ...rest] = tokens;
  return { addOn, positionals: rest, flags };
}

async function handleChangeSet(cwd: string, args: ReturnType<typeof parseArgs>, changeSet: ChangeSet, addOn?: string): Promise<void> {
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
    if (addOn && applied.status === "applied") await writeManifest(cwd, addOn, changeSet);
    const payload = changeSet.vercelAuth ? { ...applied, vercelAuth: changeSet.vercelAuth } : applied;
    if (hasFlag(args, "json")) printJson(payload);
    else printChangeSet(payload);
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

interface AuthReport {
  cloudflare: LoginStatus;
  vercel: LoginStatus;
  commands: {
    cloudflare: string[];
    vercel: string[];
  };
  notes: string[];
}

interface AuthCheckingDisplay {
  state: "checking";
  frame: string;
}

type StartupAuthDisplay = AuthReport | AuthCheckingDisplay;

interface AuthLoginPlan {
  provider: "cloudflare" | "vercel" | "unknown";
  status: "planned" | "unsupported";
  command: string[];
  message: string;
  nextActions: string[];
}

function createAuthReport(cwd: string, timeoutMs = 2500): AuthReport {
  return createAuthReportFromStatuses(cloudflareAuthStatus(cwd, timeoutMs), vercelAuthStatus(cwd, timeoutMs));
}

async function createAuthReportAsync(cwd: string, timeoutMs = 3500): Promise<AuthReport> {
  const [cloudflare, vercel] = await Promise.all([
    cloudflareAuthStatusAsync(cwd, timeoutMs),
    vercelAuthStatusAsync(cwd, timeoutMs)
  ]);
  return createAuthReportFromStatuses(cloudflare, vercel);
}

async function createAuthReportWithSpinner(cwd: string, label: string | null, timeoutMs = 3500): Promise<AuthReport> {
  const spin = label ? startSpinner(label) : null;
  try {
    return await createAuthReportAsync(cwd, timeoutMs);
  } finally {
    spin?.stop();
  }
}

async function printCompactHelpWithInlineAuth(cwd: string): Promise<void> {
  const frames = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
  let frameIndex = 0;
  const cols = process.stdout.columns ?? 80;

  // physical rows a block occupies once the terminal wraps it. Counting logical
  // "\n" is what stacked the banner before; we count wrapped rows instead so the
  // cursor-up lands exactly at the top of the auth region.
  const physicalRows = (block: string): number =>
    block.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(visibleWidth(line) / cols)), 0);

  const { head, tail } = compactHelpParts();
  let authRows = 0;

  // render ONLY the two provider lines, in place. Head stays put above; the
  // tail is withheld until auth resolves, so the auth lines are the last thing
  // on screen and we never redraw wrappable help text.
  const renderAuth = (auth: StartupAuthDisplay): void => {
    const block = compactStartupAuthSection(auth);
    if (authRows > 0) process.stdout.write(`\x1b[${authRows}A\x1b[J`);
    process.stdout.write(`${block}\n`);
    authRows = physicalRows(block);
  };

  process.stdout.write("\x1b[?25l");
  process.stdout.write(`${head}\n`); // help head, including the "Auth" title
  renderAuth({ state: "checking", frame: frames[frameIndex] });
  const timer = setInterval(() => {
    frameIndex = (frameIndex + 1) % frames.length;
    renderAuth({ state: "checking", frame: frames[frameIndex] });
  }, 120);
  timer.unref?.();

  try {
    // match the `auth` command's 8000ms budget: wrangler whoami can cold-start
    // in ~3s, and a tighter timeout was racing it to a false "unknown".
    const report = await createAuthReportAsync(cwd, 8000);
    clearInterval(timer);
    renderAuth(report);
    process.stdout.write(tail);
  } finally {
    clearInterval(timer);
    process.stdout.write("\x1b[?25h");
  }
}

function createAuthReportFromStatuses(cloudflare: LoginStatus, vercel: LoginStatus): AuthReport {
  return {
    cloudflare,
    vercel,
    commands: {
      cloudflare: [
        "npm install",
        "flarecel auth cloudflare",
        "flarecel verify --json"
      ],
      vercel: [
        "npm i -g vercel",
        "flarecel auth vercel",
        "vercel link",
        "flarecel migrate vercel --dry-run"
      ]
    },
    notes: [
      "Cloudflare auth is required for provisioning, preview deploys, production deploys, versions, and rollback.",
      "Vercel auth is optional; it is only used for migration helpers and live Vercel bill comparison.",
      "Flarecel never stores or prints tokens."
    ]
  };
}

async function handleAuthLogin(cwd: string, target: string, args: ReturnType<typeof parseArgs>): Promise<void> {
  const plan = createAuthLoginPlan(cwd, target);
  if (hasFlag(args, "json")) {
    printJson(plan);
    process.exitCode = plan.status === "unsupported" ? 4 : 0;
    return;
  }

  if (plan.status === "unsupported") {
    fail(plan.message);
    printNextActionsLine(plan.nextActions);
    process.exitCode = 4;
    return;
  }

  if (hasFlag(args, "dry-run")) {
    console.log(banner("Auth"));
    console.log("");
    console.log(`${c.gray("Would run:")} ${c.white(plan.command.join(" "))}`);
    console.log(c.gray(plan.message));
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("Interactive auth requires a terminal. Re-run this command in a TTY, or use --dry-run --json to inspect it.");
    printNextActionsLine(plan.nextActions);
    process.exitCode = 5;
    return;
  }

  console.log(banner("Auth"));
  console.log("");
  console.log(`${c.gray("Running:")} ${c.white(plan.command.join(" "))}`);
  console.log(c.gray(plan.message));
  console.log("");

  const [command, ...commandArgs] = plan.command;
  const providerName = authProviderName(plan.provider);
  const spin = startSpinner(`Waiting for ${providerName} auth…`);
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, finalLine: string): void => {
      if (settled) return;
      settled = true;
      spin.stop(finalLine);
      process.exitCode = exitCode ?? 1;
      resolve();
    };

    const child = spawn(command, commandArgs, { cwd, stdio: "inherit" });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      spin.stop(`${c.red(sym.err)} Auth command could not start.`);
      fail(error.message);
      printNextActionsLine(plan.nextActions);
      process.exitCode = 4;
      resolve();
    });
    child.on("close", (code) => {
      finish(code, code === 0
        ? `${c.green(sym.ok)} ${providerName} auth finished.`
        : `${c.red(sym.err)} ${providerName} auth exited with code ${code ?? 1}.`);
    });
  });
}

function authProviderName(provider: AuthLoginPlan["provider"]): string {
  if (provider === "vercel") return "Vercel";
  if (provider === "cloudflare") return "Cloudflare";
  return "Auth";
}

function createAuthLoginPlan(cwd: string, target: string): AuthLoginPlan {
  const normalized = target.toLowerCase();
  if (normalized === "vercel" || normalized === "vc") {
    return {
      provider: "vercel",
      status: "planned",
      command: [resolveCliCommand(cwd, "vercel"), "login"],
      message: "Hands off to the official Vercel CLI login flow. Flarecel does not store tokens.",
      nextActions: ["npm i -g vercel", "flarecel auth vercel", "vercel link"]
    };
  }

  if (normalized === "cloudflare" || normalized === "cf" || normalized === "wrangler") {
    return {
      provider: "cloudflare",
      status: "planned",
      command: [resolveCliCommand(cwd, "wrangler"), "login"],
      message: "Hands off to the official Wrangler login flow. Flarecel does not store tokens.",
      nextActions: ["npm install", "flarecel auth cloudflare", "flarecel verify --json"]
    };
  }

  return {
    provider: "unknown",
    status: "unsupported",
    command: [],
    message: `Unknown auth provider "${target}". Supported: cloudflare, cf, wrangler, vercel.`,
    nextActions: ["flarecel auth cloudflare", "flarecel auth vercel"]
  };
}

function resolveCliCommand(cwd: string, name: "wrangler" | "vercel"): string {
  const bin = process.platform === "win32" ? `${name}.cmd` : name;
  const local = path.join(cwd, "node_modules", ".bin", bin);
  return existsSync(local) ? local : name;
}

async function printAuthReport(report: AuthReport): Promise<void> {
  console.log(banner("Auth"));
  console.log("");
  printAuthStatusLines(report);
  console.log("");
  await printAuthSetupBlock("Cloudflare", report.commands.cloudflare);
  console.log("");
  await printAuthSetupBlock("Vercel", report.commands.vercel);
  console.log("");
  for (const note of report.notes) console.log(`${c.gray(sym.bullet)} ${c.gray(note)}`);
}

async function printAuthSetupBlock(provider: "Cloudflare" | "Vercel", commands: string[]): Promise<void> {
  if (provider === "Vercel" && shouldPulseVercelTitle()) {
    await printPulsingVercelTitle();
  } else {
    console.log(authSetupTitle(provider));
  }
  for (const cmd of commands) console.log(`${c.gray(sym.arrow)} ${formatSetupCommand(cmd)}`);
}

function authSetupTitle(provider: "Cloudflare" | "Vercel", paint?: (text: string) => string): string {
  const providerText = provider === "Cloudflare" ? c.orange(provider) : (paint ?? c.white)(provider);
  return c.bold(`${providerText} ${c.gray("setup")}`);
}

async function printPulsingVercelTitle(): Promise<void> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const frames = [
    c.white,
    c.softWhite,
    c.silver,
    c.mutedWhite,
    c.silver,
    c.softWhite,
    c.white,
    c.softWhite,
    c.silver,
    c.softWhite,
    c.white
  ];
  for (const [index, paint] of frames.entries()) {
    process.stdout.write(`${index === 0 ? "" : "\r"}${authSetupTitle("Vercel", paint)}`);
    await sleep(95);
  }
  process.stdout.write("\n");
}

function shouldPulseVercelTitle(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.TERM === "dumb") return false;
  if (process.env.NO_COLOR && (!process.env.FORCE_COLOR || process.env.FORCE_COLOR === "0")) return false;
  return true;
}

function formatSetupCommand(command: string): string {
  const [bin, ...rest] = command.split(" ");
  return `${c.white(bin)}${rest.length > 0 ? ` ${c.gray(rest.join(" "))}` : ""}`;
}

function printStartupAuthSection(auth: StartupAuthDisplay): void {
  console.log(compactStartupAuthSection(auth));
}

// the two provider lines only. The "Auth" title sits in the help head and the
// "Setup" line in the tail, so the startup animator can spin on just these two.
function compactStartupAuthSection(auth: StartupAuthDisplay): string {
  if (isAuthCheckingDisplay(auth)) {
    return [
      authCheckingLine("Cloudflare", auth.frame),
      authCheckingLine("Vercel", auth.frame)
    ].join("\n");
  }
  return [
    authProviderLine("Cloudflare", authStatusText(formatCloudflareAuthStatus(auth.cloudflare), "Cloudflare"), auth.cloudflare.state),
    authProviderLine("Vercel", authStatusText(formatVercelAuthStatus(auth.vercel), "Vercel"), auth.vercel.state)
  ].join("\n");
}

function isAuthCheckingDisplay(auth: StartupAuthDisplay): auth is AuthCheckingDisplay {
  return "state" in auth && auth.state === "checking";
}

function authCheckingLine(label: string, frame: string): string {
  return `${c.white(label.padEnd(13))}${c.orange(frame)} ${c.gray("checking")}`;
}

function printAuthStatusLines(report: Pick<AuthReport, "cloudflare" | "vercel">): void {
  console.log(authProviderLine("Cloudflare", authStatusText(formatCloudflareAuthStatus(report.cloudflare), "Cloudflare"), report.cloudflare.state));
  console.log(authProviderLine("Vercel", authStatusText(formatVercelAuthStatus(report.vercel), "Vercel"), report.vercel.state));
}

function authStatusText(line: string, label: string): string {
  return line.startsWith(`${label}: `) ? line.slice(label.length + 2) : line;
}

function authProviderLine(label: string, text: string, state: LoginStatus["state"]): string {
  return `${c.white(label.padEnd(13))}${paintAuthStatus(text, state)}`;
}

function paintAuthStatus(text: string, state: LoginStatus["state"]): string {
  if (state === "in") return c.green(text);
  const [head, ...rest] = text.split(" · ");
  const tail = rest.length > 0 ? ` ${c.gray(sym.dot)} ${c.gray(rest.join(" · "))}` : "";
  return `${c.yellow(head)}${tail}`;
}

function sectionTitle(text: string): string {
  return `${c.orange(sym.bullet)} ${c.bold(c.orange(text))}`;
}

function startupCommand(command: string, paint: (s: string) => string, description: string): string {
  return `${paint(command.padEnd(24))}${c.gray(description)}`;
}

function startupPath(): string {
  return c.gray(`doctor ${sym.arrow} plan ${sym.arrow} fix --dry-run ${sym.arrow} fix --apply --yes ${sym.arrow} provision ${sym.arrow} verify ${sym.arrow} deploy --preview ${sym.arrow} deploy --production`);
}

function printHelp(cwd: string, full = false, startupAuthReport: AuthReport | null = null): void {
  if (!full) {
    process.stdout.write(compactHelpText(cwd, startupAuthReport ?? createAuthReport(cwd, 2500)));
    return;
  }

  console.log(splash());
  console.log("");
  console.log(c.dim("Agent-friendly Cloudflare Workers deployment assistant."));
  console.log("");
  console.log(c.bold("Command reference"));
  console.log("");
  const groups = COMMAND_GROUPS;
  for (const group of groups) {
    console.log(`${c.bold(group.paint(group.title))}`);
    for (const cmd of group.cmds) console.log(`  ${group.paint("flarecel " + cmd)}`);
    console.log("");
  }

  console.log(`${c.dim("Global flags:")} ${c.gray("--json  --dry-run  --format patch  --yes  --no-color  --cwd <path>")}`);
  console.log(`${c.dim("Interactive:")}  ${c.cyan("flarecel menu")} ${c.gray("— scrollable, collapsible command menu")}`);
  console.log(`${c.dim("Agent loop:")}   ${c.gray("doctor \u2192 plan \u2192 fix --dry-run \u2192 fix --apply --yes \u2192 provision \u2192 verify \u2192 deploy --preview \u2192 deploy --production")}`);

  if (full) {
    console.log("");
    console.log(c.bold("All add-ons"));
    for (const r of listAddOnCommands()) console.log(`  ${c.magenta("flarecel add " + r)}`);
  }
}

function compactHelpText(cwd: string, auth: StartupAuthDisplay): string {
  const { head, tail } = compactHelpParts();
  return [head, compactStartupAuthSection(auth), tail].join("\n");
}

// head is everything down to (and including) the "Auth" title; tail is the
// setup line and everything below. The two provider lines live between them so
// the startup animator can hold the tail and spin only on the auth region.
function compactHelpParts(): { head: string; tail: string } {
  const head = [
    splash(),
    "",
    c.dim("Agent-friendly Cloudflare Workers deployment assistant."),
    "",
    sectionTitle("Start here"),
    startupCommand("flarecel menu", c.white, "interactive picker with explanations"),
    startupCommand("flarecel progress", c.white, "plain-language project map"),
    startupCommand("flarecel doctor", c.white, "scan Cloudflare readiness"),
    startupCommand("flarecel cloudflare", c.white, "compare app needs to account"),
    "",
    sectionTitle("Auth")
  ].join("\n");
  const tail = [
    `${c.gray("Setup:".padEnd(13))}${c.gray("flarecel auth vercel  or  flarecel auth cf")}`,
    "",
    sectionTitle("Common path"),
    startupPath(),
    "",
    `${c.gray("Agents:")}      ${c.white("flarecel doctor --json")}`,
    `${c.gray("Everything:")}  ${c.white("flarecel help --all")}`,
    `${c.gray("Global flags:")} ${c.dim("--json  --dry-run  --format patch  --yes  --no-color  --cwd <path>")}`,
    ""
  ].join("\n");
  return { head, tail };
}

function fail(message: string): void {
  console.error(`Error: ${message}`);
}

function exitCodeForCloudflareConnection(status: "ready" | "action-required" | "needs-auth" | "blocked"): number {
  if (status === "ready") return 0;
  if (status === "action-required") return 1;
  if (status === "needs-auth") return 3;
  return 2;
}

function exitCodeForEnvReport(report: EnvReport): number {
  if (report.status === "empty" || report.status === "ready") return 0;
  return report.summary.secret > 0 ? 3 : 1;
}

function liveCloudflareCostExitCode(reason: "no-token" | "no-account" | "request-failed" | "no-data"): number {
  if (reason === "no-token" || reason === "no-account") return 3;
  return 2;
}

function printNextActionsLine(actions: string[]): void {
  if (actions.length === 0) return;
  console.log("");
  for (const a of actions) console.log(`${c.dim(sym.arrow)} ${c.cyan(a)}`);
}

function printWarningsLine(warnings: string[]): void {
  for (const w of warnings) console.log(`${c.yellow(sym.warn)} ${c.gray(w)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
