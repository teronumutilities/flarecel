// Maintenance helper: keep DEP_VERSIONS in src/recipes.ts current without
// silently adopting breaking majors.
//   node scripts/update-versions.mjs          # report only
//   node scripts/update-versions.mjs --write  # apply same-major floor bumps
//
// Same-major updates are semver-safe and applied automatically. New majors are
// flagged but NOT changed: the recipe code that targets that API must be
// re-verified against current docs first. Exit code 1 means a major awaits review.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const recipesPath = path.join(repoRoot, "src", "recipes.ts");
const write = process.argv.includes("--write");

const source = readFileSync(recipesPath, "utf8");
const block = source.match(/const DEP_VERSIONS: Record<string, string> = \{([\s\S]*?)\n\};/);
if (!block) throw new Error("DEP_VERSIONS block not found in src/recipes.ts");

const entryRe = /"([^"]+)":\s*"(\^?)([0-9][^"]*)"/g;
const major = (v) => v.split(".")[0];

let inner = block[1];
let majors = 0;
let bumps = 0;
let m;

while ((m = entryRe.exec(block[1]))) {
  const [, name, caret, version] = m;

  if (version.includes("-")) {
    console.log(`~  ${name}: ${version} (prerelease-pinned; check the relevant dist-tag manually)`);
    continue;
  }

  const latest = (spawnSync("npm", ["view", name, "version"], { encoding: "utf8" }).stdout || "").trim();
  if (!latest) {
    console.log(`?  ${name}: could not resolve latest`);
    continue;
  }
  if (latest === version) continue;

  if (major(latest) === major(version)) {
    bumps += 1;
    console.log(`↑  ${name}: ${version} -> ${latest} (same major, safe${write ? ", applied" : ""})`);
    if (write) inner = inner.replace(`"${name}": "${caret}${version}"`, `"${name}": "${caret}${latest}"`);
  } else {
    majors += 1;
    console.log(`⚠  ${name}: ${version} -> ${latest} (NEW MAJOR — re-verify recipe code against docs before adopting; left unchanged)`);
  }
}

if (write && bumps > 0) {
  writeFileSync(recipesPath, source.replace(block[0], `const DEP_VERSIONS: Record<string, string> = {${inner}\n};`), "utf8");
  console.log(`\nApplied ${bumps} same-major floor bump(s) to src/recipes.ts.`);
}

console.log(`\n${majors} new major(s) awaiting review, ${bumps} safe bump(s)${write ? " applied" : " available (run with --write)"}.`);
if (majors > 0) process.exitCode = 1;
