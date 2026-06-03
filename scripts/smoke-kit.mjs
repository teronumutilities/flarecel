import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");
const tomlFixture = path.join(repoRoot, "fixtures", "next-toml");

smokeKitSaasComposesAndApplies();
smokeNewKits();
smokeKitParity();
smokeKitUnknownAndGating();
smokeExitCodeThree();
smokeTomlVerify();

function smokeNewKits() {
  for (const kit of ["realtime", "creator", "internal-tool"]) {
    const result = run(["kit", kit, "--dry-run", "--json", "--cwd", fixture]);
    assertEqual(result.status, 0, `kit ${kit}: ${result.stderr}`);
    const changeSet = JSON.parse(result.stdout);
    assertEqual(changeSet.status, "planned", `kit ${kit} should be planned`);
    assertNoDuplicatePaths(changeSet);
    assertGeneratedTypescriptParses(changeSet);
    assertSingle(changeSet, "package.json");
    assertSingle(changeSet, "wrangler.jsonc");
  }
}

function smokeKitSaasComposesAndApplies() {
  const tmp = copyFixture("flarecel-kit-saas-");
  try {
    const dryRun = run(["kit", "saas", "--dry-run", "--json", "--cwd", tmp]);
    assertEqual(dryRun.status, 0, dryRun.stderr);
    const changeSet = JSON.parse(dryRun.stdout);
    assertEqual(changeSet.status, "planned");

    assertNoDuplicatePaths(changeSet);
    assertGeneratedTypescriptParses(changeSet);
    // Composed shared files must be single, merged entries.
    assertSingle(changeSet, "package.json");
    assertSingle(changeSet, "wrangler.jsonc");
    assertHasChange(changeSet, "app/api/auth/[...all]/route.ts");

    const pkg = JSON.parse(findChange(changeSet, "package.json").after);
    if (!pkg.dependencies["better-auth"] || !pkg.dependencies["drizzle-orm"]) {
      throw new Error("Kit package.json missing composed auth/db deps.");
    }
    if (pkg.dependencies["better-auth"] === "latest") {
      throw new Error("Kit deps should be pinned, not 'latest'.");
    }

    const wrangler = JSON.parse(findChange(changeSet, "wrangler.jsonc").after);
    for (const key of ["d1_databases", "r2_buckets", "ratelimits", "queues"]) {
      if (!wrangler[key]) throw new Error(`Kit wrangler.jsonc missing ${key}.`);
    }

    const apply = run(["kit", "saas", "--apply", "--yes", "--json", "--cwd", tmp]);
    assertEqual(apply.status, 0, apply.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeKitParity() {
  const tmp = copyFixture("flarecel-kit-parity-");
  try {
    const dryRun = run(["kit", "ai-app", "--dry-run", "--json", "--cwd", tmp]);
    assertEqual(dryRun.status, 0, dryRun.stderr);
    const changeSet = JSON.parse(dryRun.stdout);

    const apply = run(["kit", "ai-app", "--apply", "--yes", "--json", "--cwd", tmp]);
    assertEqual(apply.status, 0, apply.stderr);

    for (const change of changeSet.changes ?? []) {
      const written = readFileSync(path.join(tmp, change.path), "utf8");
      if (written !== change.after) {
        throw new Error(`Kit parity mismatch at ${change.path}: applied bytes differ from previewed bytes.`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeKitUnknownAndGating() {
  const unknown = run(["kit", "nope", "--dry-run", "--json", "--cwd", fixture]);
  assertEqual(unknown.status, 4, "Unknown kit should exit 4.");
  assertEqual(JSON.parse(unknown.stdout).status, "error");

  // next-opennext must refuse non-Next projects.
  const hono = mkdtempSync(path.join(tmpdir(), "flarecel-hono-"));
  try {
    writeFileSync(path.join(hono, "package.json"), JSON.stringify({ name: "h", dependencies: { hono: "^4.0.0" } }));
    const result = run(["add", "next-opennext", "--dry-run", "--json", "--cwd", hono]);
    assertEqual(result.status, 4, "next-opennext on non-Next should exit 4.");
    assertEqual(JSON.parse(result.stdout).status, "error");
  } finally {
    rmSync(hono, { recursive: true, force: true });
  }
}

function smokeExitCodeThree() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-exit3-"));
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      name: "ready",
      dependencies: { next: "^15.0.0", "@opennextjs/cloudflare": "^1.19.11", "better-auth": "^1.6.14" }
    }));
    writeFileSync(path.join(tmp, "wrangler.jsonc"), JSON.stringify({
      name: "ready",
      main: ".open-next/worker.js",
      compatibility_date: "2026-01-01",
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"]
    }));
    const result = run(["doctor", "--json", "--cwd", tmp]);
    assertEqual(result.status, 3, "Auth present without declared secret should exit 3.");
    const report = JSON.parse(result.stdout);
    assertEqual(report.status, "secrets-missing");
    if (!report.issues.some((i) => i.id === "auth-secret-missing")) {
      throw new Error("Expected auth-secret-missing issue.");
    }

    // Declaring the secret clears it.
    writeFileSync(path.join(tmp, "cloudflare-env.d.ts"), "interface CloudflareEnv { BETTER_AUTH_SECRET: string; }\n");
    const cleared = run(["doctor", "--json", "--cwd", tmp]);
    if (cleared.status === 3) throw new Error("Declaring the secret should clear exit 3.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeTomlVerify() {
  const verify = run(["verify", "--json", "--cwd", tomlFixture]);
  const report = JSON.parse(verify.stdout);
  assertCheck(report, "wrangler-toml-unverified", "warning");

  // A recipe against a TOML project should warn about generated wrangler.jsonc.
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-toml-"));
  try {
    cpSync(tomlFixture, tmp, { recursive: true });
    const result = run(["add", "kv", "cache", "--dry-run", "--json", "--cwd", tmp]);
    assertEqual(result.status, 0, result.stderr);
    const changeSet = JSON.parse(result.stdout);
    if (!changeSet.warnings.some((w) => w.includes("wrangler.jsonc") && w.includes("ambiguous"))) {
      throw new Error("Expected TOML ambiguity warning on recipe output.");
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
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
}

function findChange(changeSet, filePath) {
  const change = changeSet.changes?.find((c) => c.path === filePath);
  if (!change) throw new Error(`Expected generated file: ${filePath}`);
  return change;
}

function assertHasChange(changeSet, filePath) {
  findChange(changeSet, filePath);
}

function assertSingle(changeSet, filePath) {
  const count = (changeSet.changes ?? []).filter((c) => c.path === filePath).length;
  if (count !== 1) throw new Error(`Expected exactly one ${filePath} change, got ${count}.`);
}

function assertNoDuplicatePaths(changeSet) {
  const seen = new Set();
  for (const change of changeSet.changes ?? []) {
    if (seen.has(change.path)) throw new Error(`Duplicate generated path: ${change.path}`);
    seen.add(change.path);
  }
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
        .map((d) => `${change.path}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`)
        .join("\n");
      throw new Error(message);
    }
  }
}

function assertCheck(report, id, status) {
  const check = report.checks?.find((c) => c.id === id);
  if (!check) throw new Error(`Missing verify check: ${id}`);
  if (check.status !== status) throw new Error(`Expected ${id} to be ${status}, got ${check.status}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected}, got ${actual}`);
}
