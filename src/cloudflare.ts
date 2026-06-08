import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareAuthStatusAsync, type LoginStatus } from "./auth-status.js";
import { runCommand } from "./exec.js";
import { redactSecrets } from "./redact.js";
import type { ProjectContext } from "./types.js";

export type CloudflareConnectionStatus = "ready" | "action-required" | "needs-auth" | "blocked";
export type CloudflareResourceType =
  | "worker"
  | "r2"
  | "d1"
  | "kv"
  | "queue"
  | "secret"
  | "vectorize"
  | "durable-object"
  | "workflow"
  | "browser-run"
  | "rate-limit"
  | "hyperdrive"
  | "ai-gateway";
export type CloudflareResourceStatus =
  | "connected"
  | "configured"
  | "missing"
  | "needs-id"
  | "not-used"
  | "not-checked"
  | "unknown"
  | "blocked";

export interface CloudflareResourceCheck {
  id: string;
  type: CloudflareResourceType;
  name: string;
  binding?: string;
  status: CloudflareResourceStatus;
  local: "declared" | "detected" | "not-used" | "missing";
  remote: "exists" | "missing" | "unknown" | "not-checked";
  message: string;
  command?: string;
}

export interface CloudflareConnectionReport {
  status: CloudflareConnectionStatus;
  cloudflareAuth: LoginStatus;
  account: {
    status: "selected" | "missing" | "unknown";
    accountId?: string;
    source?: "wrangler" | "env";
    message: string;
  };
  project: {
    cwd: string;
    name: string | null;
    framework: string;
    wranglerConfig: string | null;
  };
  resources: CloudflareResourceCheck[];
  warnings: string[];
  nextActions: string[];
}

interface RemoteResource {
  name: string;
  id?: string;
}

interface RemoteInventory {
  r2?: RemoteList;
  d1?: RemoteList;
  kv?: RemoteList;
  queue?: RemoteList;
  secret?: RemoteList;
}

interface RemoteList {
  status: "available" | "failed" | "skipped";
  items: RemoteResource[];
  stderr?: string;
}

export async function createCloudflareConnectionReport(ctx: ProjectContext): Promise<CloudflareConnectionReport> {
  const cloudflareAuth = await cloudflareAuthStatusAsync(ctx.cwd, 3500);
  const account = detectAccount(ctx);
  const local = collectLocalNeeds(ctx);
  const resources: CloudflareResourceCheck[] = [];
  const warnings: string[] = [];

  resources.push(workerCheck(ctx));

  const canReadRemote = cloudflareAuth.state === "in";
  const inventory = canReadRemote
    ? await readRemoteInventory(ctx, local)
    : {};

  if (!canReadRemote) {
    warnings.push("Cloudflare account is not readable yet. Run flarecel auth cf or wrangler login.");
  }

  for (const failure of Object.values(inventory).filter((list): list is RemoteList => Boolean(list) && list.status === "failed")) {
    if (failure.stderr) warnings.push(failure.stderr);
  }

  resources.push(...r2Checks(local.r2, inventory.r2));
  resources.push(...d1Checks(local.d1, inventory.d1));
  resources.push(...kvChecks(local.kv, inventory.kv));
  resources.push(...queueChecks(local.queues, inventory.queue));
  resources.push(...secretChecks(local.secrets, inventory.secret, ctx));
  resources.push(...advancedChecks(local));

  const status = connectionStatus(resources, warnings, cloudflareAuth);
  return {
    status,
    cloudflareAuth,
    account,
    project: {
      cwd: ctx.cwd,
      name: ctx.packageJson?.name ?? null,
      framework: ctx.framework,
      wranglerConfig: ctx.wrangler.path ? path.relative(ctx.cwd, ctx.wrangler.path) : null
    },
    resources,
    warnings: unique(warnings).map((warning) => redactSecrets(warning)),
    nextActions: nextActions(status, resources, account, cloudflareAuth)
  };
}

function collectLocalNeeds(ctx: ProjectContext): {
  r2: Array<{ binding: string; bucketName: string }>;
  d1: Array<{ binding: string; databaseName: string; databaseId: string | null }>;
  kv: Array<{ binding: string; namespaceId: string | null }>;
  queues: Array<{ name: string; binding?: string }>;
  secrets: string[];
  vectorize: Array<{ binding: string; indexName: string }>;
  durableObjects: Array<{ name: string; className?: string }>;
  workflows: Array<{ name: string; binding?: string }>;
  browser: { binding: string } | null;
  rateLimits: Array<{ name: string }>;
  hyperdrive: Array<{ binding: string; id: string | null }>;
  aiGateway: boolean;
} {
  const config = ctx.wrangler.data;
  const empty = {
    r2: [],
    d1: [],
    kv: [],
    queues: [],
    secrets: detectNeededSecrets(ctx),
    vectorize: [],
    durableObjects: [],
    workflows: [],
    browser: null,
    rateLimits: [],
    hyperdrive: [],
    aiGateway: detectsAiGateway(ctx)
  };
  if (!config) return empty;

  return {
    r2: objectArray(config.r2_buckets)
      .map((bucket) => ({
        binding: stringValue(bucket.binding) ?? "R2",
        bucketName: stringValue(bucket.bucket_name) ?? ""
      }))
      .filter((bucket) => bucket.bucketName),
    d1: objectArray(config.d1_databases)
      .map((database) => ({
        binding: stringValue(database.binding) ?? "DB",
        databaseName: stringValue(database.database_name) ?? "",
        databaseId: stringValue(database.database_id)
      }))
      .filter((database) => database.databaseName),
    kv: objectArray(config.kv_namespaces)
      .map((namespace) => ({
        binding: stringValue(namespace.binding) ?? "KV",
        namespaceId: stringValue(namespace.id)
      }))
      .filter((namespace) => namespace.binding),
    queues: collectQueues(config),
    secrets: detectNeededSecrets(ctx),
    vectorize: objectArray(config.vectorize)
      .map((index) => ({
        binding: stringValue(index.binding) ?? "VECTORIZE",
        indexName: stringValue(index.index_name) ?? ""
      }))
      .filter((index) => index.indexName),
    durableObjects: collectDurableObjects(config),
    workflows: objectArray(config.workflows)
      .map((workflow) => ({
        name: stringValue(workflow.name) ?? "",
        binding: stringValue(workflow.binding) ?? undefined
      }))
      .filter((workflow) => workflow.name),
    browser: collectBrowser(config),
    rateLimits: objectArray(config.ratelimits)
      .map((limiter) => ({ name: stringValue(limiter.name) ?? "" }))
      .filter((limiter) => limiter.name),
    hyperdrive: objectArray(config.hyperdrive)
      .map((hyperdrive) => ({
        binding: stringValue(hyperdrive.binding) ?? "",
        id: stringValue(hyperdrive.id)
      }))
      .filter((hyperdrive) => hyperdrive.binding),
    aiGateway: detectsAiGateway(ctx)
  };
}

async function readRemoteInventory(ctx: ProjectContext, local: ReturnType<typeof collectLocalNeeds>): Promise<RemoteInventory> {
  const tasks: Array<Promise<[keyof RemoteInventory, RemoteList]>> = [];
  if (local.r2.length > 0) tasks.push(readRemoteList(ctx, "r2", ["r2", "bucket", "list"]));
  if (local.d1.length > 0) tasks.push(readRemoteList(ctx, "d1", ["d1", "list", "--json"]));
  if (local.kv.length > 0) tasks.push(readRemoteList(ctx, "kv", ["kv", "namespace", "list"]));
  if (local.queues.length > 0) tasks.push(readRemoteList(ctx, "queue", ["queues", "list"]));
  if (local.secrets.length > 0 && ctx.wrangler.data) tasks.push(readRemoteList(ctx, "secret", ["secret", "list", "--format", "json"]));

  const entries = await Promise.all(tasks);
  return Object.fromEntries(entries) as RemoteInventory;
}

async function readRemoteList(ctx: ProjectContext, kind: keyof RemoteInventory, args: string[]): Promise<[keyof RemoteInventory, RemoteList]> {
  const command = resolveWranglerCommand(ctx.cwd);
  const result = await runCommand(command, args, ctx.cwd, { timeoutMs: 20_000 });
  if (result.code !== 0) {
    return [kind, {
      status: "failed",
      items: [],
      stderr: summarizeWranglerError(result.stderr || result.stdout)
    }];
  }

  return [kind, {
    status: "available",
    items: parseRemoteResources(result.stdout, kind)
  }];
}

function workerCheck(ctx: ProjectContext): CloudflareResourceCheck {
  if (!ctx.wrangler.path) {
    return {
      id: "worker:config",
      type: "worker",
      name: "Worker/Pages",
      status: "missing",
      local: "missing",
      remote: "not-checked",
      message: "No Wrangler config found, so Flarecel cannot connect this codebase to a Cloudflare deploy target.",
      command: "flarecel fix --dry-run --format patch"
    };
  }

  if (ctx.wrangler.parseError) {
    return {
      id: "worker:config",
      type: "worker",
      name: "Worker/Pages",
      status: "blocked",
      local: "declared",
      remote: "not-checked",
      message: `Wrangler config exists but could not be parsed: ${ctx.wrangler.parseError}`
    };
  }

  return {
    id: "worker:config",
    type: "worker",
    name: "Worker/Pages",
    status: "configured",
    local: "declared",
    remote: "not-checked",
    message: `Deploy target is configured in ${path.relative(ctx.cwd, ctx.wrangler.path)}.`
  };
}

function r2Checks(local: Array<{ binding: string; bucketName: string }>, remote?: RemoteList): CloudflareResourceCheck[] {
  if (local.length === 0) return [notUsed("r2", "R2", "No R2 bucket bindings declared.")];
  return local.map((bucket) => {
    const found = remoteExists(remote, bucket.bucketName);
    return {
      id: `r2:${bucket.bucketName}`,
      type: "r2",
      name: bucket.bucketName,
      binding: bucket.binding,
      status: statusFromRemote(found),
      local: "declared",
      remote: remoteState(found),
      message: messageFromRemote(found, `R2 bucket ${bucket.bucketName}`, "bucket exists and matches the local binding."),
      command: found === false ? `wrangler r2 bucket create ${bucket.bucketName}` : undefined
    };
  });
}

function d1Checks(local: Array<{ binding: string; databaseName: string; databaseId: string | null }>, remote?: RemoteList): CloudflareResourceCheck[] {
  if (local.length === 0) return [notUsed("d1", "D1", "No D1 database bindings declared.")];
  return local.map((database) => {
    const found = remoteFind(remote, database.databaseName);
    const foundId = found?.id;
    const placeholder = isPlaceholder(database.databaseId);
    const connected = Boolean(found) && !placeholder && (!foundId || foundId === database.databaseId);
    const needsId = Boolean(found) && (placeholder || (Boolean(foundId) && foundId !== database.databaseId));
    const status: CloudflareResourceStatus = connected ? "connected" : needsId ? "needs-id" : statusFromRemote(Boolean(found));

    return {
      id: `d1:${database.databaseName}`,
      type: "d1",
      name: database.databaseName,
      binding: database.binding,
      status,
      local: "declared",
      remote: remoteState(remote === undefined ? undefined : Boolean(found)),
      message: status === "connected"
        ? `D1 database ${database.databaseName} exists and the local database_id is set.`
        : status === "needs-id"
          ? `D1 database ${database.databaseName} exists, but wrangler.jsonc needs the returned database_id.`
          : messageFromRemote(remote === undefined ? undefined : Boolean(found), `D1 database ${database.databaseName}`, "database exists."),
      command: status === "missing" ? `wrangler d1 create ${database.databaseName}` : undefined
    };
  });
}

function kvChecks(local: Array<{ binding: string; namespaceId: string | null }>, remote?: RemoteList): CloudflareResourceCheck[] {
  if (local.length === 0) return [notUsed("kv", "KV", "No KV namespace bindings declared.")];
  return local.map((namespace) => {
    const found = remoteFind(remote, namespace.binding, namespace.namespaceId);
    const foundId = found?.id;
    const placeholder = isPlaceholder(namespace.namespaceId);
    const connected = Boolean(found) && !placeholder && (!foundId || foundId === namespace.namespaceId);
    const needsId = Boolean(found) && (placeholder || (Boolean(foundId) && foundId !== namespace.namespaceId));
    const status: CloudflareResourceStatus = connected ? "connected" : needsId ? "needs-id" : statusFromRemote(Boolean(found));

    return {
      id: `kv:${namespace.binding}`,
      type: "kv",
      name: namespace.binding,
      binding: namespace.binding,
      status,
      local: "declared",
      remote: remoteState(remote === undefined ? undefined : Boolean(found)),
      message: status === "connected"
        ? `KV namespace ${namespace.binding} exists and the local id is set.`
        : status === "needs-id"
          ? `KV namespace ${namespace.binding} exists, but wrangler.jsonc needs the returned namespace id.`
          : messageFromRemote(remote === undefined ? undefined : Boolean(found), `KV namespace ${namespace.binding}`, "namespace exists."),
      command: status === "missing" ? `wrangler kv namespace create ${namespace.binding}` : undefined
    };
  });
}

function queueChecks(local: Array<{ name: string; binding?: string }>, remote?: RemoteList): CloudflareResourceCheck[] {
  if (local.length === 0) return [notUsed("queue", "Queues", "No Queue bindings declared.")];
  return local.map((queue) => {
    const found = remoteExists(remote, queue.name);
    return {
      id: `queue:${queue.name}`,
      type: "queue",
      name: queue.name,
      binding: queue.binding,
      status: statusFromRemote(found),
      local: "declared",
      remote: remoteState(found),
      message: messageFromRemote(found, `Queue ${queue.name}`, "queue exists and matches the local binding."),
      command: found === false ? `wrangler queues create ${queue.name}` : undefined
    };
  });
}

function secretChecks(local: string[], remote: RemoteList | undefined, ctx: ProjectContext): CloudflareResourceCheck[] {
  if (local.length === 0) return [notUsed("secret", "Secrets", "No production secrets detected from the current add-ons.")];
  if (!ctx.wrangler.data) {
    return local.map((name) => ({
      id: `secret:${name}`,
      type: "secret",
      name,
      status: "unknown",
      local: "detected",
      remote: "not-checked",
      message: `Secret ${name} is needed, but there is no Wrangler config to list Worker secrets.`,
      command: `wrangler secret put ${name}`
    }));
  }

  return local.map((name) => {
    const found = remoteExists(remote, name);
    return {
      id: `secret:${name}`,
      type: "secret",
      name,
      status: statusFromRemote(found),
      local: "detected",
      remote: remoteState(found),
      message: messageFromRemote(found, `Secret ${name}`, "secret exists on the Worker."),
      command: found === false ? `wrangler secret put ${name}` : undefined
    };
  });
}

function advancedChecks(local: ReturnType<typeof collectLocalNeeds>): CloudflareResourceCheck[] {
  const checks: CloudflareResourceCheck[] = [];

  for (const index of local.vectorize) {
    checks.push({
      id: `vectorize:${index.indexName}`,
      type: "vectorize",
      name: index.indexName,
      binding: index.binding,
      status: "not-checked",
      local: "declared",
      remote: "not-checked",
      message: "Vectorize index is declared locally. Remote index inventory is not checked yet; run provisioning to review the create command.",
      command: "flarecel provision --json"
    });
  }

  for (const durableObject of local.durableObjects) {
    checks.push({
      id: `durable-object:${durableObject.name}`,
      type: "durable-object",
      name: durableObject.name,
      binding: durableObject.name,
      status: "configured",
      local: "declared",
      remote: "not-checked",
      message: durableObject.className
        ? `Durable Object class ${durableObject.className} is deployed through Wrangler migrations.`
        : "Durable Object binding is declared; class_name should be reviewed before deploy."
    });
  }

  for (const workflow of local.workflows) {
    checks.push({
      id: `workflow:${workflow.name}`,
      type: "workflow",
      name: workflow.name,
      binding: workflow.binding,
      status: "not-checked",
      local: "declared",
      remote: "not-checked",
      message: "Workflow is declared locally. Flarecel does not verify deployed Workflow state yet; use Wrangler after deploy.",
      command: "flarecel provision --json"
    });
  }

  if (local.browser) {
    checks.push({
      id: `browser-run:${local.browser.binding}`,
      type: "browser-run",
      name: "Browser Run",
      binding: local.browser.binding,
      status: "configured",
      local: "declared",
      remote: "not-checked",
      message: "Browser Run binding is configured locally. Confirm route auth/rate limits because usage can become billable."
    });
  }

  for (const limiter of local.rateLimits) {
    checks.push({
      id: `rate-limit:${limiter.name}`,
      type: "rate-limit",
      name: limiter.name,
      status: "configured",
      local: "declared",
      remote: "not-checked",
      message: "Rate Limiting binding is configured locally. Confirm namespace sharing is intentional before production."
    });
  }

  for (const hyperdrive of local.hyperdrive) {
    const placeholder = isPlaceholder(hyperdrive.id);
    checks.push({
      id: `hyperdrive:${hyperdrive.binding}`,
      type: "hyperdrive",
      name: hyperdrive.binding,
      binding: hyperdrive.binding,
      status: placeholder ? "needs-id" : "not-checked",
      local: "declared",
      remote: "not-checked",
      message: placeholder
        ? "Hyperdrive binding needs the real config id from Cloudflare."
        : "Hyperdrive binding has an id locally. Flarecel does not verify Hyperdrive remote config yet.",
      command: placeholder ? "flarecel provision --json" : undefined
    });
  }

  if (local.aiGateway) {
    checks.push({
      id: "ai-gateway:helper",
      type: "ai-gateway",
      name: "AI Gateway",
      status: "not-checked",
      local: "detected",
      remote: "not-checked",
      message: "AI Gateway helper/config was detected. Flarecel does not verify the dashboard Gateway yet.",
      command: "Create or confirm the AI Gateway in Cloudflare dashboard."
    });
  }

  return checks;
}

function notUsed(type: CloudflareResourceType, name: string, message: string): CloudflareResourceCheck {
  return {
    id: `${type}:not-used`,
    type,
    name,
    status: "not-used",
    local: "not-used",
    remote: "not-checked",
    message
  };
}

function connectionStatus(resources: CloudflareResourceCheck[], warnings: string[], auth: LoginStatus): CloudflareConnectionStatus {
  if (auth.state !== "in") return "needs-auth";
  if (resources.some((resource) => resource.status === "blocked") || warnings.length > 0) return "blocked";
  if (resources.some((resource) => resource.status === "missing" || resource.status === "needs-id" || resource.status === "unknown" || resource.status === "not-checked")) return "action-required";
  return "ready";
}

function nextActions(
  status: CloudflareConnectionStatus,
  resources: CloudflareResourceCheck[],
  account: CloudflareConnectionReport["account"],
  auth: LoginStatus
): string[] {
  const actions = new Set<string>();
  const remoteResourceDeclared = resources.some((resource) =>
    resource.local !== "not-used" &&
    resource.type !== "worker"
  );
  if (auth.state !== "in") actions.add("flarecel auth cf");
  if (account.status === "missing" && remoteResourceDeclared) actions.add("Set account_id in wrangler.jsonc or CLOUDFLARE_ACCOUNT_ID");
  for (const resource of resources) {
    if (resource.command) actions.add(resource.command);
  }
  if (resources.some((resource) => resource.type !== "worker" && (resource.status === "missing" || resource.status === "needs-id" || resource.status === "not-checked"))) {
    actions.add("flarecel provision --json");
  }
  if (status !== "ready") actions.add("flarecel verify --json");
  else actions.add("flarecel deploy --preview --yes");
  return [...actions];
}

function detectAccount(ctx: ProjectContext): CloudflareConnectionReport["account"] {
  const envAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (envAccount) {
    return {
      status: "selected",
      accountId: envAccount,
      source: "env",
      message: "Using CLOUDFLARE_ACCOUNT_ID from the environment."
    };
  }

  const configAccount = ctx.wrangler.data && typeof ctx.wrangler.data.account_id === "string"
    ? ctx.wrangler.data.account_id
    : null;
  if (configAccount) {
    return {
      status: "selected",
      accountId: configAccount,
      source: "wrangler",
      message: "Using account_id from Wrangler config."
    };
  }

  return {
    status: "missing",
    message: "Account not pinned. Fine with one Cloudflare account; if Wrangler sees multiple accounts, set account_id or CLOUDFLARE_ACCOUNT_ID."
  };
}

function detectNeededSecrets(ctx: ProjectContext): string[] {
  const secrets = new Set<string>();
  for (const name of detectSecretNamesFromEnvFiles(ctx)) secrets.add(name);
  if (usesBetterAuth(ctx)) secrets.add("BETTER_AUTH_SECRET");
  if (mentionsAny(ctx, ["TURNSTILE_SECRET_KEY", "turnstile"])) secrets.add("TURNSTILE_SECRET_KEY");
  if (hasDependency(ctx, ["stripe"]) || mentionsAny(ctx, ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"])) {
    secrets.add("STRIPE_SECRET_KEY");
    secrets.add("STRIPE_WEBHOOK_SECRET");
  }
  if (hasDependency(ctx, ["resend"]) || mentionsAny(ctx, ["RESEND_API_KEY"])) secrets.add("RESEND_API_KEY");
  if (hasDependency(ctx, ["@clerk/nextjs", "@clerk/backend"]) || mentionsAny(ctx, ["CLERK_SECRET_KEY"])) secrets.add("CLERK_SECRET_KEY");
  if (hasDependency(ctx, ["next-auth", "@auth/core"]) || mentionsAny(ctx, ["AUTH_SECRET"])) secrets.add("AUTH_SECRET");
  if (hasDependency(ctx, ["openai"]) || mentionsAny(ctx, ["OPENAI_API_KEY"])) secrets.add("OPENAI_API_KEY");
  if (hasDependency(ctx, ["@anthropic-ai/sdk"]) || mentionsAny(ctx, ["ANTHROPIC_API_KEY"])) secrets.add("ANTHROPIC_API_KEY");
  if (hasDependency(ctx, ["@supabase/supabase-js"]) || mentionsAny(ctx, ["SUPABASE_SERVICE_ROLE_KEY"])) secrets.add("SUPABASE_SERVICE_ROLE_KEY");
  if (hasDependency(ctx, ["@upstash/redis"]) || mentionsAny(ctx, ["UPSTASH_REDIS_REST_TOKEN"])) secrets.add("UPSTASH_REDIS_REST_TOKEN");
  return [...secrets];
}

function hasDependency(ctx: ProjectContext, names: string[]): boolean {
  return names.some((name) => Boolean(ctx.allDependencies[name]));
}

function detectSecretNamesFromEnvFiles(ctx: ProjectContext): string[] {
  const names = new Set<string>();
  for (const file of [".env", ".env.local", ".env.example", ".env.production", ".env.production.local", ".dev.vars", ".dev.vars.example"]) {
    const text = readText(path.join(ctx.cwd, file));
    if (!text) continue;
    for (const rawLine of text.split(/\r?\n/)) {
      const match = rawLine.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match && looksSecret(match[1])) names.add(match[1]);
    }
  }
  return [...names];
}

function looksSecret(name: string): boolean {
  if (/^(NEXT_PUBLIC_|PUBLIC_|VITE_|NUXT_PUBLIC_)/.test(name)) return false;
  if (/(PUBLISHABLE|ANON_KEY|PUBLIC_KEY)/.test(name)) return false;
  return /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|ACCESS_TOKEN|REFRESH_TOKEN|SERVICE_ROLE|API_KEY|WEBHOOK_SECRET|SIGNING_SECRET|AUTH_SECRET|ENCRYPTION_KEY|DATABASE_URL|DIRECT_URL|DSN|SMTP_PASS|CLIENT_SECRET)/.test(name);
}

function detectsAiGateway(ctx: ProjectContext): boolean {
  return existsSync(path.join(ctx.cwd, "src", "cloudflare", "ai-gateway.ts")) ||
    existsSync(path.join(ctx.cwd, "docs", "flarecel-ai-gateway.md"));
}

function usesBetterAuth(ctx: ProjectContext): boolean {
  return Boolean(ctx.allDependencies["better-auth"]) ||
    existsSync(path.join(ctx.cwd, "app", "api", "auth", "[...all]", "route.ts")) ||
    existsSync(path.join(ctx.cwd, "src", "app", "api", "auth", "[...all]", "route.ts"));
}

function mentionsAny(ctx: ProjectContext, needles: string[]): boolean {
  for (const file of ["cloudflare-env.d.ts", ".dev.vars", ".dev.vars.example", "wrangler.jsonc", "wrangler.json"]) {
    const text = readText(path.join(ctx.cwd, file));
    if (text && needles.some((needle) => text.includes(needle))) return true;
  }
  return false;
}

function collectQueues(config: Record<string, unknown>): Array<{ name: string; binding?: string }> {
  const queues = config.queues;
  if (!queues || typeof queues !== "object" || Array.isArray(queues)) return [];

  const found = new Map<string, { name: string; binding?: string }>();
  for (const producer of objectArray((queues as Record<string, unknown>).producers)) {
    const name = stringValue(producer.queue);
    if (!name) continue;
    found.set(name, { name, binding: stringValue(producer.binding) ?? undefined });
  }
  for (const consumer of objectArray((queues as Record<string, unknown>).consumers)) {
    const name = stringValue(consumer.queue);
    if (!name || found.has(name)) continue;
    found.set(name, { name });
  }
  return [...found.values()];
}

function collectDurableObjects(config: Record<string, unknown>): Array<{ name: string; className?: string }> {
  const durableObjects = config.durable_objects;
  if (!durableObjects || typeof durableObjects !== "object" || Array.isArray(durableObjects)) return [];
  return objectArray((durableObjects as Record<string, unknown>).bindings)
    .map((binding) => ({
      name: stringValue(binding.name) ?? "",
      className: stringValue(binding.class_name) ?? undefined
    }))
    .filter((binding) => binding.name);
}

function collectBrowser(config: Record<string, unknown>): { binding: string } | null {
  const browser = config.browser;
  if (!browser || typeof browser !== "object" || Array.isArray(browser)) return null;
  const binding = stringValue((browser as Record<string, unknown>).binding);
  return binding ? { binding } : null;
}

function parseRemoteResources(stdout: string, kind: keyof RemoteInventory): RemoteResource[] {
  const clean = stripAnsi(stdout).trim();
  const json = parseJsonish(clean);
  if (Array.isArray(json)) {
    return json.flatMap((entry) => remoteResourceFromObject(entry));
  }
  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    for (const key of ["items", "result", "databases", "buckets", "namespaces", "queues", "secrets"]) {
      if (Array.isArray(record[key])) return record[key].flatMap((entry) => remoteResourceFromObject(entry));
    }
  }

  return clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes("wrangler") && !/^[─┌┐└┘├┤┬┴┼│\s]+$/.test(line))
    .map((line) => labeledName(line) ?? tableName(line, kind))
    .filter((name): name is string => Boolean(name))
    .map((name) => ({ name }));
}

function labeledName(line: string): string | null {
  const match = line.match(/^name:\s*(.+)$/i);
  return match?.[1]?.trim() || null;
}

function remoteResourceFromObject(entry: unknown): RemoteResource[] {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  const record = entry as Record<string, unknown>;
  const name = firstString(record, ["name", "bucket_name", "database_name", "title", "queue_name", "queueName"]);
  if (!name) return [];
  return [{
    name,
    id: firstString(record, ["id", "uuid", "database_id", "namespace_id"])
  }];
}

function tableName(line: string, kind: keyof RemoteInventory): string | null {
  const withoutPipes = line.replace(/[│|]/g, " ").trim();
  if (!withoutPipes || /^(name|title|id|created|updated|queue|bucket|database)\b/i.test(withoutPipes)) return null;
  if (withoutPipes.includes("─")) return null;
  const parts = withoutPipes.split(/\s{2,}|\t/).map((part) => part.trim()).filter(Boolean);
  const first = parts[0] ?? withoutPipes.split(/\s+/)[0];
  if (!first || first === "-" || first.toLowerCase() === String(kind)) return null;
  return first;
}

function remoteFind(remote: RemoteList | undefined, name: string, id?: string | null): RemoteResource | null {
  if (!remote || remote.status !== "available") return null;
  return remote.items.find((item) => item.name === name || Boolean(id && item.id === id)) ?? null;
}

function remoteExists(remote: RemoteList | undefined, name: string): boolean | undefined {
  if (!remote) return undefined;
  if (remote.status !== "available") return undefined;
  return remote.items.some((item) => item.name === name || item.id === name);
}

function statusFromRemote(found: boolean | undefined): CloudflareResourceStatus {
  if (found === undefined) return "unknown";
  return found ? "connected" : "missing";
}

function remoteState(found: boolean | undefined): CloudflareResourceCheck["remote"] {
  if (found === undefined) return "unknown";
  return found ? "exists" : "missing";
}

function messageFromRemote(found: boolean | undefined, label: string, connectedSuffix: string): string {
  if (found === undefined) return `${label} could not be checked in Cloudflare.`;
  if (found) return `${label} ${connectedSuffix}`;
  return `${label} is declared locally but missing in Cloudflare.`;
}

function summarizeWranglerError(output: string): string {
  const clean = stripAnsi(redactSecrets(output)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const important = clean.find((line) => /More than one account|not authenticated|not logged in|account_id|CLOUDFLARE_ACCOUNT_ID|ERROR/i.test(line));
  return important ?? clean.slice(0, 2).join(" ") ?? "Wrangler command failed.";
}

function parseJsonish(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    const start = Math.min(...["[", "{"].map((token) => {
      const index = input.indexOf(token);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    }));
    if (!Number.isFinite(start)) return null;
    try {
      return JSON.parse(input.slice(start));
    } catch {
      return null;
    }
  }
}

function resolveWranglerCommand(cwd: string): string {
  const bin = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
  const local = path.join(cwd, "node_modules", ".bin", bin);
  return existsSync(local) ? local : "wrangler";
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is Record<string, unknown> => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate))
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isPlaceholder(value: string | null): boolean {
  return !value || /replace|placeholder|todo/i.test(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readText(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
