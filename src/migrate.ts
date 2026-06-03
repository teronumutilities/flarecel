import path from "node:path";
import { readFileIfExists, stripJsonComments } from "./project.js";
import type { ChangeSet, PlannedChange, ProjectContext } from "./types.js";

type JsonObject = Record<string, unknown>;

// Translate a Vercel project's vercel.json (+ .env keys) into Cloudflare Workers
// equivalents. Happy-path only: anything without a clean mechanical mapping is
// FLAGGED (warning) rather than half-generated. Reuses the changeset/apply path.
export async function createVercelMigration(ctx: ProjectContext): Promise<ChangeSet> {
  const raw = await readFileIfExists(path.join(ctx.cwd, "vercel.json"));
  if (raw === null) {
    return {
      status: "error",
      title: "No vercel.json found",
      changes: [],
      warnings: ["migrate vercel expects a vercel.json in the project root."],
      nextActions: ["flarecel doctor --json"]
    };
  }

  let config: JsonObject;
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

  const changes: PlannedChange[] = [];
  const warnings: string[] = [];
  const flags: string[] = [];

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

  // .env keys -> .dev.vars.example (names only, never values)
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
  flags.push("Vercel-specific middleware and ISR edge behavior do not auto-port; verify in a preview deploy.");

  const filtered = changes.filter((change) => change.before !== change.after);
  return {
    status: filtered.length > 0 ? "planned" : "empty",
    title: filtered.length > 0 ? "Migrate Vercel config to Cloudflare" : "No auto-translatable Vercel config found",
    changes: filtered,
    warnings: [
      ...warnings,
      ...flags.map((flag) => `FLAG: ${flag}`)
    ],
    nextActions: filtered.length > 0
      ? ["Review the translation and flags above.", "flarecel migrate vercel --apply --yes", "flarecel verify --json"]
      : ["flarecel doctor --json"]
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
  const env = await readFileIfExists(path.join(ctx.cwd, ".env"));
  if (env === null) return null;
  const keys = env
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")).trim())
    .filter(Boolean);
  if (keys.length === 0) return null;

  // Names only — never copy secret values.
  const block = keys.map((key) => `${key}=replace-with-value`).join("\n");
  return appendBlock(ctx, ".dev.vars.example", block, "Document env var names from .env (values not copied)");
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
