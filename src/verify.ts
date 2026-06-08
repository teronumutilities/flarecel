import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectContext, VerifyCheck, VerifyReport } from "./types.js";
import { runDoctor } from "./doctor.js";
import { cloudflareAuthStatus, formatCloudflareAuthStatus, type LoginStatus } from "./auth-status.js";

export function runVerify(ctx: ProjectContext): VerifyReport {
  const doctor = runDoctor(ctx);
  const cloudflareAuth = cloudflareAuthStatus(ctx.cwd);
  const checks: VerifyCheck[] = [];

  checks.push({
    id: "framework-detected",
    status: ctx.framework === "unknown" ? "failed" : "passed",
    message: ctx.framework === "unknown"
      ? "Project framework is not recognized by this MVP."
      : `Detected ${ctx.framework}.`
  });

  checks.push({
    id: "wrangler-config",
    status: ctx.wrangler.path && !ctx.wrangler.parseError ? "passed" : "failed",
    message: ctx.wrangler.path
      ? ctx.wrangler.parseError ?? `Found ${ctx.wrangler.path}.`
      : "No wrangler config found."
  });

  addCompatibilityDateCheck(ctx, checks);

  if (ctx.wrangler.format === "toml") {
    checks.push({
      id: "wrangler-toml-unverified",
      status: "warning",
      message: "wrangler.toml detected. Flarecel can inspect common TOML bindings, but patches are generated as JSONC."
    });
  }

  addWranglerAuthCheck(ctx, checks, cloudflareAuth);

  if (ctx.framework === "nextjs") {
    checks.push({
      id: "opennext-installed",
      status: ctx.hasOpenNext ? "passed" : "failed",
      message: ctx.hasOpenNext
        ? "@opennextjs/cloudflare is present."
        : "@opennextjs/cloudflare is missing."
    });

    checks.push({
      id: "preview-script",
      status: ctx.packageJson?.scripts?.preview?.includes("opennextjs-cloudflare") ? "passed" : "warning",
      message: ctx.packageJson?.scripts?.preview?.includes("opennextjs-cloudflare")
        ? "Preview script uses opennextjs-cloudflare."
        : "No OpenNext preview script found."
    });

    checks.push({
      id: "deploy-script",
      status: ctx.packageJson?.scripts?.deploy?.includes("opennextjs-cloudflare") ? "passed" : "warning",
      message: ctx.packageJson?.scripts?.deploy?.includes("opennextjs-cloudflare")
        ? "Deploy script uses opennextjs-cloudflare."
        : "No OpenNext deploy script found."
    });
  }

  if (usesBetterAuth(ctx)) {
    addBetterAuthChecks(ctx, checks);
  }

  addCloudflareBindingChecks(ctx, checks);

  for (const risk of ctx.sourceRisks) {
    const soft = (risk.kind === "node-api-import" && risk.value === "fs") || risk.kind === "next-image-import";
    checks.push({
      id: `source-risk-${risk.kind}`,
      status: soft ? "warning" : "failed",
      message: `${risk.file}: ${risk.value}`
    });
  }

  const wranglerAuthMissing = checks.some((check) => check.id === "wrangler-auth" && check.status === "failed");
  const failed = checks.some((check) => check.status === "failed" && check.id !== "wrangler-auth");
  const secretsMissing = doctor.status === "secrets-missing" || wranglerAuthMissing;
  const warning = checks.some((check) => check.status === "warning") || doctor.status === "warning";

  return {
    status: failed ? "blocking" : secretsMissing ? "secrets-missing" : warning ? "warning" : "ready",
    project: doctor.project,
    cloudflareAuth,
    checks,
    nextActions: failed
      ? ["flarecel doctor --json", "flarecel fix --dry-run --format patch"]
      : secretsMissing
        ? credentialNextActions(doctor.status === "secrets-missing", wranglerAuthMissing)
      : warning
        ? ["Review warnings, then run npm run preview."]
        : ["npm run preview", "flarecel deploy --preview --yes"]
  };
}

function addCompatibilityDateCheck(ctx: ProjectContext, checks: VerifyCheck[]): void {
  const date = typeof ctx.wrangler.data?.compatibility_date === "string"
    ? ctx.wrangler.data.compatibility_date
    : null;
  if (!date) return;

  const todayUtc = new Date().toISOString().slice(0, 10);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  checks.push({
    id: "compatibility-date",
    status: validDate && date <= todayUtc ? "passed" : "failed",
    message: validDate
      ? date <= todayUtc
        ? `compatibility_date ${date} is not in the future.`
        : `compatibility_date ${date} is in the future for Cloudflare API time (${todayUtc}).`
      : `compatibility_date must use YYYY-MM-DD, got ${date}.`
  });
}

function usesBetterAuth(ctx: ProjectContext): boolean {
  return Boolean(ctx.allDependencies["better-auth"]) || Boolean(findFirstExisting(ctx, betterAuthRouteCandidates()));
}

function addWranglerAuthCheck(ctx: ProjectContext, checks: VerifyCheck[], auth: LoginStatus): void {
  if (!ctx.wrangler.path || ctx.wrangler.parseError) return;

  if (auth.state === "in") {
    checks.push({
      id: "wrangler-auth",
      status: "passed",
      message: formatCloudflareAuthStatus(auth)
    });
    return;
  }

  if (auth.state === "unknown") {
    checks.push({
      id: "wrangler-auth",
      status: "warning",
      message: formatCloudflareAuthStatus(auth)
    });
    return;
  }

  checks.push({
    id: "wrangler-auth",
    status: "failed",
    message: formatCloudflareAuthStatus(auth)
  });
}

function credentialNextActions(authSecretMissing: boolean, wranglerAuthMissing: boolean): string[] {
  const actions: string[] = [];
  if (authSecretMissing) actions.push("wrangler secret put BETTER_AUTH_SECRET");
  if (wranglerAuthMissing) actions.push("wrangler login");
  actions.push("flarecel verify --json");
  return actions;
}

function addCloudflareBindingChecks(ctx: ProjectContext, checks: VerifyCheck[]): void {
  if (findFirstExisting(ctx, turnstileCandidates())) {
    const envTypes = readText(path.join(ctx.cwd, "cloudflare-env.d.ts"));
    checks.push({
      id: "turnstile-secret-type",
      status: envTypes?.includes("TURNSTILE_SECRET_KEY") ? "passed" : "warning",
      message: envTypes?.includes("TURNSTILE_SECRET_KEY")
        ? "CloudflareEnv includes TURNSTILE_SECRET_KEY."
        : "cloudflare-env.d.ts does not declare TURNSTILE_SECRET_KEY yet."
    });
  }

  if (findFirstExisting(ctx, aiGatewayCandidates())) {
    const envTypes = readText(path.join(ctx.cwd, "cloudflare-env.d.ts"));
    checks.push({
      id: "ai-gateway-env-types",
      status: envTypes?.includes("AI_GATEWAY_ID") && envTypes.includes("CLOUDFLARE_ACCOUNT_ID") ? "passed" : "warning",
      message: envTypes?.includes("AI_GATEWAY_ID") && envTypes.includes("CLOUDFLARE_ACCOUNT_ID")
        ? "CloudflareEnv includes AI Gateway values."
        : "cloudflare-env.d.ts does not declare AI Gateway values yet."
    });
  }

  const config = ctx.wrangler.data;
  if (!config) return;

  for (const bucket of objectArray(config.r2_buckets)) {
    const binding = stringValue(bucket.binding) ?? "unknown";
    checks.push({
      id: `r2-binding-${binding.toLowerCase()}`,
      status: stringValue(bucket.bucket_name) ? "passed" : "failed",
      message: stringValue(bucket.bucket_name)
        ? `R2 binding ${binding} has a bucket_name.`
        : `R2 binding ${binding} is missing bucket_name.`
    });
  }

  for (const database of objectArray(config.d1_databases)) {
    const binding = stringValue(database.binding) ?? "unknown";
    const databaseId = stringValue(database.database_id);
    const hasPlaceholder = !databaseId || databaseId.includes("replace-with");

    checks.push({
      id: `d1-binding-${binding.toLowerCase()}`,
      status: stringValue(database.database_name) ? "passed" : "failed",
      message: stringValue(database.database_name)
        ? `D1 binding ${binding} has a database_name.`
        : `D1 binding ${binding} is missing database_name.`
    });

    checks.push({
      id: `d1-database-id-${binding.toLowerCase()}`,
      status: hasPlaceholder ? "warning" : "passed",
      message: hasPlaceholder
        ? `D1 binding ${binding} still has a placeholder database_id.`
        : `D1 binding ${binding} has a database_id.`
    });
  }

  for (const namespace of objectArray(config.kv_namespaces)) {
    const binding = stringValue(namespace.binding) ?? "unknown";
    const namespaceId = stringValue(namespace.id);
    const hasPlaceholder = !namespaceId || namespaceId.includes("replace-with");

    checks.push({
      id: `kv-binding-${binding.toLowerCase()}`,
      status: hasPlaceholder ? "warning" : "passed",
      message: hasPlaceholder
        ? `KV binding ${binding} still has a placeholder id.`
        : `KV binding ${binding} has a namespace id.`
    });
  }

  const ai = config.ai;
  if (ai && typeof ai === "object" && !Array.isArray(ai)) {
    const binding = stringValue((ai as Record<string, unknown>).binding);
    checks.push({
      id: "workers-ai-binding",
      status: binding ? "passed" : "failed",
      message: binding ? `Workers AI binding ${binding} is configured.` : "Workers AI binding is missing a binding name."
    });
  }

  for (const index of objectArray(config.vectorize)) {
    const binding = stringValue(index.binding) ?? "unknown";
    checks.push({
      id: `vectorize-binding-${binding.toLowerCase()}`,
      status: stringValue(index.index_name) ? "passed" : "failed",
      message: stringValue(index.index_name)
        ? `Vectorize binding ${binding} has an index_name.`
        : `Vectorize binding ${binding} is missing index_name.`
    });
  }

  const durableObjects = config.durable_objects;
  if (durableObjects && typeof durableObjects === "object" && !Array.isArray(durableObjects)) {
    const migrationClasses = collectDurableObjectMigrationClasses(config);
    for (const durableObject of objectArray((durableObjects as Record<string, unknown>).bindings)) {
      const name = stringValue(durableObject.name) ?? "unknown";
      const className = stringValue(durableObject.class_name);
      const idSuffix = normalizeId(name);

      checks.push({
        id: `durable-object-binding-${idSuffix}`,
        status: className ? "passed" : "failed",
        message: className
          ? `Durable Object binding ${name} uses class ${className}.`
          : `Durable Object binding ${name} is missing class_name.`
      });

      if (className) {
        checks.push({
          id: `durable-object-export-${normalizeId(className)}`,
          status: hasWorkerExport(ctx, config, className) ? "passed" : "warning",
          message: hasWorkerExport(ctx, config, className)
            ? `Worker main exports ${className}.`
            : `Worker main does not appear to export ${className}; OpenNext apps usually need cloudflare-worker.ts.`
        });

        checks.push({
          id: `durable-object-migration-${normalizeId(className)}`,
          status: migrationClasses.has(className) ? "passed" : "warning",
          message: migrationClasses.has(className)
            ? `Durable Object migration includes ${className}.`
            : `Durable Object class ${className} is not listed in migrations.`
        });
      }
    }
  }

  for (const workflow of objectArray(config.workflows)) {
    const binding = stringValue(workflow.binding) ?? "unknown";
    const className = stringValue(workflow.class_name);
    checks.push({
      id: `workflow-binding-${normalizeId(binding)}`,
      status: stringValue(workflow.name) && className ? "passed" : "failed",
      message: stringValue(workflow.name) && className
        ? `Workflow binding ${binding} uses class ${className}.`
        : `Workflow binding ${binding} is missing name or class_name.`
    });

    if (className) {
      checks.push({
        id: `workflow-export-${normalizeId(className)}`,
        status: hasWorkerExport(ctx, config, className) ? "passed" : "warning",
        message: hasWorkerExport(ctx, config, className)
          ? `Worker main exports ${className}.`
          : `Worker main does not appear to export ${className}; OpenNext apps usually need cloudflare-worker.ts.`
      });
    }
  }

  const queues = config.queues;
  if (queues && typeof queues === "object" && !Array.isArray(queues)) {
    for (const producer of objectArray((queues as Record<string, unknown>).producers)) {
      const binding = stringValue(producer.binding) ?? "unknown";
      checks.push({
        id: `queue-producer-${binding.toLowerCase()}`,
        status: stringValue(producer.queue) ? "passed" : "failed",
        message: stringValue(producer.queue)
          ? `Queue producer ${binding} has a queue name.`
          : `Queue producer ${binding} is missing a queue name.`
      });
    }
  }

  for (const limiter of objectArray(config.ratelimits)) {
    const name = stringValue(limiter.name) ?? "unknown";
    checks.push({
      id: `rate-limit-${name.toLowerCase()}`,
      status: stringValue(limiter.namespace_id) ? "passed" : "warning",
      message: stringValue(limiter.namespace_id)
        ? `Rate Limiting namespace ${name} has a namespace_id.`
        : `Rate Limiting namespace ${name} is missing namespace_id.`
    });
  }

  const triggers = config.triggers;
  if (triggers && typeof triggers === "object" && !Array.isArray(triggers)) {
    const crons = (triggers as Record<string, unknown>).crons;
    if (Array.isArray(crons)) {
      checks.push({
        id: "cron-triggers",
        status: crons.every((cron) => typeof cron === "string" && cron.length > 0) ? "passed" : "failed",
        message: `Wrangler config includes ${crons.length} Cron Trigger(s).`
      });
    }
  }

  const observability = config.observability;
  if (observability && typeof observability === "object" && !Array.isArray(observability)) {
    checks.push({
      id: "observability-enabled",
      status: (observability as Record<string, unknown>).enabled === true ? "passed" : "warning",
      message: (observability as Record<string, unknown>).enabled === true
        ? "Workers Logs observability is enabled."
        : "observability is present but not enabled."
    });
  }

  const browser = config.browser;
  if (browser && typeof browser === "object" && !Array.isArray(browser)) {
    const binding = stringValue((browser as Record<string, unknown>).binding);
    checks.push({
      id: "browser-run-binding",
      status: binding ? "passed" : "failed",
      message: binding ? `Browser Run binding ${binding} is configured.` : "Browser Run binding is missing a binding name."
    });

    checks.push({
      id: "browser-run-nodejs-compat",
      status: hasCompatibilityFlag(config, "nodejs_compat") || hasCompatibilityFlag(config, "nodejs_compat_v2") ? "passed" : "warning",
      message: hasCompatibilityFlag(config, "nodejs_compat") || hasCompatibilityFlag(config, "nodejs_compat_v2")
        ? "Browser Run has a Node.js compatibility flag."
        : "Browser Run usually needs a Node.js compatibility flag for @cloudflare/puppeteer."
    });
  }
}

function hasWorkerExport(ctx: ProjectContext, config: Record<string, unknown>, exportName: string): boolean {
  const main = stringValue(config.main) ?? "src/index.ts";
  const mainText = readText(path.join(ctx.cwd, main));

  return Boolean(
    mainText?.includes(`export class ${exportName}`) ||
    mainText?.includes(`export { ${exportName}`) ||
    mainText?.includes(`export {${exportName}`)
  );
}

function hasCompatibilityFlag(config: Record<string, unknown>, flag: string): boolean {
  return Array.isArray(config.compatibility_flags) && config.compatibility_flags.includes(flag);
}

function collectDurableObjectMigrationClasses(config: Record<string, unknown>): Set<string> {
  const classes = new Set<string>();

  for (const migration of objectArray(config.migrations)) {
    for (const key of ["new_classes", "new_sqlite_classes"]) {
      const values = migration[key];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value === "string") classes.add(value);
      }
    }
  }

  return classes;
}

function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function addBetterAuthChecks(ctx: ProjectContext, checks: VerifyCheck[]): void {
  const routePath = findFirstExisting(ctx, betterAuthRouteCandidates());
  const routeText = routePath ? readText(path.join(ctx.cwd, routePath)) : null;

  checks.push({
    id: "better-auth-installed",
    status: ctx.allDependencies["better-auth"] ? "passed" : "failed",
    message: ctx.allDependencies["better-auth"]
      ? "better-auth is present."
      : "Better Auth route/config detected, but better-auth is missing from package.json."
  });

  checks.push({
    id: "better-auth-route",
    status: routePath && routeText?.includes(".handler(") ? "passed" : "failed",
    message: routePath
      ? `${routePath} exposes Better Auth request handlers.`
      : "No Better Auth route found at app/api/auth/[...all]/route.ts."
  });

  const d1Binding = findD1Binding(ctx, "DB");
  checks.push({
    id: "better-auth-d1-binding",
    status: d1Binding ? "passed" : "failed",
    message: d1Binding
      ? "Wrangler config includes a DB D1 binding."
      : "Wrangler config is missing a DB D1 binding for Better Auth."
  });

  if (d1Binding) {
    const databaseId = typeof d1Binding.database_id === "string" ? d1Binding.database_id.trim() : "";
    const hasPlaceholder = !databaseId || databaseId.includes("replace-with");

    checks.push({
      id: "better-auth-d1-database-id",
      status: hasPlaceholder ? "warning" : "passed",
      message: hasPlaceholder
        ? "D1 database_id is still a placeholder. Run wrangler d1 create and paste the returned ID."
        : "D1 database_id is set."
    });
  }

  const envTypes = readText(path.join(ctx.cwd, "cloudflare-env.d.ts"));
  checks.push({
    id: "better-auth-secret-type",
    status: envTypes?.includes("BETTER_AUTH_SECRET") ? "passed" : "warning",
    message: envTypes?.includes("BETTER_AUTH_SECRET")
      ? "CloudflareEnv includes BETTER_AUTH_SECRET."
      : "cloudflare-env.d.ts does not declare BETTER_AUTH_SECRET yet."
  });
}

function betterAuthRouteCandidates(): string[] {
  return [
    "app/api/auth/[...all]/route.ts",
    "src/app/api/auth/[...all]/route.ts"
  ];
}

function turnstileCandidates(): string[] {
  return [
    "src/cloudflare/turnstile.ts",
    "app/api/turnstile/signup/verify/route.ts",
    "src/app/api/turnstile/signup/verify/route.ts"
  ];
}

function aiGatewayCandidates(): string[] {
  return [
    "src/cloudflare/ai-gateway.ts"
  ];
}

function findFirstExisting(ctx: ProjectContext, relativePaths: string[]): string | null {
  return relativePaths.find((relativePath) => existsSync(path.join(ctx.cwd, relativePath))) ?? null;
}

// opt-in: boots the built worker in workerd via scripts/verify-runtime.mjs.
// Returns a VerifyCheck; degrades to a warning if skipped (no build / no miniflare).
export function runRuntimeCheck(ctx: ProjectContext): VerifyCheck {
  const scriptPath = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "scripts", "verify-runtime.mjs");
  if (!existsSync(scriptPath)) {
    return { id: "runtime-boot", status: "warning", message: "Runtime script not found (scripts/verify-runtime.mjs)." };
  }

  const result = spawnSync(process.execPath, [scriptPath, "--cwd", ctx.cwd], { encoding: "utf8" });
  let parsed: { status?: string; reason?: string; bootMs?: number; httpStatus?: number } = {};
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    return { id: "runtime-boot", status: "failed", message: result.stderr?.trim() || "Runtime check produced no parseable output." };
  }

  if (parsed.status === "passed") {
    return { id: "runtime-boot", status: "passed", message: `Worker booted in ${parsed.bootMs}ms (HTTP ${parsed.httpStatus}).` };
  }
  if (parsed.status === "skipped") {
    return { id: "runtime-boot", status: "warning", message: parsed.reason ?? "Runtime check skipped." };
  }
  return { id: "runtime-boot", status: "failed", message: parsed.reason ?? "Worker failed to boot." };
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is Record<string, unknown> => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate))
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function findD1Binding(ctx: ProjectContext, binding: string): Record<string, unknown> | null {
  const databases = ctx.wrangler.data?.d1_databases;
  if (!Array.isArray(databases)) return null;

  return databases.find((database): database is Record<string, unknown> => {
    return typeof database === "object" && database !== null && "binding" in database && database.binding === binding;
  }) ?? null;
}

function readText(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
