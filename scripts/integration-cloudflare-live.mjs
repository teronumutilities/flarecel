import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.env.FLARECEL_RUN_CLOUDFLARE_LIVE_TEST !== "1") {
  console.log("Skipped live Cloudflare usage test. Set FLARECEL_RUN_CLOUDFLARE_LIVE_TEST=1 to run it.");
  process.exit(0);
}

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const result = spawnSync(process.execPath, [cli, "cost", "--cloudflare-live", "--json", "--cwd", repoRoot], {
  cwd: repoRoot,
  encoding: "utf8"
});

if (result.status !== 0) {
  throw new Error(`Expected live Cloudflare usage to succeed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

const report = JSON.parse(result.stdout);
if (report.status !== "estimate" || report.usageSource !== "cloudflare-live") {
  throw new Error(`Expected cloudflare-live estimate, got ${result.stdout}`);
}
if (typeof report.estimatedMonthlyUsd !== "number") {
  throw new Error("Expected numeric estimatedMonthlyUsd.");
}

const token = process.env.CLOUDFLARE_API_TOKEN;
if (token && (result.stdout.includes(token) || result.stderr.includes(token))) {
  throw new Error("Cloudflare token leaked in live usage output.");
}
