import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");

smokeConnectedBindings();
smokeUnusedProductsAreNotFailures();
smokeTomlR2BindingsAreVisible();
smokeFutureCompatibilityDateBlocksVerify();

function smokeConnectedBindings() {
  const tmp = makeProject("flarecel-cf-bindings-");
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      name: "cf-bindings",
      type: "module",
      dependencies: {
        next: "^15.0.0",
        "better-auth": "^1.0.0",
        "@opennextjs/cloudflare": "^1.0.0"
      }
    }, null, 2));
    writeFileSync(path.join(tmp, "wrangler.jsonc"), JSON.stringify({
      name: "cf-bindings",
      account_id: "fake-account",
      main: ".open-next/worker.js",
      r2_buckets: [{ binding: "UPLOADS", bucket_name: "uploads" }],
      d1_databases: [{ binding: "DB", database_name: "app-db", database_id: "replace-with-d1-database-id" }],
      kv_namespaces: [{ binding: "CACHE", id: "replace-with-kv-namespace-id" }],
      queues: { producers: [{ binding: "JOBS", queue: "jobs" }] },
      vectorize: [{ binding: "DOCS_INDEX", index_name: "docs-search" }],
      durable_objects: { bindings: [{ name: "ROOM_DO", class_name: "RoomObject" }] },
      workflows: [{ name: "onboarding", binding: "ONBOARDING_WORKFLOW", class_name: "OnboardingWorkflow" }],
      browser: { binding: "BROWSER" },
      ratelimits: [{ name: "api-limit" }]
    }, null, 2));
    mkdirSync(path.join(tmp, "src", "cloudflare"), { recursive: true });
    writeFileSync(path.join(tmp, "src", "cloudflare", "ai-gateway.ts"), "export const gateway = true;\n");
    writeFakeWrangler(tmp);

    const result = run(tmp);
    assertEqual(result.status, 1, "placeholder ids should make cloudflare report action-required");
    const report = JSON.parse(result.stdout);
    assertEqual(report.status, "action-required");
    assertResource(report, "r2:uploads", "connected");
    assertResource(report, "d1:app-db", "needs-id");
    assertResource(report, "kv:CACHE", "needs-id");
    assertResource(report, "queue:jobs", "connected");
    assertResource(report, "secret:BETTER_AUTH_SECRET", "connected");
    assertResource(report, "vectorize:docs-search", "not-checked");
    assertResource(report, "durable-object:ROOM_DO", "configured");
    assertResource(report, "workflow:onboarding", "not-checked");
    assertResource(report, "browser-run:BROWSER", "configured");
    assertResource(report, "rate-limit:api-limit", "configured");
    assertResource(report, "ai-gateway:helper", "not-checked");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeUnusedProductsAreNotFailures() {
  const tmp = makeProject("flarecel-cf-minimal-");
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      name: "cf-minimal",
      type: "module",
      dependencies: {
        next: "^15.0.0",
        "@opennextjs/cloudflare": "^1.0.0"
      }
    }, null, 2));
    writeFileSync(path.join(tmp, "wrangler.jsonc"), JSON.stringify({
      name: "cf-minimal",
      account_id: "fake-account",
      main: ".open-next/worker.js"
    }, null, 2));
    writeFakeWrangler(tmp);

    const result = run(tmp);
    assertEqual(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assertEqual(report.status, "ready");
    assertResource(report, "r2:not-used", "not-used");
    assertResource(report, "d1:not-used", "not-used");
    assertResource(report, "kv:not-used", "not-used");
    assertResource(report, "queue:not-used", "not-used");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeTomlR2BindingsAreVisible() {
  const tmp = makeProject("flarecel-cf-toml-");
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      name: "cf-toml",
      type: "module",
      scripts: { dev: "wrangler pages dev ./public" },
      devDependencies: { "@cloudflare/workers-types": "^4.0.0" }
    }, null, 2));
    mkdirSync(path.join(tmp, "functions", "api"), { recursive: true });
    writeFileSync(path.join(tmp, "functions", "api", "session.ts"), "export async function onRequest() { return new Response('ok'); }\n");
    writeFileSync(path.join(tmp, "wrangler.toml"), `name = "cf-toml"
compatibility_date = "2024-11-01"

r2_buckets = [
  { binding = "MEMBERS", bucket_name = "members-bucket" }
]
`);
    writeFakeWrangler(tmp);

    const doctor = spawnSync(process.execPath, [cli, "doctor", "--json", "--cwd", tmp], { cwd: repoRoot, encoding: "utf8" });
    const doctorReport = JSON.parse(doctor.stdout);
    if (doctorReport.issues?.some((issue) => issue.id === "unknown-framework")) {
      throw new Error("Cloudflare Pages app should not be reported as unknown framework.");
    }
    assertEqual(doctorReport.project.framework, "cloudflare-pages");

    const result = run(tmp);
    assertEqual(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assertEqual(report.status, "ready");
    assertResource(report, "r2:members-bucket", "connected");
    if (report.resources?.some((resource) => resource.id === "r2:not-used")) {
      throw new Error("TOML R2 binding must not be reported as not-used.");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeFutureCompatibilityDateBlocksVerify() {
  const tmp = makeProject("flarecel-future-date-");
  try {
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
      name: "future-date",
      type: "module",
      scripts: { dev: "wrangler dev" },
      devDependencies: { "@cloudflare/workers-types": "^4.0.0" }
    }, null, 2));
    mkdirSync(path.join(tmp, "src"), { recursive: true });
    writeFileSync(path.join(tmp, "src", "index.ts"), "export default { fetch() { return new Response('ok'); } };\n");
    writeFileSync(path.join(tmp, "wrangler.jsonc"), JSON.stringify({
      name: "future-date",
      main: "src/index.ts",
      compatibility_date: "2999-01-01"
    }, null, 2));
    writeFakeWrangler(tmp);

    const result = spawnSync(process.execPath, [cli, "verify", "--json", "--cwd", tmp], { cwd: repoRoot, encoding: "utf8" });
    assertEqual(result.status, 2, result.stdout);
    const report = JSON.parse(result.stdout);
    assertCheck(report, "compatibility-date", "failed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function makeProject(prefix) {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(tmp, "node_modules", ".bin"), { recursive: true });
  return tmp;
}

function writeFakeWrangler(cwd) {
  const bin = path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "whoami") {
  console.log("fake@example.com");
  process.exit(0);
}
if (args === "r2 bucket list") {
  console.log("Listing buckets...");
  console.log("name:           uploads");
  console.log("creation_date:  2026-06-01T00:00:00.000Z");
  console.log("");
  console.log("name:           members-bucket");
  console.log("creation_date:  2026-06-01T00:00:00.000Z");
  process.exit(0);
}
if (args === "d1 list --json") {
  console.log(JSON.stringify([{ name: "app-db", uuid: "real-db-id" }]));
  process.exit(0);
}
if (args === "kv namespace list") {
  console.log(JSON.stringify([{ title: "CACHE", id: "real-kv-id" }]));
  process.exit(0);
}
if (args === "queues list") {
  console.log(JSON.stringify([{ queue_name: "jobs" }]));
  process.exit(0);
}
if (args === "secret list --format json") {
  console.log(JSON.stringify([{ name: "BETTER_AUTH_SECRET" }]));
  process.exit(0);
}
console.error("unexpected wrangler args: " + args);
process.exit(9);
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
}

function run(cwd) {
  return spawnSync(process.execPath, [cli, "cloudflare", "--json", "--cwd", cwd], { cwd: repoRoot, encoding: "utf8" });
}

function assertResource(report, id, status) {
  const resource = report.resources?.find((candidate) => candidate.id === id);
  if (!resource) throw new Error(`Missing resource ${id}`);
  assertEqual(resource.status, status, `Expected ${id} to be ${status}, got ${resource.status}`);
}

function assertCheck(report, id, status) {
  const check = report.checks?.find((candidate) => candidate.id === id);
  if (!check) throw new Error(`Missing check ${id}`);
  assertEqual(check.status, status, `Expected ${id} to be ${status}, got ${check.status}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected}, got ${actual}`);
}
