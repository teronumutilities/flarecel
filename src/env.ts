import { promises as fs } from "node:fs";
import path from "node:path";
import { exists, readFileIfExists } from "./project.js";
import type { ProjectContext } from "./types.js";

export type EnvClassification = "public" | "secret" | "config";
export type EnvRecommendedTarget = "wrangler vars" | "wrangler secret";

export interface EnvVarReport {
  name: string;
  classification: EnvClassification;
  recommendedTarget: EnvRecommendedTarget;
  command?: string;
  sources: string[];
  reason: string;
  configuredInWranglerVars: boolean;
}

export interface EnvReport {
  status: "empty" | "ready" | "action-required";
  mode: "all" | "secrets";
  project: {
    cwd: string;
    name: string | null;
    framework: string;
  };
  variables: EnvVarReport[];
  summary: {
    total: number;
    public: number;
    secret: number;
    config: number;
    configuredInWranglerVars: number;
  };
  warnings: string[];
  nextActions: string[];
}

interface EnvNameHit {
  name: string;
  source: string;
}

export interface EnvAuditOptions {
  secretsOnly?: boolean;
}

const ENV_FILES = [
  ".env",
  ".env.local",
  ".env.example",
  ".env.production",
  ".env.production.local",
  ".dev.vars",
  ".dev.vars.example"
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".open-next",
  ".vercel",
  ".wrangler",
  "dist",
  "build",
  "node_modules",
  "coverage",
  "out",
  "fixtures",
  "fixture",
  "scripts",
  "script",
  "test",
  "tests",
  "__tests__",
  "__mocks__"
]);
const MAX_SOURCE_FILES = 600;
const MAX_FILE_BYTES = 1_000_000;

const PUBLIC_PREFIXES = ["NEXT_PUBLIC_", "PUBLIC_", "VITE_", "NUXT_PUBLIC_"];
const PUBLIC_HINTS = ["PUBLISHABLE", "ANON_KEY", "PUBLIC_KEY"];
const SECRET_HINT = /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|ACCESS_TOKEN|REFRESH_TOKEN|SERVICE_ROLE|API_KEY|WEBHOOK_SECRET|SIGNING_SECRET|AUTH_SECRET|ENCRYPTION_KEY|DATABASE_URL|DIRECT_URL|DSN|SMTP_PASS|CLIENT_SECRET)/;

export async function createEnvReport(ctx: ProjectContext, options: EnvAuditOptions = {}): Promise<EnvReport> {
  const allVariables = await collectEnvVariables(ctx);
  const variables = options.secretsOnly
    ? allVariables.filter((variable) => variable.classification === "secret")
    : allVariables;
  const summary = summarize(variables);
  const warnings = buildWarnings(variables, options);
  const nextActions = buildNextActions(variables, options);
  return {
    status: statusFor(variables),
    mode: options.secretsOnly ? "secrets" : "all",
    project: {
      cwd: ctx.cwd,
      name: ctx.packageJson?.name ?? null,
      framework: ctx.framework
    },
    variables,
    summary,
    warnings,
    nextActions
  };
}

export async function collectEnvVariables(ctx: ProjectContext): Promise<EnvVarReport[]> {
  const hits = await collectEnvNameHits(ctx);
  const bindingNames = collectBindingNames(ctx);
  const configuredVars = collectConfiguredVars(ctx);
  const byName = new Map<string, Set<string>>();

  for (const hit of hits) {
    if (!isEnvLikeName(hit.name)) continue;
    if (bindingNames.has(hit.name)) continue;
    const sources = byName.get(hit.name) ?? new Set<string>();
    sources.add(hit.source);
    byName.set(hit.name, sources);
  }

  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, sources]) => {
      const classification = classifyEnvName(name);
      const configuredInWranglerVars = configuredVars.has(name);
      const recommendedTarget: EnvRecommendedTarget = classification === "secret" ? "wrangler secret" : "wrangler vars";
      return {
        name,
        classification,
        recommendedTarget,
        command: classification === "secret" ? `wrangler secret put ${name}` : undefined,
        sources: [...sources].sort(),
        reason: reasonFor(name, classification),
        configuredInWranglerVars
      };
    });
}

function summarize(variables: EnvVarReport[]): EnvReport["summary"] {
  return {
    total: variables.length,
    public: variables.filter((variable) => variable.classification === "public").length,
    secret: variables.filter((variable) => variable.classification === "secret").length,
    config: variables.filter((variable) => variable.classification === "config").length,
    configuredInWranglerVars: variables.filter((variable) => variable.configuredInWranglerVars).length
  };
}

function statusFor(variables: EnvVarReport[]): EnvReport["status"] {
  if (variables.length === 0) return "empty";
  if (variables.some((variable) => variable.classification === "secret")) return "action-required";
  if (variables.some((variable) => !variable.configuredInWranglerVars)) return "action-required";
  return "ready";
}

function buildWarnings(variables: EnvVarReport[], options: EnvAuditOptions): string[] {
  const warnings = [
    "Names only. Flarecel does not read, print, or migrate secret values."
  ];
  const secretCount = variables.filter((variable) => variable.classification === "secret").length;
  if (secretCount > 0) {
    warnings.push(`${secretCount} secret name(s) need explicit Cloudflare setup with wrangler secret put.`);
  }
  if (!options.secretsOnly && variables.some((variable) => variable.classification !== "secret" && !variable.configuredInWranglerVars)) {
    warnings.push("Non-secret variables should be copied to Wrangler vars or the Cloudflare dashboard before deploy.");
  }
  return warnings;
}

function buildNextActions(variables: EnvVarReport[], options: EnvAuditOptions): string[] {
  if (variables.length === 0) {
    return options.secretsOnly
      ? ["No secret-looking env names found."]
      : ["No env names found in common env files or source usage."];
  }

  const actions = new Set<string>();
  for (const variable of variables) {
    if (variable.command) actions.add(variable.command);
  }
  if (!options.secretsOnly && variables.some((variable) => variable.classification !== "secret" && !variable.configuredInWranglerVars)) {
    actions.add("Add public/config values to wrangler.jsonc vars or the Cloudflare dashboard.");
  }
  actions.add("flarecel verify --json");
  return [...actions];
}

async function collectEnvNameHits(ctx: ProjectContext): Promise<EnvNameHit[]> {
  const hits: EnvNameHit[] = [];
  for (const fileName of ENV_FILES) {
    const text = await readFileIfExists(path.join(ctx.cwd, fileName));
    if (text === null) continue;
    for (const name of parseDotenvNames(text)) {
      hits.push({ name, source: fileName });
    }
  }

  const cfEnv = await readFileIfExists(path.join(ctx.cwd, "cloudflare-env.d.ts"));
  if (cfEnv !== null) {
    for (const name of parseCloudflareEnvTypeNames(cfEnv)) {
      hits.push({ name, source: "cloudflare-env.d.ts" });
    }
  }

  for (const file of await collectSourceFiles(ctx.cwd)) {
    const fullPath = path.join(ctx.cwd, file);
    const text = await safeReadSource(fullPath);
    if (text === null) continue;
    for (const name of parseSourceEnvNames(text)) {
      hits.push({ name, source: file });
    }
  }

  return hits;
}

function parseDotenvNames(input: string): string[] {
  const names: string[] = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) names.push(match[1]);
  }
  return names;
}

function parseCloudflareEnvTypeNames(input: string): string[] {
  const names = new Set<string>();
  for (const match of input.matchAll(/\b([A-Z][A-Z0-9_]{1,})\??:\s/g)) {
    names.add(match[1]);
  }
  return [...names];
}

function parseSourceEnvNames(input: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]{1,})\b/g,
    /\bprocess\.env\[['"]([A-Z][A-Z0-9_]{1,})['"]\]/g,
    /\benv\.([A-Z][A-Z0-9_]{1,})\b/g,
    /\benv\[['"]([A-Z][A-Z0-9_]{1,})['"]\]/g
  ];
  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) names.add(match[1]);
  }
  return [...names];
}

function classifyEnvName(name: string): EnvClassification {
  if (PUBLIC_PREFIXES.some((prefix) => name.startsWith(prefix))) return "public";
  if (PUBLIC_HINTS.some((hint) => name.includes(hint))) return "public";
  if (SECRET_HINT.test(name)) return "secret";
  return "config";
}

function reasonFor(name: string, classification: EnvClassification): string {
  if (classification === "public") return `${name} is public/client-readable by naming convention.`;
  if (classification === "secret") return `${name} looks sensitive by name; put the value in Cloudflare Secrets.`;
  return `${name} looks like runtime configuration; keep it out of source values and configure it for Cloudflare.`;
}

function isEnvLikeName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]{1,}$/.test(name);
}

function collectConfiguredVars(ctx: ProjectContext): Set<string> {
  const vars = ctx.wrangler.data?.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return new Set();
  return new Set(Object.keys(vars));
}

function collectBindingNames(ctx: ProjectContext): Set<string> {
  const config = ctx.wrangler.data;
  const names = new Set<string>();
  if (!config) return names;

  collectArrayBindingNames(config.r2_buckets, names);
  collectArrayBindingNames(config.d1_databases, names);
  collectArrayBindingNames(config.kv_namespaces, names);
  collectArrayBindingNames(config.vectorize, names);
  collectArrayBindingNames(config.workflows, names);
  collectArrayBindingNames(config.ratelimits, names);
  collectArrayBindingNames(config.hyperdrive, names);
  collectArrayBindingNames(config.services, names);
  collectArrayBindingNames(config.analytics_engine_datasets, names);

  const durable = config.durable_objects;
  if (durable && typeof durable === "object" && !Array.isArray(durable)) {
    collectArrayBindingNames((durable as Record<string, unknown>).bindings, names);
  }

  const queues = config.queues;
  if (queues && typeof queues === "object" && !Array.isArray(queues)) {
    const queueConfig = queues as Record<string, unknown>;
    collectArrayBindingNames(queueConfig.producers, names);
    collectArrayBindingNames(queueConfig.consumers, names);
  }

  return names;
}

function collectArrayBindingNames(value: unknown, names: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const binding = typeof record.binding === "string" ? record.binding : typeof record.name === "string" ? record.name : null;
    if (binding && isEnvLikeName(binding)) names.add(binding);
  }
}

async function collectSourceFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    if (files.length >= MAX_SOURCE_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_SOURCE_FILES) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await visit(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      files.push(path.relative(cwd, path.join(dir, entry.name)));
    }
  }

  await visit(cwd);
  return files.sort();
}

async function safeReadSource(filePath: string): Promise<string | null> {
  if (!await exists(filePath)) return null;
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) return null;
  return fs.readFile(filePath, "utf8");
}
