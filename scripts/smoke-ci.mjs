import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const WORKFLOW = ".github/workflows/deploy.yml";

smokePlainDryRun();
smokeApplyGate();
smokeApplyWritesAndIdempotent();
smokeNextDeployScript();
smokeUnsupportedProvider();

function plainWorkerProject() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-ci-"));
  writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "plain", scripts: {} }));
  writeFileSync(
    path.join(tmp, "wrangler.json"),
    JSON.stringify({ name: "plain", main: "src/index.ts", compatibility_date: "2026-06-04" })
  );
  return tmp;
}

function nextProjectWithDeploy() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-ci-next-"));
  writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify({ name: "synth", dependencies: { next: "15.0.0" }, scripts: { deploy: "opennextjs-cloudflare build && wrangler deploy" } })
  );
  writeFileSync(
    path.join(tmp, "wrangler.json"),
    JSON.stringify({ name: "synth", main: "src/index.ts", compatibility_date: "2026-06-04" })
  );
  return tmp;
}

// Dry-run must plan the workflow, name the token secret, and NOT write a file.
function smokePlainDryRun() {
  const tmp = plainWorkerProject();
  try {
    const r = JSON.parse(run(["ci", "--json", "--cwd", tmp]).stdout);
    assertEqual(r.status, "planned", "plain dry-run should be planned");
    assertEqual(r.changes.length, 1, "should plan exactly one file");
    assertEqual(r.changes[0].path, WORKFLOW, "should target the workflow path");
    assertIncludes(r.changes[0].after, "cloudflare/wrangler-action@v3", "plain project should use wrangler-action");
    assertIncludes(r.changes[0].after, "secrets.CLOUDFLARE_API_TOKEN", "must reference the token secret");
    if (r.changes[0].after.includes("0x") || /secret put .*=/.test(r.changes[0].after)) {
      throw new Error("workflow must not contain a literal secret value");
    }
    if (existsSync(path.join(tmp, WORKFLOW))) throw new Error("dry-run must not write the workflow file");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --apply without --yes is gated (exit 5), like every file-changing command.
function smokeApplyGate() {
  const tmp = plainWorkerProject();
  try {
    const res = run(["ci", "--apply", "--json", "--cwd", tmp]);
    assertEqual(res.status, 5, "ci --apply without --yes must exit 5");
    if (existsSync(path.join(tmp, WORKFLOW))) throw new Error("gated apply must not write the file");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --apply --yes writes the file; a second run sees no changes (empty).
function smokeApplyWritesAndIdempotent() {
  const tmp = plainWorkerProject();
  try {
    const applied = JSON.parse(run(["ci", "--apply", "--yes", "--json", "--cwd", tmp]).stdout);
    assertEqual(applied.status, "applied", "ci --apply --yes should apply");
    if (!existsSync(path.join(tmp, WORKFLOW))) throw new Error("apply should write the workflow file");
    const onDisk = readFileSync(path.join(tmp, WORKFLOW), "utf8");
    assertIncludes(onDisk, "name: Deploy to Cloudflare", "written file should be the workflow");

    const again = JSON.parse(run(["ci", "--json", "--cwd", tmp]).stdout);
    assertEqual(again.status, "empty", "re-running on an up-to-date workflow should be empty");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Next.js with a deploy script routes through the project's own deploy script.
function smokeNextDeployScript() {
  const tmp = nextProjectWithDeploy();
  try {
    const r = JSON.parse(run(["ci", "--json", "--cwd", tmp]).stdout);
    assertEqual(r.status, "planned", "next project should plan a workflow");
    assertIncludes(r.changes[0].after, "run: npm run deploy", "nextjs+deploy should run the deploy script");
    assertIncludes(r.changes[0].after, "CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}", "deploy script needs the token env");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Only GitHub is supported; anything else is an error (exit 4), no write.
function smokeUnsupportedProvider() {
  const tmp = plainWorkerProject();
  try {
    const res = run(["ci", "--provider", "gitlab", "--json", "--cwd", tmp]);
    assertEqual(res.status, 4, "unsupported provider should exit 4");
    const r = JSON.parse(res.stdout);
    assertEqual(r.status, "error", "unsupported provider should be an error change set");
    if (existsSync(path.join(tmp, WORKFLOW))) throw new Error("error must not write a file");
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

function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) throw new Error(message || `Expected output to include ${needle}`);
}

console.log("smoke:ci OK");
