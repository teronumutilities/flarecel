import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./exec.js";
import type { ProjectContext } from "./types.js";

export interface CloudflareUsageResult {
  requests: number;
  avgCpuMs: number;
  windowDays: number;
}

export interface CloudflareUsageError {
  reason: "no-token" | "no-account" | "request-failed" | "no-data";
  detail: string;
  nextAction?: string;
}

export type CloudflareUsageOutcome =
  | { ok: true; usage: CloudflareUsageResult; metered: Record<string, string> }
  | { ok: false; error: CloudflareUsageError };

// R2 operation classification (verified against r2/pricing). Unknown ops are
// treated as Class A (the pricier, mutating class) so we never under-estimate.
const R2_CLASS_B = new Set([
  "headbucket", "headobject", "getobject", "usagesummary", "getbucketencryption",
  "getbucketlocation", "getbucketcors", "getbucketlifecycleconfiguration"
]);
const R2_FREE = new Set(["deleteobject", "deletebucket", "abortmultipartupload"]);

interface Credentials {
  token: string | null;
  accountId: string | null;
  // populated only when the account is ambiguous (multiple accounts, none
  // selected) so the caller can ask the user to choose instead of guessing.
  accounts?: Array<{ id: string; name: string }>;
}

// resolve a GraphQL bearer token. The `wrangler login` OAuth token's
// account:read scope covers account analytics (Cloudflare's own scope
// description), so a normal login is enough — no separate API token. Verified
// against a live account (2026-06): the stored OAuth token is accepted by the
// GraphQL Analytics API when filtered by accountTag.
//
// order: CLOUDFLARE_API_TOKEN, then the OAuth token wrangler stored on disk,
// then `wrangler auth token` (newer Wrangler only). We read the token from
// disk directly (works on every Wrangler version) and only shell out to
// `wrangler whoami` to force a refresh when the stored token is expired — so
// the common path makes no slow subprocess call at all.
async function resolveToken(ctx: ProjectContext): Promise<string | null> {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;

  const local = path.join(ctx.cwd, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  const [bin, ...base] = existsSync(local) ? [local] : ["npx", "wrangler"];

  let disk = readDiskOAuth();
  const expired = disk?.expiresAt != null && disk.expiresAt <= Date.now() + 60_000;
  if (!disk || expired) {
    // whoami refreshes an expired access token and rewrites the config file.
    await runCommand(bin, [...base, "whoami"], ctx.cwd, { timeoutMs: 15_000 });
    disk = readDiskOAuth();
  }
  if (disk) return disk.token;

  // newer Wrangler (Dec 2025+) exposes the token directly; older versions
  // reject this with "Unknown arguments", which is why disk-read comes first.
  const result = await runCommand(bin, [...base, "auth", "token", "--json"], ctx.cwd, { timeoutMs: 15_000 });
  if (result.code === 0) {
    try {
      const parsed = JSON.parse(result.stdout) as { token?: string };
      if (typeof parsed.token === "string" && parsed.token) return parsed.token;
    } catch {
      // not JSON — fall through
    }
  }
  return null;
}

// list accounts the token can see, via REST (fast + structured + stable order,
// unlike scraping `wrangler whoami`). The account-scoped OAuth token cannot
// enumerate accounts through GraphQL, but REST /accounts works.
async function listAccounts(token: string): Promise<Array<{ id: string; name: string }>> {
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=50", {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { result?: Array<{ id?: unknown; name?: unknown }> };
    if (!Array.isArray(json.result)) return [];
    return json.result
      .filter((a): a is { id: string; name?: unknown } => typeof a.id === "string" && a.id.length > 0)
      .map((a) => ({ id: a.id, name: typeof a.name === "string" ? a.name : a.id }));
  } catch {
    return [];
  }
}

async function resolveCredentials(ctx: ProjectContext): Promise<Credentials> {
  const explicit = process.env.CLOUDFLARE_ACCOUNT_ID
    || (typeof ctx.wrangler.data?.account_id === "string" ? ctx.wrangler.data.account_id : "")
    || null;

  const token = await resolveToken(ctx);
  if (!token) return { token: null, accountId: explicit };
  if (explicit) return { token, accountId: explicit };

  // no account configured — discover it. Use the only account automatically;
  // refuse to guess among several (cost must be the RIGHT account's).
  const accounts = await listAccounts(token);
  if (accounts.length === 1) return { token, accountId: accounts[0].id };
  if (accounts.length > 1) return { token, accountId: null, accounts };
  return { token, accountId: null };
}

// wrangler's OAuth config lives in an OS-specific dir; it stores oauth_token
// in a tiny TOML file written at `wrangler login`.
function wranglerConfigPaths(): string[] {
  const home = os.homedir();
  const candidates = [
    process.env.WRANGLER_HOME && path.join(process.env.WRANGLER_HOME, "config", "default.toml"),
    process.platform === "darwin" && path.join(home, "Library", "Preferences", ".wrangler", "config", "default.toml"),
    process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, ".wrangler", "config", "default.toml"),
    path.join(home, ".config", ".wrangler", "config", "default.toml"),
    path.join(home, ".wrangler", "config", "default.toml")
  ];
  return candidates.filter((p): p is string => typeof p === "string");
}

function readDiskOAuth(): { token: string; expiresAt: number | null } | null {
  for (const file of wranglerConfigPaths()) {
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf8");
      const token = text.match(/^\s*oauth_token\s*=\s*"([^"]+)"/m)?.[1];
      if (!token) continue;
      const exp = text.match(/^\s*expiration_time\s*=\s*"([^"]+)"/m)?.[1];
      const expiresAt = exp ? Date.parse(exp) : NaN;
      return { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
    } catch {
      // unreadable — try the next candidate
    }
  }
  return null;
}

const QUERY = `query Usage($tag: string!, $start: Time, $end: Time, $startDate: Date, $endDate: Date) {
  viewer { accounts(filter: {accountTag: $tag}) {
    workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) {
      sum { requests } quantiles { cpuTimeP50 }
    }
    r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) {
      sum { requests } dimensions { actionType }
    }
    r2StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: $start, datetime_leq: $end}) {
      max { payloadSize } dimensions { datetime }
    }
    d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $startDate, date_leq: $endDate}) {
      sum { rowsRead rowsWritten }
    }
    d1StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $startDate, date_leq: $endDate}) {
      max { databaseSizeBytes } dimensions { date }
    }
    kvOperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $startDate, date_leq: $endDate}) {
      sum { requests } dimensions { actionType }
    }
    kvStorageAdaptiveGroups(limit: 10000, filter: {date_geq: $startDate, date_leq: $endDate}) {
      max { byteCount } dimensions { date }
    }
  } }
}`;

interface OpRow { sum?: { requests?: number }; dimensions?: { actionType?: string } }
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const bytesToGb = (bytes: number): number => Number((bytes / 1e9).toFixed(3));

// average a storage time-series (per-point peak bytes) ~ GB-month over the window.
function avgStorageGb(rows: Array<{ max?: Record<string, number | undefined> }> | undefined, field: string): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const total = rows.reduce((sum, row) => sum + num(row.max?.[field]), 0);
  return bytesToGb(total / rows.length);
}

// pull REAL usage (Workers + R2 + D1 + KV) from Cloudflare's GraphQL Analytics
// API over the last 30 days. Returns usage only — NOT dollars; the caller
// prices it with published rates. Auth reuses the `wrangler login` OAuth token
// (account:read covers analytics) or CLOUDFLARE_API_TOKEN; we fail loud with
// the exact fix if neither is available.
export async function fetchCloudflareUsage(ctx: ProjectContext): Promise<CloudflareUsageOutcome> {
  const { token, accountId, accounts } = await resolveCredentials(ctx);
  if (!token) {
    return { ok: false, error: {
      reason: "no-token",
      detail: "No Cloudflare credentials found. Run `wrangler login` (its OAuth token is reused automatically), or set CLOUDFLARE_API_TOKEN.",
      nextAction: "flarecel auth cloudflare"
    }};
  }
  const tag = accountId;
  if (!tag) {
    // multiple accounts and none selected: refuse to guess — a wrong account
    // would mean a wrong bill. Show the choices.
    if (accounts && accounts.length > 1) {
      const list = accounts.map((a) => `${a.name} (${a.id})`).join(", ");
      return { ok: false, error: {
        reason: "no-account",
        detail: `Your login can see ${accounts.length} accounts: ${list}. Flarecel will not guess which one to bill.`,
        nextAction: `Set CLOUDFLARE_ACCOUNT_ID=<id> (or add account_id to wrangler.jsonc) for the account you want.`
      }};
    }
    return { ok: false, error: {
      reason: "no-account",
      detail: "Could not determine your Cloudflare account id.",
      nextAction: "Set CLOUDFLARE_ACCOUNT_ID, or add account_id to wrangler.jsonc."
    }};
  }

  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString();
  const day = (d: Date) => d.toISOString().slice(0, 10);

  let json: unknown;
  try {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { tag, start: iso(start), end: iso(end), startDate: day(start), endDate: day(end) } }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      return { ok: false, error: { reason: "request-failed", detail: `Cloudflare GraphQL returned HTTP ${res.status}.`, nextAction: "Verify the token has Account Analytics:Read." } };
    }
    json = await res.json();
  } catch (error) {
    return { ok: false, error: { reason: "request-failed", detail: error instanceof Error ? error.message : String(error) } };
  }

  const errors = (json as { errors?: Array<{ message?: string }> })?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return { ok: false, error: { reason: "request-failed", detail: errors.map((e) => e.message).filter(Boolean).join("; ") || "GraphQL error.", nextAction: "If you used `wrangler login --scopes`, re-run `wrangler login` (default scopes include analytics) or set a CLOUDFLARE_API_TOKEN with Account Analytics:Read." } };
  }

  const acct = (json as { data?: { viewer?: { accounts?: Array<Record<string, unknown>> } } })?.data?.viewer?.accounts?.[0];
  if (!acct) {
    return { ok: false, error: { reason: "no-data", detail: "No analytics found for this account in the last 30 days." } };
  }

  // ---- Workers (primary usage that overrides the assumption) ----
  const wRows = (acct.workersInvocationsAdaptive as Array<{ sum?: { requests?: number }; quantiles?: { cpuTimeP50?: number } }>) ?? [];
  let requests = 0;
  let weightedCpuMicros = 0;
  for (const row of wRows) {
    const r = num(row.sum?.requests);
    requests += r;
    weightedCpuMicros += r * num(row.quantiles?.cpuTimeP50);
  }
  const avgCpuMs = requests > 0 ? Number(((weightedCpuMicros / requests) / 1000).toFixed(3)) : 0;

  // ---- R2 operations: split into Class A / Class B (free ops excluded) ----
  let r2ClassA = 0;
  let r2ClassB = 0;
  for (const row of (acct.r2OperationsAdaptiveGroups as OpRow[]) ?? []) {
    const action = (row.dimensions?.actionType ?? "").toLowerCase();
    const reqs = num(row.sum?.requests);
    if (R2_FREE.has(action)) continue;
    if (R2_CLASS_B.has(action)) r2ClassB += reqs;
    else r2ClassA += reqs; // known Class A + unknown (conservative)
  }

  // ---- D1 rows (the actual billing metric) ----
  let d1Reads = 0;
  let d1Writes = 0;
  for (const row of (acct.d1AnalyticsAdaptiveGroups as Array<{ sum?: { rowsRead?: number; rowsWritten?: number } }>) ?? []) {
    d1Reads += num(row.sum?.rowsRead);
    d1Writes += num(row.sum?.rowsWritten);
  }

  // ---- KV operations by actionType ----
  let kvReads = 0, kvWrites = 0, kvDeletes = 0, kvLists = 0;
  for (const row of (acct.kvOperationsAdaptiveGroups as OpRow[]) ?? []) {
    const action = (row.dimensions?.actionType ?? "").toLowerCase();
    const reqs = num(row.sum?.requests);
    if (action === "read") kvReads += reqs;
    else if (action === "write") kvWrites += reqs;
    else if (action === "delete") kvDeletes += reqs;
    else if (action === "list") kvLists += reqs;
  }

  // ---- Storage (averaged daily peak ~ GB-month) ----
  const r2StorageGb = avgStorageGb(acct.r2StorageAdaptiveGroups as Array<{ max?: Record<string, number> }>, "payloadSize");
  const d1StorageGb = avgStorageGb(acct.d1StorageAdaptiveGroups as Array<{ max?: Record<string, number> }>, "databaseSizeBytes");
  const kvStorageGb = avgStorageGb(acct.kvStorageAdaptiveGroups as Array<{ max?: Record<string, number> }>, "byteCount");

  // binding usage becomes flag overrides priced by cost.ts published rates.
  const metered: Record<string, string> = {};
  const set = (key: string, value: number) => { if (value > 0) metered[key] = String(value); };
  set("r2-class-a", Math.round(r2ClassA));
  set("r2-class-b", Math.round(r2ClassB));
  set("r2-storage-gb", r2StorageGb);
  set("d1-reads", Math.round(d1Reads));
  set("d1-writes", Math.round(d1Writes));
  set("d1-storage-gb", d1StorageGb);
  set("kv-reads", Math.round(kvReads));
  set("kv-writes", Math.round(kvWrites));
  set("kv-deletes", Math.round(kvDeletes));
  set("kv-lists", Math.round(kvLists));
  set("kv-storage-gb", kvStorageGb);

  // a successful read with zero usage is a REAL answer ($0), not a failure.
  // returning ok here keeps the estimate grounded in the account (usageSource
  // = cloudflare-live) instead of silently reverting to assumed traffic — the
  // whole point of authenticating.
  return { ok: true, usage: { requests, avgCpuMs, windowDays: 30 }, metered };
}
