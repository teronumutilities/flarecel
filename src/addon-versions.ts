// version catalog for generated add-ons/stacks. Keep this separate from the
// add-on implementations so the big add-on file can keep shrinking.
export const DEP_VERSIONS: Record<string, string> = {
  "@opennextjs/cloudflare": "^1.19.11",
  "wrangler": "^4.97.0",
  "@cloudflare/workers-types": "^4.20260603.1",
  "better-auth": "^1.6.14",
  "drizzle-orm": "^0.45.2",
  "drizzle-kit": "^0.31.10",
  "@cloudflare/puppeteer": "^1.1.0",
  // third-party integrations (verified against Cloudflare docs + npm, 2026-06-04).
  "@clerk/nextjs": "^7.4.3",
  "@supabase/ssr": "^0.10.3",
  "@supabase/supabase-js": "^2.107.0",
  "next-auth": "^5.0.0-beta.31",
  "jose": "^6.2.3",
  "@prisma/client": "^7.8.0",
  "@prisma/adapter-d1": "^7.8.0",
  "prisma": "^7.8.0",
  "@neondatabase/serverless": "^1.1.0",
  "@libsql/client": "^0.17.3",
  "@planetscale/database": "^1.20.1",
  "mongodb": "^7.2.0",
  "convex": "^1.40.0",
  "@upstash/redis": "^1.38.0",
  "pg": "^8.21.0",
  "@types/pg": "^8.20.0",
  "stripe": "^22.2.0",
  "resend": "^6.12.4"
};

export const VERIFIED_ON = "2026-06-04";

export function depVersion(name: string): string {
  return DEP_VERSIONS[name] ?? "latest";
}
