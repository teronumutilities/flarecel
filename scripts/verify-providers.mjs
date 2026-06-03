// Opt-in deep verification for experimental provider recipes.
//   node scripts/verify-providers.mjs           # all providers
//   node scripts/verify-providers.mjs turso     # filter by substring
//
// For each provider this installs the REAL packages the recipe declares and
// type-checks the recipe's third-party import statements against the real
// type definitions. This catches wrong package names, wrong subpath exports
// (e.g. @libsql/client/web), and wrong named exports (e.g. PrismaD1) — the
// exact failure modes that "does it parse" cannot catch.
//
// It does NETWORK npm installs, so it is intentionally separate from `npm test`.
// Framework imports (next/*) and relative imports are not verified here; they
// are the user's project, not something the recipe installs.
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");
const tsc = path.join(repoRoot, "node_modules", ".bin", "tsc");
const filter = process.argv[2];

const PROVIDERS = [
  ["auth-clerk", ["add", "auth", "clerk"]],
  ["auth-supabase", ["add", "auth", "supabase"]],
  ["auth-authjs", ["add", "auth", "authjs"]],
  ["auth-cloudflare-access", ["add", "auth", "cloudflare-access"]],
  ["db-d1-prisma", ["add", "db", "d1", "--orm", "prisma"]],
  ["db-supabase-http", ["add", "db", "supabase", "--mode", "http"]],
  ["db-supabase-hyperdrive", ["add", "db", "supabase", "--mode", "hyperdrive"]],
  ["db-neon-serverless", ["add", "db", "neon", "--mode", "serverless"]],
  ["db-neon-hyperdrive", ["add", "db", "neon", "--mode", "hyperdrive"]],
  ["db-turso", ["add", "db", "turso"]],
  ["db-planetscale", ["add", "db", "planetscale"]],
  ["db-mongodb", ["add", "db", "mongodb"]],
  ["backend-convex", ["add", "backend", "convex"]],
  ["redis-upstash", ["add", "redis", "upstash"]],
  ["stripe", ["add", "stripe"]],
  ["resend", ["add", "resend"]]
].filter(([key]) => !filter || key.includes(filter));

const baseline = depNames(JSON.parse(readFileSync(path.join(fixture, "package.json"), "utf8")));

// 1. Dry-run each provider; collect declared deps + third-party import lines.
const specSet = new Map(); // base -> install spec (name@range)
const probes = [];

for (const [key, args] of PROVIDERS) {
  const out = spawnSync(process.execPath, [cli, ...args, "--dry-run", "--json", "--cwd", fixture], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`${key}: dry-run failed: ${out.stderr}`);
  const changeSet = JSON.parse(out.stdout);

  const added = addedDeps(changeSet, baseline); // base -> range
  const lines = new Set();
  for (const change of changeSet.changes ?? []) {
    if (!/\.(ts|tsx)$/.test(change.path)) continue;
    for (const stmt of importStatements(change.after)) {
      const base = pkgBase(stmt.spec);
      if (!added.has(base)) continue; // skip relative + framework + non-installed
      lines.add(stmt.line);
      if (!specSet.has(base)) specSet.set(base, `${base}@${installRange(added.get(base))}`);
    }
  }
  probes.push({ key, lines: [...lines] });
}

// 2. Install the union of needed real packages once.
const work = mkdtempSync(path.join(tmpdir(), "flarecel-verify-"));
const installSpecs = [...specSet.values()];
console.log(`Installing ${installSpecs.length} real packages: ${installSpecs.join(", ")}\n`);
writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "probe", private: true, version: "0.0.0" }) + "\n");
const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--silent", ...installSpecs], { cwd: work, encoding: "utf8" });
if (install.status !== 0) {
  console.error(`npm install failed:\n${install.stderr}`);
  rmSync(work, { recursive: true, force: true });
  process.exitCode = 2;
} else {
  // 3. Type-check each provider's third-party imports against the real types.
  let failed = 0;
  for (const { key, lines } of probes) {
    if (lines.length === 0) {
      console.log(`-  ${key}: no third-party imports to verify`);
      continue;
    }
    const probeFile = path.join(work, `${key}.ts`);
    writeFileSync(probeFile, lines.join("\n") + "\nexport {};\n");
    const check = spawnSync(tsc, [
      "--noEmit", "--skipLibCheck",
      "--module", "esnext", "--moduleResolution", "bundler",
      "--target", "es2022", "--esModuleInterop", "--allowSyntheticDefaultImports",
      probeFile
    ], { cwd: work, encoding: "utf8" });

    if (check.status === 0) {
      console.log(`✓  ${key}: ${lines.length} third-party import(s) resolve against real packages`);
    } else {
      failed += 1;
      console.log(`✗  ${key}:\n${(check.stdout || check.stderr).trim().split("\n").map((l) => `     ${l}`).join("\n")}`);
    }
  }
  rmSync(work, { recursive: true, force: true });
  console.log(`\n${probes.length - failed}/${probes.length} provider(s) verified against real dependencies.`);
  if (failed > 0) process.exitCode = 1;
}

function depNames(pkg) {
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
}

function addedDeps(changeSet, baselineNames) {
  const pkgChange = (changeSet.changes ?? []).find((c) => c.path === "package.json");
  const added = new Map();
  if (!pkgChange) return added;
  const after = JSON.parse(pkgChange.after);
  for (const group of [after.dependencies ?? {}, after.devDependencies ?? {}]) {
    for (const [name, range] of Object.entries(group)) {
      if (!baselineNames.has(name)) added.set(name, range);
    }
  }
  return added;
}

function importStatements(source) {
  const out = [];
  const re = /^[ \t]*(?:import|export)[^\n]*?["']([^"']+)["'][^\n]*$/gm;
  let m;
  while ((m = re.exec(source))) out.push({ line: m[0].trim(), spec: m[1] });
  return out;
}

function pkgBase(spec) {
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0];
}

// Prerelease ranges (e.g. ^5.0.0-beta.31) must install the exact version;
// caret matching does not span prerelease tags reliably.
function installRange(range) {
  return range.includes("-") ? range.replace(/^[\^~]/, "") : range;
}
