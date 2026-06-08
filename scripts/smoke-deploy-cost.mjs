import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");

smokeCostEstimate();
smokeCostUnknownPlanDefault();
smokeCostExplicitPaid();
smokeCostExplicitFree();
smokeCloudflareLiveCostIsStrict();
smokeBlockedDeploy();
smokeReadyDeployPlan();
smokePreviewMissingWorkerExplainsBootstrap();

function smokeCostEstimate() {
  const result = run([
    "cost",
    "--json",
    "--cwd",
    fixture,
    "--requests",
    "15000000",
    "--cpu-ms",
    "7",
    "--r2-storage-gb",
    "20",
    "--r2-class-a",
    "2000000",
    "--r2-class-b",
    "20000000",
    "--kv-reads",
    "12000000",
    "--kv-writes",
    "2000000",
    "--kv-storage-gb",
    "3",
    "--workers-ai-neurons",
    "500000",
    "--vectorize-queries",
    "100000",
    "--vectorize-stored-vectors",
    "10000",
    "--vectorize-dimensions",
    "768"
  ]);

  assertEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assertEqual(report.status, "estimate");
  // no --plan was passed, so the plan is honestly UNKNOWN, but the headline
  // still leads with the conservative Paid-floor figure ($5 + $20.79 usage)
  // so existing consumers reading estimatedMonthlyUsd are unaffected.
  assertEqual(report.plan, "unknown", "default (no --plan) should be unknown");
  assertEqual(report.planAssumed, true, "unknown plan is assumed");
  assertEqual(report.planConfidence, "low", "unknown plan is low confidence");
  assertEqual(report.estimateIsRange, true, "unknown plan must be a range");
  assertEqual(report.recommendedEstimateKind, "range", "unknown plan should recommend range display");
  assertEqual(report.costBasis, "unknown-plan-range", "unknown plan should expose range basis");
  assertEqual(report.recommendedDisplay, "$0.00 - $46.58/mo", "unknown plan display should be the honest range");
  assertEqual(report.estimatedMonthlyUsd, 25.79);
  assertEqual(report.estimatedMonthlyUsdLow, 0, "unknown low end assumes Free ($0)");
  assertEqual(report.estimatedMonthlyUsdHigh, 46.58, "unknown high end = $5 floor + 2x usage");
  if (!report.lineItems?.some((item) => item.id === "kv-writes" && item.estimatedUsd === 5)) {
    throw new Error("Expected KV write cost line item.");
  }
  if (!report.lineItems?.some((item) => item.id === "workers-ai-neurons" && item.estimatedUsd === 2.2)) {
    throw new Error("Expected Workers AI cost line item.");
  }
  if (!report.lineItems?.some((item) => item.id === "vectorize-queried-dimensions" && item.estimatedUsd === 0.34)) {
    throw new Error("Expected Vectorize queried dimensions cost line item.");
  }
  if (!report.sources?.some((source) => source.url.includes("developers.cloudflare.com/workers/platform/pricing"))) {
    throw new Error("Expected Workers pricing source.");
  }
}

// default (no --plan, no --cloudflare-live): plan is unknown and the estimate is
// an honest $0-$5 baseline range, NOT a confident $5 Paid assumption.
function smokeCostUnknownPlanDefault() {
  const result = run(["cost", "--json", "--cwd", fixture]);
  assertEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assertEqual(report.plan, "unknown", "no --plan should be unknown");
  assertEqual(report.planAssumed, true);
  assertEqual(report.planConfidence, "low");
  assertEqual(report.estimateIsRange, true);
  assertEqual(report.recommendedEstimateKind, "range");
  assertEqual(report.costBasis, "unknown-plan-range");
  assertEqual(report.recommendedDisplay, "$0.00 - $5.00/mo");
  assertEqual(report.estimatedMonthlyUsdLow, 0, "Free may be $0/mo");
  assertEqual(report.estimatedMonthlyUsdHigh, 5, "Paid baseline floor is $5/mo before overages");
  assertEqual(report.estimatedMonthlyUsd, 5, "headline leads with the conservative $5 floor");
  if (report.lineItems?.some((item) => item.id === "workers-paid-subscription")) {
    throw new Error("Unknown plan must not assert the $5 Paid subscription as a line item.");
  }
  if (!report.warnings?.some((w) => w.includes("UNKNOWN"))) {
    throw new Error("Unknown plan should warn that the plan was not detected/assumed.");
  }
  if (!report.warnings?.some((w) => w.includes("$0") && w.includes("$5"))) {
    throw new Error("Unknown plan should explain Free $0 vs Paid $5.");
  }
}

// explicit --plan paid stays the conservative $5-baseline estimate.
function smokeCostExplicitPaid() {
  const result = run(["cost", "--plan", "paid", "--json", "--cwd", fixture]);
  assertEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assertEqual(report.plan, "paid");
  assertEqual(report.planAssumed, false, "explicit --plan paid is not assumed");
  assertEqual(report.planConfidence, "medium");
  assertEqual(report.recommendedEstimateKind, "single");
  assertEqual(report.costBasis, "explicit-paid");
  assertEqual(report.recommendedDisplay, "$5.00/mo");
  assertEqual(report.estimatedMonthlyUsd, 5, "paid baseline with default usage is $5");
  assertEqual(report.estimatedMonthlyUsdLow, 5, "paid low end keeps the $5 floor");
  if (!report.lineItems?.some((item) => item.id === "workers-paid-subscription" && item.estimatedUsd === 5)) {
    throw new Error("Explicit paid plan should include the $5 Workers Paid line item.");
  }
}

// explicit --plan free reports a $0 free-tier estimate.
function smokeCostExplicitFree() {
  const result = run(["cost", "--plan", "free", "--json", "--cwd", fixture]);
  assertEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assertEqual(report.plan, "free");
  assertEqual(report.planAssumed, false, "explicit --plan free is not assumed");
  assertEqual(report.planConfidence, "medium");
  assertEqual(report.recommendedEstimateKind, "single");
  assertEqual(report.costBasis, "explicit-free");
  assertEqual(report.recommendedDisplay, "$0.00/mo");
  assertEqual(report.estimatedMonthlyUsd, 0, "free tier default usage is $0");
  assertEqual(report.estimatedMonthlyUsdLow, 0);
  if (report.lineItems?.some((item) => item.id === "workers-paid-subscription")) {
    throw new Error("Free plan must not include the $5 Paid subscription line item.");
  }
}

function smokeCloudflareLiveCostIsStrict() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-live-cost-"));
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "live-cost" }));
    writeFakeWrangler(tmp);

    const result = spawnSync(process.execPath, [cli, "cost", "--cloudflare-live", "--json", "--cwd", tmp], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: "",
        HOME: path.join(tmp, "home"),
        XDG_CONFIG_HOME: path.join(tmp, "xdg"),
        WRANGLER_HOME: path.join(tmp, "wrangler-home")
      }
    });

    assertEqual(result.status, 3, result.stdout || result.stderr);
    const payload = JSON.parse(result.stdout);
    assertEqual(payload.status, "error");
    assertEqual(payload.usageSource, "cloudflare-live");
    assertEqual(payload.error.reason, "no-token");
    if (payload.lineItems) {
      throw new Error("Strict live Cloudflare cost failure should not include an assumption-based estimate.");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeBlockedDeploy() {
  const result = run(["deploy", "--preview", "--json", "--cwd", fixture]);
  assertEqual(result.status, 2, result.stdout);
  const report = JSON.parse(result.stdout);
  assertEqual(report.status, "blocked");
  assertEqual(report.executed, false);
}

function writeFakeWrangler(cwd) {
  const binDir = path.join(cwd, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  writeFileSync(bin, `#!/usr/bin/env node
process.exit(1);
`);
  chmodSync(bin, 0o755);
}

function smokeReadyDeployPlan() {
  const tmp = copyFixture("flarecel-deploy-");
  try {
    rmSync(path.join(tmp, "app", "api", "edge-risk"), { recursive: true, force: true });

    const apply = run(["add", "next-opennext", "--apply", "--yes", "--json", "--cwd", tmp]);
    assertEqual(apply.status, 0, apply.stderr);

    const preview = run(["deploy", "--preview", "--json", "--cwd", tmp]);
    assertEqual(preview.status, 0, preview.stderr);
    const previewReport = JSON.parse(preview.stdout);
    assertEqual(previewReport.status, "confirmation-required");
    assertEqual(previewReport.command.join(" "), "npm run upload");
    assertEqual(previewReport.executed, false);

    const production = run(["deploy", "--production", "--json", "--cwd", tmp]);
    assertEqual(production.status, 5, production.stdout);
    const productionReport = JSON.parse(production.stdout);
    assertEqual(productionReport.status, "confirmation-required");
    assertEqual(productionReport.command.join(" "), "npm run deploy");
    if (!productionReport.cost || typeof productionReport.cost.estimatedMonthlyUsd !== "number") {
      throw new Error("Production deploy plan should include a cost estimate.");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokePreviewMissingWorkerExplainsBootstrap() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-missing-worker-"));
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "missing-worker" }));
    writeFileSync(path.join(tmp, "wrangler.jsonc"), JSON.stringify({
      name: "missing-worker",
      main: "src/index.ts",
      compatibility_date: "2024-11-01",
      observability: { enabled: true }
    }, null, 2));
    mkdirSync(path.join(tmp, "src"), { recursive: true });
    writeFileSync(path.join(tmp, "src", "index.ts"), "export default { fetch() { return new Response('ok'); } };\n");

    const binDir = path.join(tmp, "bin");
    mkdirSync(binDir, { recursive: true });
    const npx = path.join(binDir, process.platform === "win32" ? "npx.cmd" : "npx");
    writeFileSync(npx, `#!/usr/bin/env node
console.error("This Worker does not exist on your account. [code: 10007]");
process.exit(1);
`);
    chmodSync(npx, 0o755);

    const result = run(["deploy", "--preview", "--yes", "--json", "--cwd", tmp], {
      CLOUDFLARE_API_TOKEN: "fake-token",
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assertEqual(result.status, 2, result.stdout || result.stderr);
    const report = JSON.parse(result.stdout);
    assertEqual(report.status, "failed");
    if (!report.nextActions?.some((action) => action.includes("Bootstrap it once"))) {
      throw new Error(`Expected bootstrap next action, got ${JSON.stringify(report.nextActions)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function copyFixture(prefix) {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  cpSync(fixture, tmp, { recursive: true });
  return tmp;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}
