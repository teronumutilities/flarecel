import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");

// each case: [args, load-bearing substring that MUST appear in some generated file].
// these substrings are the facts verified against live docs on 2026-06-04.
const cases = [
  [["add", "auth", "clerk"], "@clerk/nextjs/server"],
  [["add", "auth", "supabase"], "@supabase/ssr"],
  [["add", "auth", "authjs"], "next-auth"],
  [["add", "auth", "cloudflare-access"], "cf-access-jwt-assertion"],
  [["add", "db", "d1", "--orm", "prisma"], "@prisma/adapter-d1"],
  [["add", "db", "supabase", "--mode", "http"], "@supabase/supabase-js"],
  [["add", "db", "supabase", "--mode", "hyperdrive"], "HYPERDRIVE"],
  [["add", "db", "neon", "--mode", "serverless"], "@neondatabase/serverless"],
  [["add", "db", "neon", "--mode", "hyperdrive"], "connectionString"],
  [["add", "db", "turso"], "@libsql/client/web"],
  [["add", "db", "planetscale"], "@planetscale/database"],
  [["add", "db", "mongodb"], "nodejs_compat_v2"],
  [["add", "backend", "convex"], "convex/nextjs"],
  [["add", "redis", "upstash"], "@upstash/redis/cloudflare"]
];

smokeProviders();
smokeUnknownProviders();
smokeProviderParity();

function smokeProviders() {
  for (const [args, mustContain] of cases) {
    const result = run([...args, "--dry-run", "--json", "--cwd", fixture]);
    assertEqual(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    const changeSet = JSON.parse(result.stdout);
    assertEqual(changeSet.status, "planned", `${args.join(" ")} should be planned`);
    assertNoDuplicatePaths(changeSet, args.join(" "));
    assertGeneratedTypescriptParses(changeSet);

    if (!changeSet.warnings.some((w) => w.includes("EXPERIMENTAL"))) {
      throw new Error(`${args.join(" ")}: missing EXPERIMENTAL label`);
    }
    const blob = (changeSet.changes ?? []).map((c) => c.after).join("\n");
    if (!blob.includes(mustContain)) {
      throw new Error(`${args.join(" ")}: expected generated output to contain "${mustContain}"`);
    }
    // every provider recipe must ship a doc.
    if (!changeSet.changes.some((c) => /^docs\/flarecel-.*\.md$/.test(c.path))) {
      throw new Error(`${args.join(" ")}: missing generated doc`);
    }
  }
}

function smokeUnknownProviders() {
  for (const args of [["add", "auth", "okta"], ["add", "db", "cassandra"], ["add", "backend", "firebase"], ["add", "redis", "memcached"]]) {
    const result = run([...args, "--dry-run", "--json", "--cwd", fixture]);
    assertEqual(result.status, 4, `${args.join(" ")} should exit 4`);
    assertEqual(JSON.parse(result.stdout).status, "error", `${args.join(" ")} should be error`);
  }
}

function smokeProviderParity() {
  // spot-check dry-run/apply byte parity on a representative external recipe.
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-prov-parity-"));
  try {
    cpSync(fixture, tmp, { recursive: true });
    const recipe = ["add", "db", "turso"];
    const dryRun = JSON.parse(run([...recipe, "--dry-run", "--json", "--cwd", tmp]).stdout);
    const apply = run([...recipe, "--apply", "--yes", "--json", "--cwd", tmp]);
    assertEqual(apply.status, 0, apply.stderr);
    for (const change of dryRun.changes ?? []) {
      const written = readFileSync(path.join(tmp, change.path), "utf8");
      if (written !== change.after) throw new Error(`Provider parity mismatch at ${change.path}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
}

function assertNoDuplicatePaths(changeSet, label) {
  const seen = new Set();
  for (const change of changeSet.changes ?? []) {
    if (seen.has(change.path)) throw new Error(`${label}: duplicate generated path ${change.path}`);
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

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected}, got ${actual}`);
}
