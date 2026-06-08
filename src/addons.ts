import { loadCatalogAddons } from "./user-addons.js";

export type AddOnMaturity = "mvp" | "experimental";

export interface AddOnCatalogEntry {
  name: string;
  maturity: AddOnMaturity;
  writesFiles: boolean;
}

export const ADD_ONS: AddOnCatalogEntry[] = [
  { name: "next-opennext", maturity: "mvp", writesFiles: true },
  { name: "r2 uploads", maturity: "mvp", writesFiles: true },
  { name: "db d1 --orm drizzle", maturity: "mvp", writesFiles: true },
  { name: "kv cache", maturity: "mvp", writesFiles: true },
  { name: "rate-limit", maturity: "mvp", writesFiles: true },
  { name: "queue", maturity: "mvp", writesFiles: true },
  { name: "turnstile --form signup", maturity: "mvp", writesFiles: true },
  { name: "cron daily-cleanup --schedule \"0 0 * * *\"", maturity: "mvp", writesFiles: true },
  { name: "workers-ai --model @cf/meta/llama-3.1-8b-instruct", maturity: "mvp", writesFiles: true },
  { name: "vectorize docs-search --dimensions 768 --metric cosine", maturity: "mvp", writesFiles: true },
  { name: "ai-gateway --provider openai", maturity: "mvp", writesFiles: true },
  { name: "observability --sampling 1", maturity: "mvp", writesFiles: true },
  { name: "durable-object room", maturity: "mvp", writesFiles: true },
  { name: "workflow onboarding --schedule \"0 9 * * *\"", maturity: "mvp", writesFiles: true },
  { name: "browser-run", maturity: "mvp", writesFiles: true },
  { name: "auth better-auth --db d1 --orm drizzle", maturity: "mvp", writesFiles: true },
  { name: "auth clerk", maturity: "experimental", writesFiles: true },
  { name: "auth supabase", maturity: "experimental", writesFiles: true },
  { name: "auth authjs", maturity: "experimental", writesFiles: true },
  { name: "auth cloudflare-access", maturity: "experimental", writesFiles: true },
  { name: "db d1 --orm prisma", maturity: "experimental", writesFiles: true },
  { name: "db supabase --mode http|hyperdrive", maturity: "experimental", writesFiles: true },
  { name: "db neon --mode serverless|hyperdrive", maturity: "experimental", writesFiles: true },
  { name: "db turso", maturity: "experimental", writesFiles: true },
  { name: "db planetscale", maturity: "experimental", writesFiles: true },
  { name: "db mongodb", maturity: "experimental", writesFiles: true },
  { name: "backend convex", maturity: "experimental", writesFiles: true },
  { name: "redis upstash", maturity: "experimental", writesFiles: true },
  { name: "isr", maturity: "experimental", writesFiles: true },
  { name: "stripe", maturity: "experimental", writesFiles: true },
  { name: "resend", maturity: "experimental", writesFiles: true },
  { name: "cloudflare-images", maturity: "experimental", writesFiles: true },
  { name: "hyperdrive", maturity: "experimental", writesFiles: true },
  { name: "email-routing", maturity: "experimental", writesFiles: true },
  { name: "saas-billing", maturity: "experimental", writesFiles: true }
];

export function listAddOns(): AddOnCatalogEntry[] {
  return [...ADD_ONS, ...catalogEntries()];
}

// bundled JSON catalog add-ons, surfaced alongside built-ins. Loaded lazily so
// a malformed catalog file can't crash plain listing.
function catalogEntries(): AddOnCatalogEntry[] {
  try {
    return loadCatalogAddons().map((a) => ({ name: a.name, maturity: "experimental" as const, writesFiles: true }));
  } catch {
    return [];
  }
}

export function listAddOnCommands(): string[] {
  return ADD_ONS.map((entry) => entry.name);
}
