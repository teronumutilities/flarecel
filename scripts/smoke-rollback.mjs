import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");

smokeVersionsList();
smokeRollbackGated();
smokeRollbackExecutes();

function projectWithFakeWrangler() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-rollback-"));
  cpSync(fixture, tmp, { recursive: true });
  mkdirSync(path.join(tmp, "node_modules", ".bin"), { recursive: true });
  const bin = path.join(tmp, "node_modules", ".bin", "wrangler");
  writeFileSync(bin, `#!/usr/bin/env node\nconst a=process.argv.slice(2);\nif(a[0]==="versions"&&a[1]==="list"){process.stdout.write("Version ID: abc-123\\n");process.exit(0)}\nif(a[0]==="rollback"){process.stdout.write("Rolled back\\n");process.exit(0)}\nprocess.exit(1)\n`);
  chmodSync(bin, 0o755);
  return tmp;
}

function smokeVersionsList() {
  const tmp = projectWithFakeWrangler();
  try {
    const r = JSON.parse(run(["versions", "--json", "--cwd", tmp]).stdout);
    assertEqual(r.status, "succeeded", "versions list should succeed");
    if (!(r.stdout || "").includes("abc-123")) throw new Error("expected version id in output");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeRollbackGated() {
  const tmp = projectWithFakeWrangler();
  try {
    const res = run(["rollback", "abc-123", "--json", "--cwd", tmp]);
    assertEqual(res.status, 5, "rollback without --yes must require confirmation (exit 5)");
    const r = JSON.parse(res.stdout);
    assertEqual(r.status, "confirmation-required", "rollback should be gated");
    assertEqual(r.executed, false, "rollback must not execute without --yes");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeRollbackExecutes() {
  const tmp = projectWithFakeWrangler();
  try {
    const r = JSON.parse(run(["rollback", "abc-123", "--yes", "--json", "--cwd", tmp]).stdout);
    assertEqual(r.status, "succeeded", "rollback --yes should execute");
    assertEqual(r.executed, true, "rollback --yes should run the command");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected}, got ${actual}`);
}
