import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");

smokeCostEstimate();
smokeBlockedDeploy();
smokeReadyDeployPlan();

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
  assertEqual(report.estimatedMonthlyUsd, 25.79);
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

function smokeBlockedDeploy() {
  const result = run(["deploy", "--preview", "--json", "--cwd", fixture]);
  assertEqual(result.status, 2, result.stdout);
  const report = JSON.parse(result.stdout);
  assertEqual(report.status, "blocked");
  assertEqual(report.executed, false);
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

function copyFixture(prefix) {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  cpSync(fixture, tmp, { recursive: true });
  return tmp;
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}
