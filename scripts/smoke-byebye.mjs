import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
smokeExplain();
smokeCostCompare();
smokeIsrRecipe();
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

  // Non-vercel target exits 4.
  const bad = run(["migrate", "netlify", "--dry-run", "--json", "--cwd", fixture]);
  assertEqual(bad.status, 4, "migrate netlify should exit 4");
}

// Negative control: .env values must NEVER be copied into generated files.
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

  // Templated ids resolve.
  const templated = run(["explain", "risky-package-bcrypt", "--json", "--cwd", fixture]);
  assertEqual(templated.status, 0, "templated id should resolve");
}

function smokeCostCompare() {
  const model = run(["cost", "--compare", "vercel", "--json", "--cwd", fixture]);
  assertEqual(model.status, 0, model.stderr);
  const m = JSON.parse(model.stdout);
  if (!m.vercelComparison) throw new Error("vercelComparison missing");
  if (!m.vercelComparison.disclaimer) throw new Error("mandatory disclaimer missing from JSON");
  if (!m.warnings.some((w) => w.includes("EXPERIMENTAL"))) throw new Error("disclaimer must be surfaced in warnings");
  assertEqual(m.vercelComparison.source, "model", "default should be the model");

  const override = run(["cost", "--compare", "vercel", "--vercel-monthly-usd", "200", "--json", "--cwd", fixture]);
  const o = JSON.parse(override.stdout);
  assertEqual(o.vercelComparison.source, "user-provided", "override should be user-provided");
  assertEqual(o.vercelComparison.vercelMonthlyUsd, 200, "override value should be used");

  // Without --compare, no comparison block.
  const plain = run(["cost", "--json", "--cwd", fixture]);
  if (JSON.parse(plain.stdout).vercelComparison) throw new Error("comparison should only appear with --compare vercel");
}

function smokeIsrRecipe() {
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
