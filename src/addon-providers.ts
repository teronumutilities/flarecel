import { projectName } from "./project.js";
import { externalIntegrationAddOn, integrationDoc, type IntegrationFile, type IntegrationSpec, type AddOnOptions } from "./addon-spec.js";
import {
  type JsonObject,
  nextRoutePath, nextLibPath, nextSrcRootPath, nextRootFile,
  relativeImport, addUniqueStrings, upsertArrayObject, unknownAddOn
} from "./addon-utils.js";
import type { ChangeSet, ProjectContext } from "./types.js";

// shared: add a Hyperdrive binding + nodejs_compat. Used by the Postgres-over-
// Hyperdrive db specs and the standalone hyperdrive spec.
export function hyperdriveBinding(config: JsonObject): void {
  config.compatibility_flags = addUniqueStrings(config.compatibility_flags, ["nodejs_compat"]);
  config.hyperdrive = upsertArrayObject(config.hyperdrive, "binding", {
    binding: "HYPERDRIVE",
    id: "replace-with-hyperdrive-id"
  });
}

// ----- Auth providers -----

export async function authAddOn(ctx: ProjectContext, provider: string): Promise<ChangeSet> {
  if (provider === "clerk") return externalIntegrationAddOn(ctx, clerkSpec(ctx));
  if (provider === "supabase") return externalIntegrationAddOn(ctx, supabaseAuthSpec(ctx));
  if (provider === "authjs" || provider === "auth.js" || provider === "next-auth") {
    return externalIntegrationAddOn(ctx, authjsSpec(ctx));
  }
  if (provider === "cloudflare-access" || provider === "access") {
    return externalIntegrationAddOn(ctx, cloudflareAccessSpec(ctx));
  }
  return unknownAddOn(`auth ${provider}`);
}

function clerkSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "Clerk auth",
    deps: ["@clerk/nextjs"],
    envTypes: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: string;", "CLERK_SECRET_KEY: string;"],
    envExample: ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_replace", "CLERK_SECRET_KEY=sk_test_replace"],
    files: [
      {
        path: () => nextSrcRootPath(ctx, "middleware.ts"),
        reason: "Add Clerk middleware",
        content: () => `import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

export const config = {
  matcher: ["/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|png|gif|svg|woff2?|ico)).*)", "/(api|trpc)(.*)"]
};
`
      }
    ],
    warnings: [
      "Clerk on Workers: secrets are read from process.env, which can be empty on Workers (clerk/javascript#4877). Set keys as Wrangler secrets and verify session detection in preview before production.",
      "Wrap your app in <ClerkProvider> in app/layout.tsx (see the generated doc)."
    ],
    nextActions: ["npm install", "wrangler secret put CLERK_SECRET_KEY", "flarecel verify --json"],
    docPath: "docs/flarecel-auth-clerk.md",
    doc: integrationDoc("Clerk auth", `Package: \`@clerk/nextjs\`.

Add the provider in \`app/layout.tsx\`:

\`\`\`tsx
import { ClerkProvider } from "@clerk/nextjs";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en"><body>{children}</body></html>
    </ClerkProvider>
  );
}
\`\`\`

Env: \`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY\`, \`CLERK_SECRET_KEY\`.

Workers caveat: Clerk auto-reads \`process.env\`, which can be empty on Cloudflare Workers (clerk/javascript#4877). Inject keys via Wrangler secrets and confirm auth works in a preview deploy.`)
  };
}

function supabaseAuthSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "Supabase auth",
    deps: ["@supabase/ssr", "@supabase/supabase-js"],
    envTypes: ["NEXT_PUBLIC_SUPABASE_URL: string;", "NEXT_PUBLIC_SUPABASE_ANON_KEY: string;"],
    envExample: ["NEXT_PUBLIC_SUPABASE_URL=https://replace.supabase.co", "NEXT_PUBLIC_SUPABASE_ANON_KEY=replace"],
    files: [
      {
        path: () => nextLibPath(ctx, "supabase/client.ts"),
        reason: "Add Supabase browser client",
        content: () => `import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
`
      },
      {
        path: () => nextLibPath(ctx, "supabase/server.ts"),
        reason: "Add Supabase server client",
        content: () => `import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        }
      }
    }
  );
}
`
      }
    ],
    warnings: ["Supabase JS is fetch-based and Workers-compatible (Cloudflare-documented). Server client relies on next/headers cookies via OpenNext."],
    docPath: "docs/flarecel-auth-supabase.md",
    doc: integrationDoc("Supabase auth", `Packages: \`@supabase/ssr\`, \`@supabase/supabase-js\`.

Browser client: \`lib/supabase/client.ts\`. Server client: \`lib/supabase/server.ts\`.

Env: \`NEXT_PUBLIC_SUPABASE_URL\`, \`NEXT_PUBLIC_SUPABASE_ANON_KEY\`.

Cloudflare Workers support is fetch-based and documented by Supabase + Cloudflare.`)
  };
}

function authjsSpec(ctx: ProjectContext): IntegrationSpec {
  const routePath = nextRoutePath(ctx, "auth/[...nextauth]");
  return {
    title: "Auth.js (NextAuth v5)",
    deps: ["next-auth"],
    envTypes: ["AUTH_SECRET: string;", "AUTH_TRUST_HOST?: string;"],
    envExample: ["AUTH_SECRET=replace-with-a-32-byte-secret", "AUTH_TRUST_HOST=true"],
    files: [
      {
        path: () => nextRootFile(ctx, "auth.ts"),
        reason: "Add Auth.js v5 config",
        content: () => `import NextAuth from "next-auth";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: []
});
`
      },
      {
        path: () => routePath,
        reason: "Add Auth.js route handler",
        content: () => `export { GET, POST } from "${relativeImport(routePath, nextRootFile(ctx, "auth.ts"))}";
`
      },
      {
        path: () => nextSrcRootPath(ctx, "middleware.ts"),
        reason: "Add Auth.js middleware",
        content: () => `export { auth as middleware } from "${relativeImport(nextSrcRootPath(ctx, "middleware.ts"), nextRootFile(ctx, "auth.ts"))}";
`
      }
    ],
    warnings: [
      "Auth.js v5 (next-auth@beta) is the edge-compatible line; v4 is not. Add providers in auth.ts.",
      "Database sessions need a Workers-compatible adapter (e.g. @auth/d1-adapter). JWT sessions need no database."
    ],
    nextActions: ["npm install", "openssl rand -base64 32", "wrangler secret put AUTH_SECRET", "flarecel verify --json"],
    docPath: "docs/flarecel-auth-authjs.md",
    doc: integrationDoc("Auth.js (NextAuth v5)", `Package: \`next-auth\` (v5 beta, edge-compatible).

Files: \`auth.ts\` (config + exports), \`${routePath}\` (route), \`middleware.ts\`.

Env: \`AUTH_SECRET\` (required), \`AUTH_TRUST_HOST=true\`.

Add providers to the \`providers\` array in \`auth.ts\`. For Cloudflare, use JWT sessions or an edge adapter such as \`@auth/d1-adapter\`.`)
  };
}

function cloudflareAccessSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "Cloudflare Access",
    deps: ["jose"],
    envTypes: ["CF_ACCESS_TEAM_DOMAIN: string;", "CF_ACCESS_AUD: string;"],
    envExample: ["CF_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com", "CF_ACCESS_AUD=replace-with-application-audience-tag"],
    files: [
      {
        path: () => nextLibPath(ctx, "cloudflare-access.ts"),
        reason: "Add Cloudflare Access JWT verification helper",
        content: () => `import { createRemoteJWKSet, jwtVerify } from "jose";

const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN!;
const aud = process.env.CF_ACCESS_AUD!;
const JWKS = createRemoteJWKSet(new URL(\`\${teamDomain}/cdn-cgi/access/certs\`));

export async function verifyAccessRequest(request: Request) {
  const token =
    request.headers.get("cf-access-jwt-assertion") ??
    request.headers.get("cookie")?.match(/CF_Authorization=([^;]+)/)?.[1];
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: teamDomain, audience: aud });
    return payload;
  } catch {
    return null;
  }
}
`
      }
    ],
    warnings: ["Cloudflare Access gates requests at the edge before your Worker; this helper validates the injected JWT. Uses Web Crypto, so no nodejs_compat is required."],
    docPath: "docs/flarecel-auth-cloudflare-access.md",
    doc: integrationDoc("Cloudflare Access", `Package: \`jose\` (only for JWT verification).

Helper: \`lib/cloudflare-access.ts\` verifies the \`Cf-Access-Jwt-Assertion\` header / \`CF_Authorization\` cookie against your team's JWKS.

Env: \`CF_ACCESS_TEAM_DOMAIN\` (https://<team>.cloudflareaccess.com), \`CF_ACCESS_AUD\` (Application Audience tag).

Access is configured in the Cloudflare Zero Trust dashboard; the app only validates the token.`)
  };
}

// ----- DB / backend providers -----

export function d1PrismaSpec(ctx: ProjectContext): IntegrationSpec {
  const databaseName = `${projectName(ctx)}-db`;
  return {
    title: "D1 + Prisma",
    deps: ["@prisma/client", "@prisma/adapter-d1"],
    devDeps: ["prisma"],
    wrangler: (config) => {
      config.compatibility_flags = addUniqueStrings(config.compatibility_flags, ["nodejs_compat"]);
      config.d1_databases = upsertArrayObject(config.d1_databases, "binding", {
        binding: "DB",
        database_name: databaseName,
        database_id: "replace-with-d1-database-id"
      });
    },
    files: [
      {
        path: () => "prisma/schema.prisma",
        reason: "Add Prisma schema with D1 driver adapter",
        content: () => `generator client {
  provider        = "prisma-client-js"
  output          = "../src/generated/prisma"
  previewFeatures = ["driverAdapters"]
}

datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
}
`
      },
      {
        path: () => nextLibPath(ctx, "db.ts"),
        reason: "Add PrismaClient with D1 adapter",
        content: () => `import { PrismaClient } from "../generated/prisma/";
import { PrismaD1 } from "@prisma/adapter-d1";

export function createPrisma(env: { DB: D1Database }) {
  const adapter = new PrismaD1(env.DB);
  return new PrismaClient({ adapter });
}
`
      }
    ],
    envTypes: ["DB: D1Database;"],
    warnings: [
      "Create the database with `wrangler d1 create` and paste database_id into wrangler.jsonc.",
      "Run `npx prisma generate` before building. Requires nodejs_compat."
    ],
    nextActions: [
      `wrangler d1 create ${databaseName}`,
      "Copy the returned database_id into wrangler.jsonc.",
      "npm install",
      "npx prisma generate",
      "flarecel verify --json"
    ],
    docPath: "docs/flarecel-db-d1-prisma.md",
    doc: integrationDoc("D1 + Prisma", "Uses `@prisma/client` + `@prisma/adapter-d1` over a native D1 binding. Schema generator needs `previewFeatures = [\"driverAdapters\"]` and datasource `sqlite`. Verified against Cloudflare's D1+Prisma tutorial.")
  };
}

export async function externalDbAddOn(ctx: ProjectContext, db: string, options: AddOnOptions): Promise<ChangeSet> {
  const mode = String(options.flags.mode ?? "");
  if (db === "supabase") return externalIntegrationAddOn(ctx, supabaseDbSpec(ctx, mode));
  if (db === "neon") return externalIntegrationAddOn(ctx, neonSpec(ctx, mode));
  if (db === "turso") return externalIntegrationAddOn(ctx, tursoSpec(ctx));
  if (db === "planetscale") return externalIntegrationAddOn(ctx, planetscaleSpec(ctx));
  if (db === "mongodb") return externalIntegrationAddOn(ctx, mongodbSpec(ctx));
  return unknownAddOn(`db ${db}`);
}

function pgClientFile(ctx: ProjectContext): IntegrationFile {
  return {
    path: () => nextLibPath(ctx, "db.ts"),
    reason: "Add Hyperdrive Postgres client helper",
    content: () => `import { Client } from "pg";

export function createClient(env: { HYPERDRIVE: { connectionString: string } }) {
  return new Client({ connectionString: env.HYPERDRIVE.connectionString });
}
`
  };
}

function supabaseDbSpec(ctx: ProjectContext, mode: string): IntegrationSpec {
  if (mode === "hyperdrive") {
    return {
      title: "Supabase Postgres (Hyperdrive)",
      deps: ["pg"],
      devDeps: ["@types/pg"],
      wrangler: hyperdriveBinding,
      files: [pgClientFile(ctx)],
      warnings: ["Create the Hyperdrive config with `wrangler hyperdrive create` and paste its id into wrangler.jsonc. Requires nodejs_compat."],
      nextActions: ["npm install", "wrangler hyperdrive create supabase --connection-string=\"postgres://...\"", "flarecel verify --json"],
      docPath: "docs/flarecel-db-supabase-hyperdrive.md",
      doc: integrationDoc("Supabase Postgres via Hyperdrive", "Uses node-postgres (`pg`) through a Cloudflare Hyperdrive binding for pooled TCP access. Connection string is held by Hyperdrive, not an env var.")
    };
  }
  return {
    title: "Supabase Postgres (HTTP)",
    deps: ["@supabase/supabase-js"],
    envTypes: ["SUPABASE_URL: string;", "SUPABASE_KEY: string;"],
    envExample: ["SUPABASE_URL=https://replace.supabase.co", "SUPABASE_KEY=replace"],
    files: [
      {
        path: () => nextLibPath(ctx, "db.ts"),
        reason: "Add Supabase HTTP client helper",
        content: () => `import { createClient } from "@supabase/supabase-js";

export function createDb(env: { SUPABASE_URL: string; SUPABASE_KEY: string }) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
}
`
      }
    ],
    warnings: ["HTTP/PostgREST mode is fetch-based and Workers-safe (Cloudflare-documented)."],
    docPath: "docs/flarecel-db-supabase-http.md",
    doc: integrationDoc("Supabase Postgres via HTTP", "Uses `@supabase/supabase-js` over PostgREST/HTTP. No raw TCP, no binding. Env: `SUPABASE_URL`, `SUPABASE_KEY`.")
  };
}

function neonSpec(ctx: ProjectContext, mode: string): IntegrationSpec {
  if (mode === "hyperdrive") {
    return {
      title: "Neon Postgres (Hyperdrive)",
      deps: ["pg"],
      devDeps: ["@types/pg"],
      wrangler: hyperdriveBinding,
      files: [pgClientFile(ctx)],
      warnings: ["Cloudflare recommends Hyperdrive for Neon. Create it with `wrangler hyperdrive create` and paste the id. Requires nodejs_compat."],
      nextActions: ["npm install", "wrangler hyperdrive create neon --connection-string=\"postgres://...\"", "flarecel verify --json"],
      docPath: "docs/flarecel-db-neon-hyperdrive.md",
      doc: integrationDoc("Neon via Hyperdrive", "Uses node-postgres (`pg`) through a Hyperdrive binding.")
    };
  }
  return {
    title: "Neon (serverless driver)",
    deps: ["@neondatabase/serverless"],
    envTypes: ["DATABASE_URL: string;"],
    envExample: ["DATABASE_URL=postgresql://user:pass@host/db"],
    files: [
      {
        path: () => nextLibPath(ctx, "db.ts"),
        reason: "Add Neon serverless client helper",
        content: () => `import { Client } from "@neondatabase/serverless";

export function createClient(env: { DATABASE_URL: string }) {
  return new Client(env.DATABASE_URL);
}
`
      }
    ],
    warnings: ["The @neondatabase/serverless driver uses HTTP/WebSocket and is Workers-safe (Cloudflare-documented)."],
    docPath: "docs/flarecel-db-neon-serverless.md",
    doc: integrationDoc("Neon serverless driver", "Uses `@neondatabase/serverless` (HTTP + WebSocket). Env: `DATABASE_URL`.")
  };
}

function tursoSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "Turso (libSQL)",
    deps: ["@libsql/client"],
    envTypes: ["TURSO_URL: string;", "TURSO_AUTH_TOKEN: string;"],
    envExample: ["TURSO_URL=libsql://replace.turso.io", "TURSO_AUTH_TOKEN=replace"],
    files: [
      {
        path: () => nextLibPath(ctx, "db.ts"),
        reason: "Add Turso libSQL client helper",
        content: () => `// IMPORTANT: must import from "@libsql/client/web" on Cloudflare Workers.
// the default "@libsql/client" import uses Node TCP and will not work.
import { createClient } from "@libsql/client/web";

export function createDb(env: { TURSO_URL: string; TURSO_AUTH_TOKEN: string }) {
  return createClient({ url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN });
}
`
      }
    ],
    warnings: ["You MUST import from \"@libsql/client/web\" on Workers (Cloudflare-documented); the default import will not work."],
    docPath: "docs/flarecel-db-turso.md",
    doc: integrationDoc("Turso (libSQL)", "Uses `@libsql/client/web` (HTTP). Env: `TURSO_URL`, `TURSO_AUTH_TOKEN`.\n\nCritical: the `/web` import path is required on Cloudflare Workers.")
  };
}

function planetscaleSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "PlanetScale (serverless driver)",
    deps: ["@planetscale/database"],
    envTypes: ["DATABASE_HOST: string;", "DATABASE_USERNAME: string;", "DATABASE_PASSWORD: string;"],
    envExample: ["DATABASE_HOST=replace.psdb.cloud", "DATABASE_USERNAME=replace", "DATABASE_PASSWORD=replace"],
    files: [
      {
        path: () => nextLibPath(ctx, "db.ts"),
        reason: "Add PlanetScale serverless client helper",
        content: () => `import { connect } from "@planetscale/database";

export function createDb(env: { DATABASE_HOST: string; DATABASE_USERNAME: string; DATABASE_PASSWORD: string }) {
  return connect({
    host: env.DATABASE_HOST,
    username: env.DATABASE_USERNAME,
    password: env.DATABASE_PASSWORD,
    // workaround for a Workers cache issue (cloudflare/workerd#698).
    fetch: (url, init) => {
      if (init) delete (init as { cache?: unknown }).cache;
      return fetch(url, init);
    }
  });
}
`
      }
    ],
    warnings: ["The @planetscale/database driver is fetch-based and Workers-safe. The fetch wrapper deleting init.cache is required (cloudflare/workerd#698)."],
    docPath: "docs/flarecel-db-planetscale.md",
    doc: integrationDoc("PlanetScale serverless driver", "Uses `@planetscale/database` (HTTP/Fetch). Env: `DATABASE_HOST`, `DATABASE_USERNAME`, `DATABASE_PASSWORD`.")
  };
}

function mongodbSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "MongoDB (native driver)",
    deps: ["mongodb"],
    envTypes: ["MONGODB_URI: string;"],
    envExample: ["MONGODB_URI=mongodb+srv://user:pass@cluster/db"],
    wrangler: (config) => {
      config.compatibility_flags = addUniqueStrings(config.compatibility_flags, ["nodejs_compat_v2"]);
      const current = typeof config.compatibility_date === "string" ? config.compatibility_date : "";
      if (current < "2025-03-20") config.compatibility_date = "2025-03-20";
    },
    files: [
      {
        path: () => nextLibPath(ctx, "db.ts"),
        reason: "Add MongoDB client helper",
        content: () => `import { MongoClient } from "mongodb";

let client: MongoClient | null = null;

export function getClient(env: { MONGODB_URI: string }) {
  client ??= new MongoClient(env.MONGODB_URI, { maxPoolSize: 1, minPoolSize: 0 });
  return client;
}
`
      }
    ],
    warnings: [
      "The native mongodb driver works on Workers only with nodejs_compat_v2 and a compatibility_date >= 2025-03-20 (set automatically).",
      "Use maxPoolSize:1 for short-lived Worker isolates. Atlas Data API was removed in Sept 2025."
    ],
    docPath: "docs/flarecel-db-mongodb.md",
    doc: integrationDoc("MongoDB native driver", "Uses `mongodb` (native driver), supported on Workers since early 2025 with `nodejs_compat_v2` and compatibility_date >= 2025-03-20. Env: `MONGODB_URI`.")
  };
}

export async function backendAddOn(ctx: ProjectContext, backend: string): Promise<ChangeSet> {
  if (backend === "convex") return externalIntegrationAddOn(ctx, convexSpec(ctx));
  return unknownAddOn(`backend ${backend}`);
}

function convexSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "Convex backend",
    deps: ["convex"],
    envTypes: ["NEXT_PUBLIC_CONVEX_URL: string;"],
    envExample: ["NEXT_PUBLIC_CONVEX_URL=https://replace.convex.cloud"],
    files: [
      {
        path: () => nextLibPath(ctx, "convex.ts"),
        reason: "Add Convex server-side query helper",
        content: () => `import { fetchQuery } from "convex/nextjs";

export { fetchQuery };
// server Components / Route Handlers use fetchQuery (HTTP) and are Workers-safe.
// for client reactivity, create a ConvexReactClient in a Client Component.
`
      }
    ],
    warnings: ["Convex server helpers (fetchQuery) are HTTP-based and Workers-safe. No explicit OpenNext doc exists; verify SSR in a preview deploy."],
    docPath: "docs/flarecel-backend-convex.md",
    doc: integrationDoc("Convex backend", "Uses `convex`. Server-side `fetchQuery` from `convex/nextjs` is HTTP-based and Workers-safe. Env: `NEXT_PUBLIC_CONVEX_URL`.")
  };
}

export async function redisAddOn(ctx: ProjectContext, provider: string): Promise<ChangeSet> {
  if (provider === "upstash") return externalIntegrationAddOn(ctx, upstashSpec(ctx));
  return unknownAddOn(`redis ${provider}`);
}

function upstashSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "Upstash Redis",
    deps: ["@upstash/redis"],
    envTypes: ["UPSTASH_REDIS_REST_URL: string;", "UPSTASH_REDIS_REST_TOKEN: string;"],
    envExample: ["UPSTASH_REDIS_REST_URL=https://replace.upstash.io", "UPSTASH_REDIS_REST_TOKEN=replace"],
    files: [
      {
        path: () => nextLibPath(ctx, "redis.ts"),
        reason: "Add Upstash Redis client helper",
        content: () => `import { Redis } from "@upstash/redis/cloudflare";

export function createRedis(env: { UPSTASH_REDIS_REST_URL: string; UPSTASH_REDIS_REST_TOKEN: string }) {
  return Redis.fromEnv(env);
}
`
      }
    ],
    warnings: ["@upstash/redis uses REST/HTTP (no TCP, no nodejs_compat). Import from \"@upstash/redis/cloudflare\" on Workers."],
    docPath: "docs/flarecel-redis-upstash.md",
    doc: integrationDoc("Upstash Redis", "Uses `@upstash/redis/cloudflare` (REST). Env: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.")
  };
}

// ----- Misc third-party + Cloudflare-native specs -----

export function stripeSpec(ctx: ProjectContext): IntegrationSpec {
  const routePath = nextRoutePath(ctx, "stripe/webhook");
  return {
    title: "Stripe webhooks",
    deps: ["stripe"],
    envTypes: ["STRIPE_SECRET_KEY: string;", "STRIPE_WEBHOOK_SECRET: string;"],
    envExample: ["STRIPE_SECRET_KEY=sk_test_replace", "STRIPE_WEBHOOK_SECRET=whsec_replace"],
    files: [
      {
        path: () => routePath,
        reason: "Add Workers-safe Stripe webhook route (async signature verification)",
        content: () => `import Stripe from "stripe";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// on Cloudflare Workers, signatures MUST be verified with the async API backed
// by Web Crypto. The synchronous constructEvent() does not work on Workers.
export async function POST(request: Request) {
  const { env } = getCloudflareContext();
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient()
  });

  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  const payload = await request.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider()
    );
  } catch (error) {
    return new Response(\`Webhook signature verification failed: \${error instanceof Error ? error.message : "unknown"}\`, { status: 400 });
  }

  // return fast. For heavy work, enqueue to a Cloudflare Queue (flarecel add queue)
  // and process in the consumer so Stripe's delivery does not time out.
  switch (event.type) {
    case "checkout.session.completed":
      // handle fulfilment
      break;
    default:
      break;
  }

  return Response.json({ received: true });
}
`
      }
    ],
    warnings: [
      "Stripe webhook verification on Workers requires the async API (constructEventAsync + Stripe.createSubtleCryptoProvider()); the synchronous constructEvent() will not work.",
      "For heavy webhook processing, run `flarecel add queue` and enqueue events so the webhook returns before Stripe times out.",
      "Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET as Wrangler secrets in production."
    ],
    nextActions: ["npm install", "wrangler secret put STRIPE_SECRET_KEY", "wrangler secret put STRIPE_WEBHOOK_SECRET", "flarecel verify --json"],
    docPath: "docs/flarecel-stripe.md",
    doc: integrationDoc("Stripe webhooks", `Package: \`stripe\`. Route: \`${routePath}\`.

On Cloudflare Workers you must verify signatures with the async API:

\`\`\`ts
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
const event = await stripe.webhooks.constructEventAsync(payload, sig, env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider());
\`\`\`

Env: \`STRIPE_SECRET_KEY\`, \`STRIPE_WEBHOOK_SECRET\`. For durable processing, pair with \`flarecel add queue\` and enqueue events from the webhook.`)
  };
}

export function resendSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "Resend email",
    deps: ["resend"],
    envTypes: ["RESEND_API_KEY: string;"],
    envExample: ["RESEND_API_KEY=re_replace"],
    files: [
      {
        path: () => nextLibPath(ctx, "email.ts"),
        reason: "Add Resend email helper",
        content: () => `import { Resend } from "resend";

export function createResend(env: { RESEND_API_KEY: string }) {
  return new Resend(env.RESEND_API_KEY);
}

export async function sendEmail(
  env: { RESEND_API_KEY: string },
  options: { from: string; to: string | string[]; subject: string; html: string }
) {
  const resend = createResend(env);
  const { data, error } = await resend.emails.send(options);
  if (error) throw new Error(error.message);
  return data;
}
`
      }
    ],
    warnings: ["Resend is a fetch-based REST SDK and works on Workers. Set RESEND_API_KEY as a Wrangler secret; verify your sending domain in Resend."],
    nextActions: ["npm install", "wrangler secret put RESEND_API_KEY", "flarecel verify --json"],
    docPath: "docs/flarecel-resend.md",
    doc: integrationDoc("Resend email", "Uses `resend`. Helper: `lib/email.ts` (`new Resend(env.RESEND_API_KEY)` -> `resend.emails.send(...)`). Env: `RESEND_API_KEY`. Fetch-based REST, Workers-safe.")
  };
}

export function cloudflareImagesSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "Cloudflare Images",
    deps: [],
    wrangler: (config) => {
      config.images = { binding: "IMAGES" };
    },
    files: [
      {
        path: () => nextLibPath(ctx, "image-loader.ts"),
        reason: "Add a custom Next.js image loader for Cloudflare Images",
        content: () => `// Custom loader for next/image on Cloudflare Workers.
// set this as the loader in next.config.ts: images: { loader: "custom", loaderFile: "./lib/image-loader.ts" }
export default function cloudflareImageLoader({ src, width, quality }: { src: string; width: number; quality?: number }) {
  const params = \`width=\${width},quality=\${quality || 75},format=auto\`;
  return \`/cdn-cgi/image/\${params}/\${src}\`;
}
`
      }
    ],
    envTypes: ["IMAGES: ImagesBinding;"],
    warnings: [
      "Add to next.config.ts: images: { loader: 'custom', loaderFile: './lib/image-loader.ts' }",
      "Cloudflare Images must be enabled on your zone (Cloudflare dashboard > Images).",
      "This resolves the 'next-image-on-workers' doctor warning."
    ],
    nextActions: ["Add the loader config to next.config.ts.", "flarecel verify --json"],
    docPath: "docs/flarecel-cloudflare-images.md",
    doc: integrationDoc("Cloudflare Images", "Adds an `IMAGES` binding and a custom Next.js image loader that routes through `/cdn-cgi/image/`. Resolves the next/image on Workers caveat.\n\nRequires: Images enabled on your Cloudflare zone.")
  };
}

export function hyperdriveSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "Hyperdrive (standalone)",
    deps: ["pg"],
    devDeps: ["@types/pg"],
    wrangler: hyperdriveBinding,
    envTypes: ["HYPERDRIVE: Hyperdrive;"],
    files: [
      {
        path: () => nextLibPath(ctx, "hyperdrive.ts"),
        reason: "Add a typed Hyperdrive Postgres client helper",
        content: () => `import { Client } from "pg";

export async function query(env: { HYPERDRIVE: { connectionString: string } }, sql: string, params?: unknown[]) {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}
`
      }
    ],
    warnings: [
      "Create the Hyperdrive config: wrangler hyperdrive create <name> --connection-string=\"postgres://...\"",
      "Paste the returned ID into wrangler.jsonc. Requires nodejs_compat."
    ],
    nextActions: ["wrangler hyperdrive create my-db --connection-string=\"postgres://...\"", "Copy the Hyperdrive ID into wrangler.jsonc.", "flarecel verify --json"],
    docPath: "docs/flarecel-hyperdrive.md",
    doc: integrationDoc("Hyperdrive", "Standalone Hyperdrive add-on. Adds a `HYPERDRIVE` binding and a typed Postgres client helper using `pg`. Create the Hyperdrive config with `wrangler hyperdrive create` and paste the ID.")
  };
}

export function emailRoutingSpec(ctx: ProjectContext): IntegrationSpec {
  return {
    title: "Email Routing (Email Workers)",
    deps: [],
    files: [
      {
        path: () => "src/email-worker.ts",
        reason: "Add an Email Worker receive handler",
        content: () => `// Email Worker: receives inbound emails via Cloudflare Email Routing.
// configure in wrangler.jsonc and set up Email Routing rules in the Cloudflare dashboard.
export default {
  async email(message: EmailMessage, env: CloudflareEnv, ctx: ExecutionContext) {
    // example: forward all emails to an address.
    await message.forward("admin@example.com");

    // or read the raw email:
    // const raw = await new Response(message.raw).text();
    // console.log(\`From: \${message.from}, To: \${message.to}, Size: \${message.rawSize}\`);
  }
} satisfies ExportedHandler<CloudflareEnv>;
`
      }
    ],
    warnings: [
      "Email Workers require Email Routing to be enabled on your domain (Cloudflare dashboard > Email > Email Routing).",
      "Add the email worker as a route rule in your Email Routing settings.",
      "This is a SEPARATE worker entry from your main app — configure it in a dedicated wrangler config or as a service binding."
    ],
    docPath: "docs/flarecel-email-routing.md",
    doc: integrationDoc("Email Routing (Email Workers)", "Generates an Email Worker handler that receives inbound emails via Cloudflare Email Routing. Supports `message.forward()` and raw email access.\n\nRequires: Email Routing enabled on your domain. Configure routing rules in the Cloudflare dashboard.")
  };
}
