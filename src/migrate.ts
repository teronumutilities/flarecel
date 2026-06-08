import { promises as fs } from "node:fs";
import path from "node:path";
import { collectEnvVariables } from "./env.js";
import { exists, readFileIfExists, stripJsonComments } from "./project.js";
import type { ChangeSet, PlannedChange, ProjectContext } from "./types.js";

type JsonObject = Record<string, unknown>;

// translate a Vercel project's portable config into Cloudflare Workers
// equivalents, and scan source/env/package signals for anything Vercel-shaped.
// anything without a clean mechanical mapping is FLAGGED (warning) rather than
// half-generated. Reuses the changeset/apply path.
export async function createVercelMigration(ctx: ProjectContext): Promise<ChangeSet> {
  const raw = await readFileIfExists(path.join(ctx.cwd, "vercel.json"));
  const hasVercelJson = raw !== null;
  let config: JsonObject = {};
  if (raw !== null) {
    try {
      config = JSON.parse(stripJsonComments(raw)) as JsonObject;
    } catch (error) {
      return {
        status: "error",
        title: "vercel.json could not be parsed",
        changes: [],
        warnings: [`vercel.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
        nextActions: ["Fix vercel.json, then re-run."]
      };
    }
  }

  const changes: PlannedChange[] = [];
  const warnings: string[] = [];
  const flags: string[] = [];
  if (!hasVercelJson) {
    warnings.push("No vercel.json found. Flarecel still scanned source, env names, package dependencies, and Next config for Vercel-shaped coupling.");
  }

  // headers -> public/_headers
  const headerLines = translateHeaders(config.headers);
  if (headerLines.length > 0) {
    changes.push(await appendBlock(ctx, "public/_headers", headerLines.join("\n"), "Translate vercel.json headers to Cloudflare _headers"));
  }

  // redirects -> public/_redirects
  const redirectLines = translateRedirects(config.redirects);
  if (redirectLines.length > 0) {
    changes.push(await appendBlock(ctx, "public/_redirects", redirectLines.join("\n"), "Translate vercel.json redirects to Cloudflare _redirects"));
  }

  // crons -> wrangler triggers.crons
  const cronExpressions = extractCrons(config.crons);
  if (cronExpressions.length > 0) {
    changes.push(await wranglerCronChange(ctx, cronExpressions));
  }

  // trailingSlash -> note (Next.js reads this from next.config, not Cloudflare)
  if (typeof config.trailingSlash === "boolean") {
    flags.push(`trailingSlash: ${config.trailingSlash} — set this in next.config.js (Next reads it natively); no Cloudflare change needed.`);
  }

  // env names -> .dev.vars.example (names only, never values)
  const envChange = await translateEnvExample(ctx);
  if (envChange) changes.push(envChange);

  // FLAG-only (no clean mechanical translation)
  if (Array.isArray(config.rewrites) && config.rewrites.length > 0) {
    flags.push(`rewrites (${config.rewrites.length}) — Vercel rewrites often need Next.js config or Worker logic. Review manually; Flarecel does not auto-generate rewrite logic.`);
  }
  if (isObject(config.functions)) {
    flags.push("functions — per-route runtime/memory config is Vercel-specific. OpenNext runs the whole app as one Worker; review any edge runtime usage.");
  }
  const remotePatterns = isObject(config.images) ? (config.images as JsonObject).remotePatterns : undefined;
  if (Array.isArray(remotePatterns) && remotePatterns.length > 0) {
    flags.push(`images.remotePatterns (${remotePatterns.length}) — keep these in next.config.js images.remotePatterns. Note: next/image optimization differs on Workers (see doctor 'next-image-on-workers').`);
  }
  flags.push(...await collectVercelScanFlags(ctx, config, hasVercelJson));
  if (!flags.some((flag) => /middleware|proxy|ISR|revalidate/.test(flag))) {
    flags.push("Vercel-specific middleware and ISR edge behavior do not auto-port; verify in a preview deploy.");
  }

  const filtered = changes.filter((change) => change.before !== change.after);
  return {
    status: filtered.length > 0 ? "planned" : "empty",
    title: filtered.length > 0 ? "Migrate Vercel config to Cloudflare" : "Vercel migration scan complete",
    changes: filtered,
    warnings: [
      ...warnings,
      ...flags.map((flag) => `FLAG: ${flag}`)
    ],
    nextActions: filtered.length > 0
      ? ["Review the translation and flags above.", "flarecel migrate vercel --apply --yes", "flarecel verify --json"]
      : ["Review any FLAG warnings above.", "flarecel doctor --json"]
  };
}

function translateHeaders(headers: unknown): string[] {
  const lines: string[] = [];
  for (const entry of asArray(headers)) {
    const source = stringField(entry.source);
    const headerList = asArray(entry.headers);
    if (!source || headerList.length === 0) continue;
    lines.push(source);
    for (const h of headerList) {
      const key = stringField(h.key);
      const value = stringField(h.value);
      if (key && value !== null) lines.push(`  ${key}: ${value}`);
    }
  }
  return lines;
}

function translateRedirects(redirects: unknown): string[] {
  const lines: string[] = [];
  for (const entry of asArray(redirects)) {
    const source = stringField(entry.source);
    const destination = stringField(entry.destination);
    if (!source || !destination) continue;
    // permanent -> 301, else 302. _redirects: "<from> <to> <status>"
    const status = entry.permanent === true ? 301 : 302;
    lines.push(`${source} ${destination} ${status}`);
  }
  return lines;
}

function extractCrons(crons: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(crons)) {
    const schedule = stringField(entry.schedule);
    if (schedule) out.push(schedule);
  }
  return out;
}

async function wranglerCronChange(ctx: ProjectContext, cronExpressions: string[]): Promise<PlannedChange> {
  const before = ctx.wrangler.rawText;
  const config: JsonObject = ctx.wrangler.data ? structuredClone(ctx.wrangler.data) : {};
  const triggers = isObject(config.triggers) ? { ...(config.triggers as JsonObject) } : {};
  const existing = Array.isArray(triggers.crons) ? triggers.crons.filter((c): c is string => typeof c === "string") : [];
  triggers.crons = [...new Set([...existing, ...cronExpressions])];
  config.triggers = triggers;
  return {
    path: ctx.wrangler.path ? path.basename(ctx.wrangler.path) : "wrangler.jsonc",
    before,
    after: `${JSON.stringify(config, null, 2)}\n`,
    reason: "Translate vercel.json crons to wrangler triggers.crons"
  };
}

async function translateEnvExample(ctx: ProjectContext): Promise<PlannedChange | null> {
  const keys = (await collectEnvVariables(ctx)).map((variable) => variable.name);
  if (keys.length === 0) return null;

  // names only — never copy secret values.
  const block = keys.map((key) => `${key}=replace-with-value`).join("\n");
  return appendBlock(ctx, ".dev.vars.example", block, "Document env var names from env files/source usage (values not copied)");
}

async function appendBlock(ctx: ProjectContext, relativePath: string, block: string, reason: string): Promise<PlannedChange> {
  const before = await readFileIfExists(path.join(ctx.cwd, relativePath));
  const lines = before ? before.split(/\r?\n/) : [];
  const missing = block.split("\n").filter((line) => !lines.includes(line));
  if (missing.length === 0) {
    return { path: relativePath, before, after: before ?? "", reason };
  }
  const after = `${before ? before.replace(/\n?$/, "\n") : ""}${missing.join("\n")}\n`;
  return { path: relativePath, before, after, reason };
}

async function collectVercelScanFlags(ctx: ProjectContext, config: JsonObject, hasVercelJson: boolean): Promise<string[]> {
  const flags: string[] = [];
  const nextConfigFiles = await existingFiles(ctx, ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]);
  if (nextConfigFiles.length > 0) {
    flags.push(`${nextConfigFiles.join(", ")} found — review images, redirects, headers, experimental.serverExternalPackages, and output settings for Cloudflare Workers.`);
  }

  const middlewareFiles = await existingFiles(ctx, ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js", "proxy.ts", "proxy.js", "src/proxy.ts", "src/proxy.js"]);
  if (middlewareFiles.length > 0) {
    flags.push(`middleware/proxy files (${middlewareFiles.join(", ")}) — verify request matching, cookies, rewrites, and auth behavior in a Cloudflare preview.`);
  }

  if (ctx.sourceRisks.some((risk) => risk.kind === "next-image-import")) {
    flags.push("next/image imports detected — image optimization behavior differs on Workers; verify remote images and loader behavior.");
  }

  const envVars = await collectEnvVariables(ctx);
  const vercelEnv = envVars
    .map((variable) => variable.name)
    .filter((name) => name === "VERCEL" || name.startsWith("VERCEL_") || name.startsWith("NEXT_PUBLIC_VERCEL_") || name.startsWith("TURBO_"));
  if (vercelEnv.length > 0) {
    flags.push(`Vercel/Turborepo env names detected (${vercelEnv.slice(0, 8).join(", ")}${vercelEnv.length > 8 ? ", ..." : ""}) — replace deployment-url assumptions with Cloudflare equivalents or app-owned config.`);
  }

  const packageFlags = Object.keys(ctx.allDependencies)
    .filter((name) => name.startsWith("@vercel/") || name === "vercel")
    .sort();
  if (packageFlags.length > 0) {
    flags.push(`Vercel package dependencies detected (${packageFlags.join(", ")}) — confirm they run on Workers or replace with provider-neutral code.`);
  }

  const signals = await scanSourceSignals(ctx.cwd);
  if (signals.maxDuration.length > 0) {
    flags.push(`maxDuration exports found (${formatFiles(signals.maxDuration)}) — Vercel timeout directives are ignored by Workers; validate long routes and background work.`);
  }
  if (signals.isr.length > 0) {
    flags.push(`ISR/revalidation usage found (${formatFiles(signals.isr)}) — use OpenNext cache support and verify revalidate behavior in preview.`);
  }
  if (signals.vercelImports.length > 0) {
    flags.push(`Vercel-specific imports found (${formatFiles(signals.vercelImports)}) — replace @vercel/* helpers or verify Workers compatibility.`);
  }

  if (!hasVercelJson && flags.length === 0 && Object.keys(config).length === 0) {
    flags.push("No obvious Vercel-only config found. Still run preview deploy; runtime behavior is the real proof.");
  }

  return flags;
}

async function existingFiles(ctx: ProjectContext, relativePaths: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const relativePath of relativePaths) {
    if (await exists(path.join(ctx.cwd, relativePath))) found.push(relativePath);
  }
  return found;
}

interface SourceSignals {
  maxDuration: string[];
  isr: string[];
  vercelImports: string[];
}

async function scanSourceSignals(cwd: string): Promise<SourceSignals> {
  const signals: SourceSignals = { maxDuration: [], isr: [], vercelImports: [] };
  for (const file of await collectSourceFiles(cwd)) {
    const text = await safeRead(path.join(cwd, file));
    if (text === null) continue;
    if (/export\s+const\s+maxDuration\s*=/.test(text)) signals.maxDuration.push(file);
    if (/revalidate(?:Path|Tag)\s*\(|export\s+const\s+revalidate\s*=|next\s*:\s*\{[\s\S]{0,240}\brevalidate\b/.test(text)) signals.isr.push(file);
    if (/(?:from|import)\s*["'](?:@vercel\/[^"']+|vercel\/[^"']+)["']|require\(\s*["'](?:@vercel\/[^"']+|vercel\/[^"']+)["']\s*\)/.test(text)) signals.vercelImports.push(file);
  }
  return signals;
}

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
  "out"
]);

async function collectSourceFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await visit(path.join(dir, entry.name));
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(path.relative(cwd, path.join(dir, entry.name)));
      }
    }
  }
  await visit(cwd);
  return files.sort();
}

async function safeRead(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > 1_000_000) return null;
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function formatFiles(files: string[]): string {
  const shown = files.slice(0, 5).join(", ");
  return files.length > 5 ? `${shown}, +${files.length - 5} more` : shown;
}

function asArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((v): v is JsonObject => isObject(v))
    : [];
}
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
