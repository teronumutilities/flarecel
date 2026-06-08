import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");

smokeR2AddOn();
smokeBetterAuthAddOn();
smokeDryRunApplyParity();
smokeCloudflareFeatureAddOns();
smokeAiAndObservabilityAddOns();
smokeStatefulAndBrowserAddOns();
smokeHyperdriveQueueProvision();

// richer provisioning: Hyperdrive (manual, no secret embedded) + consumer-only queue.
function smokeHyperdriveQueueProvision() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-prov-extra-"));
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "app" }));
    writeFileSync(path.join(tmp, "wrangler.json"), JSON.stringify({
      name: "app", main: "x.ts",
      hyperdrive: [{ binding: "HYPERDRIVE", id: "replace-with-hyperdrive-id" }],
      queues: { consumers: [{ queue: "emails" }] }
    }));
  const report = JSON.parse(run(["provision", "--json", "--cwd", tmp]).stdout);
  if (!report.actions?.some((a) => a.id === "queue:emails" && (a.command ?? []).join(" ") === "wrangler queues create emails")) {
    throw new Error("Expected consumer-only queue to get a create action.");
  }
  if (!report.warnings?.some((warning) => warning.includes("multiple accounts"))) {
    throw new Error("Expected provisioning plan to warn about account selection before account-specific apply.");
  }
  const hp = report.actions?.find((a) => a.id === "hyperdrive:HYPERDRIVE");
    if (!hp) throw new Error("Expected a Hyperdrive provisioning action.");
    if ((hp.command ?? []).length !== 0) throw new Error("Hyperdrive action must not auto-run (connection string is a secret).");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeR2AddOn() {
  const tmp = copyFixture("flarecel-r2-");
  try {
    const result = run(["add", "r2", "uploads", "--dry-run", "--json", "--cwd", tmp]);
    assertEqual(result.status, 0, result.stderr);
    const changeSet = JSON.parse(result.stdout);
    assertGeneratedTypescriptParses(changeSet);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeBetterAuthAddOn() {
  const tmp = copyFixture("flarecel-auth-");
  try {
    const dryRun = run(["add", "auth", "better-auth", "--db", "d1", "--orm", "drizzle", "--dry-run", "--json", "--cwd", tmp]);
    assertEqual(dryRun.status, 0, dryRun.stderr);
    const changeSet = JSON.parse(dryRun.stdout);

    assertNoDuplicatePaths(changeSet);
    assertHasChange(changeSet, "app/api/auth/[...all]/route.ts");
    assertGeneratedTypescriptParses(changeSet);

    const apply = run(["add", "auth", "better-auth", "--db", "d1", "--orm", "drizzle", "--apply", "--yes", "--json", "--cwd", tmp]);
    assertEqual(apply.status, 0, apply.stderr);

    const provision = run(["provision", "--json", "--cwd", tmp]);
    assertEqual(provision.status, 0, provision.stderr);
    const provisionReport = JSON.parse(provision.stdout);
    if (!provisionReport.actions?.some((action) => (action.command ?? []).join(" ") === "wrangler d1 create next-basic-auth")) {
      throw new Error("Expected provisioning plan to include D1 create command.");
    }

    const verify = run(["verify", "--json", "--cwd", tmp]);
    const verifyReport = JSON.parse(verify.stdout);
    assertCheck(verifyReport, "better-auth-installed", "passed");
    assertCheck(verifyReport, "better-auth-route", "passed");
    assertCheck(verifyReport, "better-auth-d1-binding", "passed");
    assertCheck(verifyReport, "better-auth-d1-database-id", "warning");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeDryRunApplyParity() {
  // the core agent trust contract: applied bytes must equal previewed bytes
  // for the same starting project state.
  const addOns = [
    ["add", "auth", "better-auth", "--db", "d1", "--orm", "drizzle"],
    ["add", "db", "d1", "--orm", "drizzle"],
    ["add", "durable-object", "room"]
  ];

  for (const addOn of addOns) {
    const tmp = copyFixture("flarecel-parity-");
    try {
      const dryRun = run([...addOn, "--dry-run", "--json", "--cwd", tmp]);
      assertEqual(dryRun.status, 0, dryRun.stderr);
      const changeSet = JSON.parse(dryRun.stdout);

      const apply = run([...addOn, "--apply", "--yes", "--json", "--cwd", tmp]);
      assertEqual(apply.status, 0, apply.stderr);

      for (const change of changeSet.changes ?? []) {
        const written = readFileSync(path.join(tmp, change.path), "utf8");
        if (written !== change.after) {
          throw new Error(`Parity mismatch for ${addOn.join(" ")} at ${change.path}: applied bytes differ from previewed bytes.`);
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function smokeCloudflareFeatureAddOns() {
  smokeDryRunAddOn(
    ["add", "db", "d1", "--orm", "drizzle", "--dry-run", "--json"],
    ["db/schema.ts", "lib/db.ts", "drizzle.config.ts"]
  );

  const kvTmp = copyFixture("flarecel-kv-");
  try {
    const apply = run(["add", "kv", "cache", "--apply", "--yes", "--json", "--cwd", kvTmp]);
    assertEqual(apply.status, 0, apply.stderr);

    const provision = run(["provision", "--json", "--cwd", kvTmp]);
    assertEqual(provision.status, 0, provision.stderr);
    const provisionReport = JSON.parse(provision.stdout);
    if (!provisionReport.actions?.some((action) => (action.command ?? []).join(" ") === "wrangler kv namespace create CACHE")) {
      throw new Error("Expected provisioning plan to include KV namespace create command.");
    }

    const verify = run(["verify", "--json", "--cwd", kvTmp]);
    const verifyReport = JSON.parse(verify.stdout);
    assertCheck(verifyReport, "kv-binding-cache", "warning");
  } finally {
    rmSync(kvTmp, { recursive: true, force: true });
  }

  smokeDryRunAddOn(
    ["add", "turnstile", "--form", "signup", "--dry-run", "--json"],
    ["src/cloudflare/turnstile.ts", "app/api/turnstile/signup/verify/route.ts"]
  );

  const cron = smokeDryRunAddOn(
    ["add", "cron", "daily-cleanup", "--schedule", "0 0 * * *", "--dry-run", "--json"],
    ["src/cloudflare/cron/daily-cleanup.ts"]
  );
  const wrangler = cron.changes?.find((change) => change.path === "wrangler.jsonc");
  if (!wrangler?.after.includes("\"crons\"")) {
    throw new Error("Expected Cron addOn to add triggers.crons to wrangler.jsonc.");
  }

  const cronTmp = copyFixture("flarecel-cron-");
  try {
    const apply = run(["add", "cron", "daily-cleanup", "--schedule", "0 0 * * *", "--apply", "--yes", "--json", "--cwd", cronTmp]);
    assertEqual(apply.status, 0, apply.stderr);

    const verify = run(["verify", "--json", "--cwd", cronTmp]);
    const verifyReport = JSON.parse(verify.stdout);
    assertCheck(verifyReport, "cron-triggers", "passed");
  } finally {
    rmSync(cronTmp, { recursive: true, force: true });
  }
}

function smokeAiAndObservabilityAddOns() {
  const workersAiTmp = copyFixture("flarecel-workers-ai-");
  try {
    rmSync(path.join(workersAiTmp, "app", "api", "edge-risk"), { recursive: true, force: true });
    const apply = run(["add", "workers-ai", "--apply", "--yes", "--json", "--cwd", workersAiTmp]);
    assertEqual(apply.status, 0, apply.stderr);

    const verify = run(["verify", "--json", "--cwd", workersAiTmp]);
    const verifyReport = JSON.parse(verify.stdout);
    assertCheck(verifyReport, "workers-ai-binding", "passed");
  } finally {
    rmSync(workersAiTmp, { recursive: true, force: true });
  }

  const vectorizeTmp = copyFixture("flarecel-vectorize-");
  try {
    const apply = run(["add", "vectorize", "docs-search", "--dimensions", "768", "--metric", "cosine", "--apply", "--yes", "--json", "--cwd", vectorizeTmp]);
    assertEqual(apply.status, 0, apply.stderr);

    const provision = run(["provision", "--json", "--cwd", vectorizeTmp]);
    assertEqual(provision.status, 0, provision.stderr);
    const provisionReport = JSON.parse(provision.stdout);
    if (!provisionReport.actions?.some((action) => (action.command ?? []).join(" ") === "wrangler vectorize create next-basic-docs-search --dimensions=768 --metric=cosine")) {
      throw new Error("Expected provisioning plan to include Vectorize create command.");
    }
  } finally {
    rmSync(vectorizeTmp, { recursive: true, force: true });
  }

  smokeDryRunAddOn(
    ["add", "ai-gateway", "--provider", "openai", "--dry-run", "--json"],
    ["src/cloudflare/ai-gateway.ts", "docs/flarecel-ai-gateway.md"]
  );

  const observabilityTmp = copyFixture("flarecel-observability-");
  try {
    const apply = run(["add", "observability", "--sampling", "0.5", "--apply", "--yes", "--json", "--cwd", observabilityTmp]);
    assertEqual(apply.status, 0, apply.stderr);

    const verify = run(["verify", "--json", "--cwd", observabilityTmp]);
    const verifyReport = JSON.parse(verify.stdout);
    assertCheck(verifyReport, "observability-enabled", "passed");
  } finally {
    rmSync(observabilityTmp, { recursive: true, force: true });
  }
}

function smokeStatefulAndBrowserAddOns() {
  const durableTmp = copyFixture("flarecel-do-");
  try {
    const apply = run(["add", "durable-object", "room", "--apply", "--yes", "--json", "--cwd", durableTmp]);
    assertEqual(apply.status, 0, apply.stderr);

    const provision = run(["provision", "--json", "--cwd", durableTmp]);
    assertEqual(provision.status, 0, provision.stderr);
    const provisionReport = JSON.parse(provision.stdout);
    if (!provisionReport.actions?.some((action) => action.id === "durable-object:ROOM_DO" && action.status === "skipped")) {
      throw new Error("Expected provisioning plan to explain Durable Object deploy migration.");
    }

    const verify = run(["verify", "--json", "--cwd", durableTmp]);
    const verifyReport = JSON.parse(verify.stdout);
    assertCheck(verifyReport, "durable-object-binding-room-do", "passed");
    assertCheck(verifyReport, "durable-object-export-roomdurableobject", "passed");
    assertCheck(verifyReport, "durable-object-migration-roomdurableobject", "passed");
  } finally {
    rmSync(durableTmp, { recursive: true, force: true });
  }

  const workflowTmp = copyFixture("flarecel-workflow-");
  try {
    const apply = run(["add", "workflow", "onboarding", "--schedule", "0 9 * * *", "--apply", "--yes", "--json", "--cwd", workflowTmp]);
    assertEqual(apply.status, 0, apply.stderr);

    const verify = run(["verify", "--json", "--cwd", workflowTmp]);
    const verifyReport = JSON.parse(verify.stdout);
    assertCheck(verifyReport, "workflow-binding-onboarding-workflow", "passed");
    assertCheck(verifyReport, "workflow-export-onboardingworkflow", "passed");
    assertCheck(verifyReport, "observability-enabled", "passed");
  } finally {
    rmSync(workflowTmp, { recursive: true, force: true });
  }

  const browserTmp = copyFixture("flarecel-browser-");
  try {
    const apply = run(["add", "browser-run", "--apply", "--yes", "--json", "--cwd", browserTmp]);
    assertEqual(apply.status, 0, apply.stderr);

    const verify = run(["verify", "--json", "--cwd", browserTmp]);
    const verifyReport = JSON.parse(verify.stdout);
    assertCheck(verifyReport, "browser-run-binding", "passed");
    assertCheck(verifyReport, "browser-run-nodejs-compat", "passed");
  } finally {
    rmSync(browserTmp, { recursive: true, force: true });
  }

  smokeDryRunAddOn(
    ["add", "durable-object", "counter", "--dry-run", "--json"],
    ["src/cloudflare/durable-objects/counter.ts", "cloudflare-worker.ts", "app/api/durable-objects/counter/route.ts"]
  );

  smokeDryRunAddOn(
    ["add", "workflow", "importer", "--schedule", "0 9 * * *", "--dry-run", "--json"],
    ["src/cloudflare/workflows/importer.ts", "cloudflare-worker.ts", "app/api/workflows/importer/route.ts"]
  );

  smokeDryRunAddOn(
    ["add", "browser-run", "--dry-run", "--json"],
    ["src/cloudflare/browser-run.ts", "app/api/browser/screenshot/route.ts"]
  );
}

function smokeDryRunAddOn(args, expectedPaths) {
  const result = run([...args, "--cwd", fixture]);
  assertEqual(result.status, 0, result.stderr);
  const changeSet = JSON.parse(result.stdout);
  assertNoDuplicatePaths(changeSet);
  for (const expectedPath of expectedPaths) assertHasChange(changeSet, expectedPath);
  assertGeneratedTypescriptParses(changeSet);
  return changeSet;
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

function assertGeneratedTypescriptParses(changeSet) {
  for (const change of changeSet.changes ?? []) {
    if (!/\.(d\.ts|ts|tsx)$/.test(change.path)) continue;

    const sourceFile = ts.createSourceFile(
      change.path,
      change.after,
      ts.ScriptTarget.ES2022,
      true,
      change.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    if (sourceFile.parseDiagnostics.length > 0) {
      const message = sourceFile.parseDiagnostics
        .map((diagnostic) => `${change.path}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`)
        .join("\n");
      throw new Error(message);
    }
  }
}

function assertNoDuplicatePaths(changeSet) {
  const seen = new Set();
  for (const change of changeSet.changes ?? []) {
    if (seen.has(change.path)) throw new Error(`Duplicate generated path: ${change.path}`);
    seen.add(change.path);
  }
}

function assertHasChange(changeSet, filePath) {
  if (!changeSet.changes?.some((change) => change.path === filePath)) {
    throw new Error(`Expected generated file: ${filePath}`);
  }
}

function assertCheck(report, id, status) {
  const check = report.checks?.find((candidate) => candidate.id === id);
  if (!check) throw new Error(`Missing verify check: ${id}`);
  if (check.status !== status) throw new Error(`Expected ${id} to be ${status}, got ${check.status}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}
