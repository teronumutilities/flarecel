import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");

smokeMigrate();
smokeMigrateSecretSafety();
smokeMigrateSecretsChecklist();
smokeExplain();
smokeCostCompare();
smokeIsrAddOn();
smokeStripeResend();

function smokeMigrate() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-migrate-"));
  try {
    mkdirSync(path.join(tmp, "app"), { recursive: true });
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "m", dependencies: { next: "^15" } }));
    writeFileSync(path.join(tmp, "vercel.json"), JSON.stringify({
      trailingSlash: true,
      redirects: [{ source: "/old", destination: "/new", permanent: true }],
      headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
      crons: [{ path: "/api/cleanup", schedule: "0 0 * * *" }],
      rewrites: [{ source: "/a", destination: "/b" }]
    }));
    const result = run(["migrate", "vercel", "--dry-run", "--json", "--cwd", tmp]);
    assertEqual(result.status, 0, result.stderr);
    const cs = JSON.parse(result.stdout);
    assertEqual(cs.status, "planned", "migrate should be planned");
    assertHasChange(cs, "public/_redirects");
    assertHasChange(cs, "public/_headers");
    const redirects = findChange(cs, "public/_redirects").after;
    if (!redirects.includes("/old /new 301")) throw new Error("permanent redirect should map to 301");
    const wrangler = cs.changes.find((c) => c.path === "wrangler.jsonc");
    if (!wrangler || !wrangler.after.includes("\"crons\"")) throw new Error("crons should map to wrangler triggers.crons");
    if (!cs.warnings.some((w) => w.startsWith("FLAG:") && w.includes("rewrites"))) throw new Error("rewrites should be flagged");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // non-vercel target exits 4.
  const bad = run(["migrate", "netlify", "--dry-run", "--json", "--cwd", fixture]);
  assertEqual(bad.status, 4, "migrate netlify should exit 4");
}

// migrate secrets: names -> wrangler secret put checklist, NEVER values.
function smokeMigrateSecretsChecklist() {
  const bin = mkdtempSync(path.join(tmpdir(), "flarecel-fakebin-"));
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-secrets-"));
  try {
    const leak = "https://acme-secret.example";
    writeFileSync(path.join(bin, "vercel"), `#!/usr/bin/env node\nprocess.stdout.write("name value environments\\nDATABASE_URL Encrypted Production\\nNEXT_PUBLIC_URL ${leak} Production\\n");\n`);
    chmodSync(path.join(bin, "vercel"), 0o755);
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const res = spawnSync(process.execPath, [cli, "migrate", "secrets", "--json", "--cwd", tmp], { cwd: repoRoot, encoding: "utf8", env });
    const cs = JSON.parse(res.stdout);
    assertEqual(cs.status, "planned", "migrate secrets should plan with names present");
    if (!cs.nextActions.includes("wrangler secret put DATABASE_URL")) throw new Error("expected secret put checklist for DATABASE_URL");
    if (JSON.stringify(cs).includes(leak)) throw new Error("SECRET LEAK: a Vercel value appeared in migrate secrets output");
  } finally {
    rmSync(bin, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

// negative control: .env values must NEVER be copied into generated files.
function smokeMigrateSecretSafety() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-migrate-secret-"));
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "m", dependencies: { next: "^15" } }));
    writeFileSync(path.join(tmp, "vercel.json"), JSON.stringify({ trailingSlash: false }));
    const secret = "sk_live_DO_NOT_LEAK_1234567890";
    writeFileSync(path.join(tmp, ".env"), `STRIPE_SECRET_KEY=${secret}\nPUBLIC_FOO=bar\n`);
    const result = run(["migrate", "vercel", "--dry-run", "--json", "--cwd", tmp]);
    assertEqual(result.status, 0, result.stderr);
    const cs = JSON.parse(result.stdout);
    const blob = JSON.stringify(cs);
    if (blob.includes(secret)) throw new Error("SECRET LEAK: .env value appeared in migration output");
    const env = cs.changes.find((c) => c.path === ".dev.vars.example");
    if (!env || !env.after.includes("STRIPE_SECRET_KEY=")) throw new Error("env key name should be documented");
    if (env.after.includes(secret)) throw new Error("SECRET LEAK in .dev.vars.example");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeExplain() {
  const known = run(["explain", "missing-nodejs-compat", "--json", "--cwd", fixture]);
  assertEqual(known.status, 0, known.stderr);
  const explanation = JSON.parse(known.stdout);
  if (!explanation.what || !explanation.why || !explanation.change || !explanation.safety) {
    throw new Error("explanation missing one of the four beats");
  }
  assertEqual(explanation.verifiedBy, "wrangler-config", "missing-nodejs-compat should link a verify check");

  const unknown = run(["explain", "totally-made-up-id", "--json", "--cwd", fixture]);
  assertEqual(unknown.status, 4, "unknown explain id should exit 4");

  // templated ids resolve.
  const templated = run(["explain", "risky-package-bcrypt", "--json", "--cwd", fixture]);
  assertEqual(templated.status, 0, "templated id should resolve");

  const wrangler = run(["explain", "wrangler-auth", "--json", "--cwd", fixture]);
  assertEqual(wrangler.status, 0, "wrangler-auth explanation should resolve");
  if (JSON.parse(wrangler.stdout).verifiedBy !== "wrangler-auth") {
    throw new Error("wrangler-auth explanation should link to the verify check");
  }
}

function smokeCostCompare() {
  const hardrailed = run(["cost", "--compare", "vercel", "--json", "--cwd", fixture]);
  assertEqual(hardrailed.status, 0, hardrailed.stderr);
  const h = JSON.parse(hardrailed.stdout);
  if (h.vercelComparison) throw new Error("Vercel comparison should require a real bill or live CLI read");
  if (!h.warnings.some((w) => w.includes("does not invent Vercel bills"))) {
    throw new Error("hardrail warning should explain why Vercel comparison was skipped");
  }

  const override = run(["cost", "--compare", "vercel", "--vercel-monthly-usd", "200", "--json", "--cwd", fixture]);
  const o = JSON.parse(override.stdout);
  assertEqual(o.vercelComparison.source, "user-provided", "override should be user-provided");
  assertEqual(o.vercelComparison.vercelMonthlyUsd, 200, "override value should be used");
  if (typeof o.vercelComparison.savingsPct !== "number") throw new Error("savingsPct must be present");

  // partial Vercel inputs are not enough; require the actual total bill.
  const usage = run(["cost", "--compare", "vercel", "--vercel-usage-usd", "150", "--json", "--cwd", fixture]);
  const u = JSON.parse(usage.stdout);
  if (u.vercelComparison) throw new Error("partial Vercel usage should not create a comparison");

  // without --compare, no comparison block.
  const plain = run(["cost", "--json", "--cwd", fixture]);
  const plainReport = JSON.parse(plain.stdout);
  if (plainReport.vercelComparison) throw new Error("comparison should only appear with --compare vercel");

  // route grounding: fixture has routes, default traffic, so a route note must appear.
  if (typeof plainReport.assumptions["detected-routes"] !== "number") throw new Error("detected-routes assumption missing");
  if (!plainReport.warnings.some((w) => w.includes("route(s)"))) throw new Error("route grounding note missing on default traffic");

  smokeBillShock();
  smokeVercelLive();
}

// spike-prone bindings must raise an explicit bill-shock risk.
function smokeBillShock() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-billshock-"));
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "t" }));
    writeFileSync(path.join(tmp, "wrangler.json"), JSON.stringify({ name: "t", main: "x.ts", ai: { binding: "AI" } }));
    const report = JSON.parse(run(["cost", "--json", "--cwd", tmp]).stdout);
    if (!report.billShockRisks?.some((r) => r.includes("Workers AI"))) {
      throw new Error("Workers AI binding should raise a bill-shock risk");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// opt-in live path: shell out to a fake `vercel` CLI on PATH and confirm the
// real bill is parsed and labeled vercel-cli.
function smokeVercelLive() {
  const bin = mkdtempSync(path.join(tmpdir(), "flarecel-fakebin-"));
  try {
    const fake = path.join(bin, "vercel");
    writeFileSync(fake, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ totals: { billedCost: 142.5 } }));\n`);
    chmodSync(fake, 0o755);
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };

    const live = spawnSync(process.execPath, [cli, "cost", "--compare", "vercel", "--vercel-live", "--json", "--cwd", fixture], { cwd: repoRoot, encoding: "utf8", env });
    const j = JSON.parse(live.stdout);
    assertEqual(j.vercelComparison.source, "vercel-cli", "live fetch should be labeled vercel-cli");
    assertEqual(j.vercelComparison.vercelMonthlyUsd, 142.5, "live fetch should use the real billed total");

    // manual override still wins over live.
    const override = spawnSync(process.execPath, [cli, "cost", "--compare", "vercel", "--vercel-live", "--vercel-monthly-usd", "50", "--json", "--cwd", fixture], { cwd: repoRoot, encoding: "utf8", env });
    assertEqual(JSON.parse(override.stdout).vercelComparison.source, "user-provided", "explicit override beats live");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

function smokeIsrAddOn() {
  const result = run(["add", "isr", "--dry-run", "--json", "--cwd", fixture]);
  assertEqual(result.status, 0, result.stderr);
  const cs = JSON.parse(result.stdout);
  assertGeneratedTypescriptParses(cs);
  const config = cs.changes.find((c) => c.path === "open-next.config.ts");
  if (!config) throw new Error("open-next.config.ts not generated");
  for (const needle of ["r2-incremental-cache", "do-queue", "d1-next-tag-cache"]) {
    if (!config.after.includes(needle)) throw new Error(`ISR config missing ${needle}`);
  }
  const wrangler = cs.changes.find((c) => c.path === "wrangler.jsonc");
  if (!wrangler.after.includes("NEXT_INC_CACHE_R2_BUCKET")) throw new Error("ISR wrangler missing R2 cache binding");
}

function smokeStripeResend() {
  const stripe = run(["add", "stripe", "--dry-run", "--json", "--cwd", fixture]);
  assertEqual(stripe.status, 0, stripe.stderr);
  const sc = JSON.parse(stripe.stdout);
  assertGeneratedTypescriptParses(sc);
  const blob = sc.changes.map((c) => c.after).join("\n");
  if (!blob.includes("constructEventAsync") || !blob.includes("createSubtleCryptoProvider")) {
    throw new Error("stripe webhook must use the async Workers verification API");
  }
  if (!sc.warnings.some((w) => w.includes("EXPERIMENTAL"))) throw new Error("stripe should be experimental");

  const resend = run(["add", "resend", "--dry-run", "--json", "--cwd", fixture]);
  assertEqual(resend.status, 0, resend.stderr);
  const rc = JSON.parse(resend.stdout);
  assertGeneratedTypescriptParses(rc);
  if (!rc.changes.map((c) => c.after).join("\n").includes("emails.send")) throw new Error("resend helper missing emails.send");
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
}
function findChange(cs, p) {
  const c = cs.changes?.find((x) => x.path === p);
  if (!c) throw new Error(`expected change: ${p}`);
  return c;
}
function assertHasChange(cs, p) { findChange(cs, p); }
function assertGeneratedTypescriptParses(cs) {
  for (const change of cs.changes ?? []) {
    if (!/\.(d\.ts|ts|tsx)$/.test(change.path)) continue;
    const sf = ts.createSourceFile(change.path, change.after, ts.ScriptTarget.ES2022, true, change.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if (sf.parseDiagnostics.length > 0) {
      throw new Error(sf.parseDiagnostics.map((d) => `${change.path}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`).join("\n"));
    }
  }
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected}, got ${actual}`);
}
