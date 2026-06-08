import { runCommand } from "./exec.js";

export interface VercelUsageResult {
  monthlyUsd: number;
  warning?: string;
}

// pulls the real Vercel bill via the already-authenticated `vercel` CLI
// (`vercel usage --format json`). Reuses the user's existing login — no token
// is read, stored, or printed. Returns null on any failure so the caller can
// fall back to the estimate. Opt-in only; never runs unless asked.
export async function fetchVercelUsage(cwd: string): Promise<VercelUsageResult | null> {
  const result = await runCommand("vercel", ["usage", "--format", "json"], cwd, { timeoutMs: 30_000 });
  if (result.code !== 0 || !result.stdout.trim()) return null;

  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  const usd = extractBilledUsd(data);
  if (usd === null) return null;
  return { monthlyUsd: usd };
}

// the CLI exposes `totals` plus a per-service array. Prefer an explicit total,
// otherwise sum service billed costs. Tolerant of field-name variation.
function extractBilledUsd(data: unknown): number | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  const totalsUsd = numberField(obj.totals, ["billedCost", "billed", "amount", "total"]);
  if (totalsUsd !== null) return totalsUsd;

  if (Array.isArray(obj.services)) {
    let sum = 0;
    let found = false;
    for (const svc of obj.services) {
      const v = numberField(svc, ["billedCost", "effectiveCost", "amount"]);
      if (v !== null) {
        sum += v;
        found = true;
      }
    }
    if (found) return Math.round(sum * 100) / 100;
  }
  return null;
}

function numberField(value: unknown, keys: string[]): number | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const parsed = Number(raw.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}
