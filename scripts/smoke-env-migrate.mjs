import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");

smokeEnvAndSecretsAudit();
smokeVercelMigrationScansWithoutVercelJson();
smokeCostRecommendedDisplay();

function smokeEnvAndSecretsAudit() {
  const tmp = createVercelishProject();
  try {
    const env = run(["env", "--json", "--cwd", tmp]);
    assertEqual(env.status, 3, env.stderr);
    const report = JSON.parse(env.stdout);
    assertEqual(report.status, "action-required");
    assertVar(report, "NEXT_PUBLIC_SUPABASE_URL", "public");
    assertVar(report, "SUPABASE_SERVICE_ROLE_KEY", "secret");
    assertVar(report, "POLAR_WEBHOOK_SECRET", "secret");
    assertVar(report, "RESEND_API_KEY", "secret");
    assertVar(report, "APP_URL", "config");
    const appUrl = report.variables.find((variable) => variable.name === "APP_URL");
    assertEqual(appUrl.configuredInWranglerVars, true, "APP_URL should be detected in wrangler vars");
    assertNoSecretLeaks(report);

    const secrets = run(["secrets", "plan", "--json", "--cwd", tmp]);
    assertEqual(secrets.status, 3, secrets.stderr);
    const secretReport = JSON.parse(secrets.stdout);
    if (!secretReport.variables.every((variable) => variable.classification === "secret")) {
      throw new Error("secrets plan must only return secret-looking variables");
    }
    if (!secretReport.nextActions.includes("wrangler secret put SUPABASE_SERVICE_ROLE_KEY")) {
      throw new Error("secrets plan should include wrangler secret put commands");
    }
    assertNoSecretLeaks(secretReport);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeVercelMigrationScansWithoutVercelJson() {
  const tmp = createVercelishProject();
  try {
    const result = run(["migrate", "vercel", "--dry-run", "--json", "--cwd", tmp]);
    assertEqual(result.status, 0, result.stderr);
    const changeSet = JSON.parse(result.stdout);
    if (changeSet.status === "error") throw new Error("migrate vercel should scan even without vercel.json");
    if (!changeSet.warnings.some((warning) => warning.includes("No vercel.json found"))) {
      throw new Error("missing no-vercel.json scan warning");
    }
    for (const expected of ["maxDuration", "ISR/revalidation", "middleware/proxy", "next/image", "Vercel package"]) {
      if (!changeSet.warnings.some((warning) => warning.includes(expected))) {
        throw new Error(`missing Vercel migration warning for ${expected}`);
      }
    }
    const envChange = changeSet.changes.find((change) => change.path === ".dev.vars.example");
    if (!envChange?.after.includes("SUPABASE_SERVICE_ROLE_KEY=replace-with-value")) {
      throw new Error("migrate vercel should document env names even without vercel.json");
    }
    assertNoSecretLeaks(changeSet);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeCostRecommendedDisplay() {
  const tmp = createVercelishProject();
  try {
    const unknown = run(["cost", "--json", "--cwd", tmp]);
    assertEqual(unknown.status, 0, unknown.stderr);
    const unknownReport = JSON.parse(unknown.stdout);
    assertEqual(unknownReport.plan, "unknown");
    assertEqual(unknownReport.recommendedEstimateKind, "range");
    assertEqual(unknownReport.costBasis, "unknown-plan-range");
    assertEqual(unknownReport.recommendedDisplay, "$0.00 - $5.00/mo");

    const paid = run(["cost", "--json", "--plan", "paid", "--cwd", tmp]);
    assertEqual(paid.status, 0, paid.stderr);
    const paidReport = JSON.parse(paid.stdout);
    assertEqual(paidReport.plan, "paid");
    assertEqual(paidReport.recommendedEstimateKind, "single");
    assertEqual(paidReport.costBasis, "explicit-paid");
    assertEqual(paidReport.recommendedDisplay, "$5.00/mo");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function createVercelishProject() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-env-migrate-"));
  mkdirSync(path.join(tmp, "app", "api", "slow"), { recursive: true });
  mkdirSync(path.join(tmp, "src"), { recursive: true });
  writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
    name: "vercelish",
    dependencies: {
      next: "^15.0.0",
      "@vercel/analytics": "^1.0.0",
      resend: "^4.0.0",
      "@supabase/supabase-js": "^2.0.0"
    }
  }));
  writeFileSync(path.join(tmp, "wrangler.jsonc"), JSON.stringify({
    name: "vercelish",
    compatibility_date: "2026-06-06",
    vars: {
      APP_URL: "https://example.com"
    }
  }, null, 2));
  writeFileSync(path.join(tmp, ".env.example"), [
    "NEXT_PUBLIC_SUPABASE_URL=https://project.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY=srv_do_not_leak",
    "POLAR_WEBHOOK_SECRET=whsec_do_not_leak",
    "RESEND_API_KEY=re_do_not_leak",
    "APP_URL=https://example.com"
  ].join("\n"));
  writeFileSync(path.join(tmp, "next.config.mjs"), "export default { images: { remotePatterns: [] } };\n");
  writeFileSync(path.join(tmp, "src", "proxy.ts"), "export function proxy() {}\n");
  writeFileSync(path.join(tmp, "app", "page.tsx"), "import Image from 'next/image';\nexport default function Page(){ return <Image src='/x.png' alt='' width={1} height={1} /> }\n");
  writeFileSync(path.join(tmp, "app", "api", "slow", "route.ts"), [
    "import { revalidatePath } from 'next/cache';",
    "export const maxDuration = 120;",
    "export async function POST() {",
    "  revalidatePath('/');",
    "  return Response.json({ ok: Boolean(process.env.POLAR_WEBHOOK_SECRET) });",
    "}"
  ].join("\n"));
  return tmp;
}

function assertVar(report, name, classification) {
  const variable = report.variables.find((entry) => entry.name === name);
  if (!variable) throw new Error(`missing env variable ${name}`);
  assertEqual(variable.classification, classification, `${name} classification`);
}

function assertNoSecretLeaks(value) {
  const text = JSON.stringify(value);
  for (const leak of ["srv_do_not_leak", "whsec_do_not_leak", "re_do_not_leak"]) {
    if (text.includes(leak)) throw new Error(`secret value leaked: ${leak}`);
  }
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

function assertEqual(actual, expected, message = "") {
  if (actual !== expected) {
    throw new Error(`${message} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
