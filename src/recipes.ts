import { existsSync } from "node:fs";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyChangeSet } from "./patches.js";
import { detectProject, readFileIfExists, projectName } from "./project.js";
import type { ChangeSet, DoctorReport, PackageJson, PlannedChange, ProjectContext } from "./types.js";

type JsonObject = Record<string, unknown>;

// Pinned dependency versions (npm registry, 2026-06-03). Caret ranges allow
// patch/minor updates while avoiding silent major breakage from "latest".
const DEP_VERSIONS: Record<string, string> = {
  "@opennextjs/cloudflare": "^1.19.11",
  "wrangler": "^4.97.0",
  "@cloudflare/workers-types": "^4.20260603.1",
  "better-auth": "^1.6.14",
  "drizzle-orm": "^0.45.2",
  "drizzle-kit": "^0.31.10",
  "@cloudflare/puppeteer": "^1.1.0",
  // Third-party integrations (verified against Cloudflare docs + npm, 2026-06-04).
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
  "@types/pg": "^8.20.0"
};

const VERIFIED_ON = "2026-06-04";

function depVersion(name: string): string {
  return DEP_VERSIONS[name] ?? "latest";
}

export interface RecipeOptions {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export async function createFixChangeSet(ctx: ProjectContext, report: DoctorReport): Promise<ChangeSet> {
  const changes: PlannedChange[] = [];
  const warnings: string[] = [];

  if (ctx.framework === "nextjs" && shouldPatchOpenNext(report)) {
    const result = await nextOpenNextRecipe(ctx);
    changes.push(...result.changes);
    warnings.push(...result.warnings);
  }

  return withTomlWarning(ctx, {
    status: changes.length > 0 ? "planned" : "empty",
    title: changes.length > 0 ? "Safe Cloudflare readiness fixes" : "No automatic fixes available",
    changes,
    warnings,
    nextActions: changes.length > 0
      ? ["flarecel fix --apply --yes", "flarecel verify --json"]
      : ["flarecel plan --json"]
  });
}

export async function createRecipeChangeSet(
  ctx: ProjectContext,
  recipeName: string,
  options: RecipeOptions
): Promise<ChangeSet> {
  if (ctx.packageJsonRaw !== null && ctx.packageJson === null) {
    return malformedPackageJson(ctx);
  }
  return withFrameworkWarning(ctx, withTomlWarning(ctx, await resolveRecipeChangeSet(ctx, recipeName, options)));
}

interface KitRecipe {
  recipe: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const KITS: Record<string, { title: string; recipes: KitRecipe[] }> = {
  saas: {
    title: "SaaS Kit",
    recipes: [
      { recipe: "next-opennext", positionals: [], flags: {} },
      { recipe: "auth", positionals: ["better-auth"], flags: { db: "d1", orm: "drizzle" } },
      { recipe: "r2", positionals: ["uploads"], flags: {} },
      { recipe: "queue", positionals: ["emails"], flags: {} },
      { recipe: "rate-limit", positionals: [], flags: { route: "/api/*", limit: "60/min" } },
      { recipe: "turnstile", positionals: [], flags: { form: "signup" } },
      { recipe: "observability", positionals: [], flags: { sampling: "1" } }
    ]
  },
  "ai-app": {
    title: "AI App Kit",
    recipes: [
      { recipe: "next-opennext", positionals: [], flags: {} },
      { recipe: "ai-gateway", positionals: [], flags: { provider: "openai" } },
      { recipe: "workers-ai", positionals: [], flags: {} },
      { recipe: "vectorize", positionals: ["docs-search"], flags: { dimensions: "768", metric: "cosine" } },
      { recipe: "r2", positionals: ["uploads"], flags: {} },
      { recipe: "queue", positionals: ["ingestion"], flags: {} },
      { recipe: "rate-limit", positionals: [], flags: { route: "/api/*", limit: "30/min" } },
      { recipe: "observability", positionals: [], flags: { sampling: "1" } }
    ]
  },
  realtime: {
    title: "Realtime Kit",
    recipes: [
      { recipe: "next-opennext", positionals: [], flags: {} },
      { recipe: "durable-object", positionals: ["presence"], flags: {} },
      { recipe: "kv", positionals: ["cache"], flags: {} },
      { recipe: "observability", positionals: [], flags: { sampling: "1" } }
    ]
  },
  creator: {
    title: "Creator App Kit",
    recipes: [
      { recipe: "next-opennext", positionals: [], flags: {} },
      { recipe: "auth", positionals: ["better-auth"], flags: { db: "d1", orm: "drizzle" } },
      { recipe: "r2", positionals: ["uploads"], flags: {} },
      { recipe: "turnstile", positionals: [], flags: { form: "signup" } },
      { recipe: "rate-limit", positionals: [], flags: { route: "/api/*", limit: "30/min" } },
      { recipe: "observability", positionals: [], flags: { sampling: "1" } }
    ]
  },
  "internal-tool": {
    title: "Internal Tool Kit",
    recipes: [
      { recipe: "next-opennext", positionals: [], flags: {} },
      { recipe: "auth", positionals: ["cloudflare-access"], flags: {} },
      { recipe: "db", positionals: ["d1"], flags: { orm: "drizzle" } },
      { recipe: "observability", positionals: [], flags: { sampling: "1" } }
    ]
  }
};

export function listKits(): string[] {
  return Object.keys(KITS);
}

export async function createKitChangeSet(ctx: ProjectContext, kitName: string): Promise<ChangeSet> {
  const kit = KITS[kitName];
  if (!kit) {
    return {
      status: "error",
      title: `Unknown kit: ${kitName}`,
      changes: [],
      warnings: [`Available kits: ${listKits().join(", ")}.`],
      nextActions: ["flarecel doctor --json"]
    };
  }
  if (ctx.framework !== "nextjs") {
    return {
      status: "error",
      title: `${kit.title} requires a Next.js project`,
      changes: [],
      warnings: [`Detected framework: ${ctx.framework}. App kits target Next.js on OpenNext.`],
      nextActions: ["flarecel doctor --json"]
    };
  }

  // Compose by threading state through a temp working copy so recipes that
  // mutate shared files (package.json, wrangler.jsonc, cloudflare-env.d.ts)
  // accumulate instead of clobbering each other. Then diff back to one changeset.
  const work = mkdtempSync(path.join(tmpdir(), "flarecel-kit-"));
  const warnings: string[] = [];
  try {
    copyProject(ctx.cwd, work);

    for (const step of kit.recipes) {
      const workCtx = await detectProject(work);
      const changeSet = await resolveRecipeChangeSet(workCtx, step.recipe, {
        positionals: [...step.positionals],
        flags: { ...step.flags }
      });
      if (changeSet.status === "error") {
        return {
          status: "error",
          title: `${kit.title} failed at recipe: ${step.recipe}`,
          changes: [],
          warnings: changeSet.warnings,
          nextActions: ["flarecel doctor --json"]
        };
      }
      for (const warning of changeSet.warnings) {
        if (!warnings.includes(warning)) warnings.push(warning);
      }
      await applyChangeSet(work, changeSet);
    }

    const changes = await diffProject(ctx.cwd, work);
    return {
      status: changes.length > 0 ? "planned" : "empty",
      title: `Add ${kit.title}`,
      changes,
      warnings: [
        "This kit composes multiple recipes. Review all generated files before applying.",
        "It does not run npm install or create remote Cloudflare resources.",
        ...warnings
      ],
      nextActions: [
        "npm install",
        "npm run cf-typegen",
        "flarecel provision --json",
        "flarecel verify --json"
      ]
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const KIT_IGNORE = /^(?:node_modules|\.git|\.next|\.open-next|dist|\.flarecel)$/;

function copyProject(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !KIT_IGNORE.test(path.basename(src))
  });
}

async function diffProject(projectDir: string, work: string): Promise<PlannedChange[]> {
  const changes: PlannedChange[] = [];

  const collect = async (relativeDir: string): Promise<void> => {
    for (const entry of readdirSync(path.join(work, relativeDir), { withFileTypes: true })) {
      if (KIT_IGNORE.test(entry.name)) continue;
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await collect(rel);
        continue;
      }
      const after = readFileSync(path.join(work, rel), "utf8");
      const original = await readFileIfExists(path.join(projectDir, rel));
      if (original !== after) {
        changes.push({ path: rel, before: original, after, reason: "Kit composed change" });
      }
    }
  };

  await collect("");
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function withFrameworkWarning(ctx: ProjectContext, changeSet: ChangeSet): ChangeSet {
  if (ctx.framework === "nextjs" || ctx.framework === "unknown") return changeSet;
  const emitsNextRoute = changeSet.changes.some((change) => /(?:^|\/)app\/api\/.+\/route\.ts$/.test(change.path));
  if (!emitsNextRoute) return changeSet;

  return {
    ...changeSet,
    warnings: [
      `This recipe generates Next.js App Router code, but the detected framework is ${ctx.framework}. Review the generated route handlers; they may need to be adapted.`,
      ...changeSet.warnings
    ]
  };
}

function malformedPackageJson(ctx: ProjectContext): ChangeSet {
  return {
    status: "error",
    title: "package.json could not be parsed",
    changes: [],
    warnings: [`package.json is not valid JSON: ${ctx.packageJsonParseError}`],
    nextActions: ["Fix package.json, then run flarecel doctor --json."]
  };
}

// ===== External third-party integrations (config-driven) =====

interface IntegrationFile {
  path: (ctx: ProjectContext) => string;
  content: (ctx: ProjectContext) => string;
  reason: string;
}

interface IntegrationSpec {
  title: string;
  deps?: string[];
  devDeps?: string[];
  envTypes?: string[];
  envExample?: string[];
  files?: IntegrationFile[];
  wrangler?: (config: JsonObject, ctx: ProjectContext) => void;
  warnings?: string[];
  nextActions?: string[];
  docPath: string;
  doc: string;
}

async function externalIntegrationRecipe(ctx: ProjectContext, spec: IntegrationSpec): Promise<ChangeSet> {
  const changes: PlannedChange[] = [];

  if (spec.deps?.length || spec.devDeps?.length) {
    changes.push(await packageJsonChange(ctx, `Add ${spec.title} dependencies`, (pkg) => {
      if (spec.deps?.length) {
        pkg.dependencies = pkg.dependencies ?? {};
        for (const dep of spec.deps) pkg.dependencies[dep] = pkg.dependencies[dep] ?? depVersion(dep);
      }
      if (spec.devDeps?.length) {
        pkg.devDependencies = pkg.devDependencies ?? {};
        for (const dep of spec.devDeps) pkg.devDependencies[dep] = pkg.devDependencies[dep] ?? depVersion(dep);
      }
    }));
  }

  if (spec.wrangler) {
    changes.push(await wranglerChange(ctx, `Configure ${spec.title} bindings`, (config) => spec.wrangler!(config, ctx)));
  }

  for (const file of spec.files ?? []) {
    changes.push(await fileChange(ctx, file.path(ctx), file.content(ctx), file.reason));
  }

  if (spec.envTypes?.length) {
    changes.push(await appendEnvTypes(ctx, spec.envTypes, `Add ${spec.title} env/binding types`));
  }

  if (spec.envExample?.length) {
    changes.push(await appendLinesChange(ctx, ".dev.vars.example", spec.envExample, `Document ${spec.title} local env values`));
  }

  changes.push(await fileChange(ctx, spec.docPath, spec.doc, `Explain ${spec.title} recipe`));

  return {
    status: "planned",
    title: `Add ${spec.title}`,
    changes: changes.filter((change) => change.before !== change.after),
    warnings: [
      `EXPERIMENTAL recipe. Verified against provider + Cloudflare docs on ${VERIFIED_ON}; re-check before production.`,
      "Does not run npm install or set remote secrets.",
      ...(spec.warnings ?? [])
    ],
    nextActions: spec.nextActions ?? ["npm install", "flarecel verify --json"]
  };
}

function integrationDoc(title: string, body: string): string {
  return `# Flarecel: ${title}\n\nExperimental recipe. Verified on ${VERIFIED_ON}.\n\n${body}\n`;
}

function hyperdriveBinding(config: JsonObject): void {
  config.compatibility_flags = addUniqueStrings(config.compatibility_flags, ["nodejs_compat"]);
  config.hyperdrive = upsertArrayObject(config.hyperdrive, "binding", {
    binding: "HYPERDRIVE",
    id: "replace-with-hyperdrive-id"
  });
}

// ----- Auth providers -----

async function authRecipe(ctx: ProjectContext, provider: string): Promise<ChangeSet> {
  if (provider === "clerk") return externalIntegrationRecipe(ctx, clerkSpec(ctx));
  if (provider === "supabase") return externalIntegrationRecipe(ctx, supabaseAuthSpec(ctx));
  if (provider === "authjs" || provider === "auth.js" || provider === "next-auth") {
    return externalIntegrationRecipe(ctx, authjsSpec(ctx));
  }
  if (provider === "cloudflare-access" || provider === "access") {
    return externalIntegrationRecipe(ctx, cloudflareAccessSpec(ctx));
  }
  return unknownRecipe(`auth ${provider}`);
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

function d1PrismaSpec(ctx: ProjectContext): IntegrationSpec {
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

async function externalDbRecipe(ctx: ProjectContext, db: string, options: RecipeOptions): Promise<ChangeSet> {
  const mode = String(options.flags.mode ?? "");
  if (db === "supabase") return externalIntegrationRecipe(ctx, supabaseDbSpec(ctx, mode));
  if (db === "neon") return externalIntegrationRecipe(ctx, neonSpec(ctx, mode));
  if (db === "turso") return externalIntegrationRecipe(ctx, tursoSpec(ctx));
  if (db === "planetscale") return externalIntegrationRecipe(ctx, planetscaleSpec(ctx));
  if (db === "mongodb") return externalIntegrationRecipe(ctx, mongodbSpec(ctx));
  return unknownRecipe(`db ${db}`);
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
// The default "@libsql/client" import uses Node TCP and will not work.
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
    // Workaround for a Workers cache issue (cloudflare/workerd#698).
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

async function backendRecipe(ctx: ProjectContext, backend: string): Promise<ChangeSet> {
  if (backend === "convex") return externalIntegrationRecipe(ctx, convexSpec(ctx));
  return unknownRecipe(`backend ${backend}`);
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
// Server Components / Route Handlers use fetchQuery (HTTP) and are Workers-safe.
// For client reactivity, create a ConvexReactClient in a Client Component.
`
      }
    ],
    warnings: ["Convex server helpers (fetchQuery) are HTTP-based and Workers-safe. No explicit OpenNext doc exists; verify SSR in a preview deploy."],
    docPath: "docs/flarecel-backend-convex.md",
    doc: integrationDoc("Convex backend", "Uses `convex`. Server-side `fetchQuery` from `convex/nextjs` is HTTP-based and Workers-safe. Env: `NEXT_PUBLIC_CONVEX_URL`.")
  };
}

async function redisRecipe(ctx: ProjectContext, provider: string): Promise<ChangeSet> {
  if (provider === "upstash") return externalIntegrationRecipe(ctx, upstashSpec(ctx));
  return unknownRecipe(`redis ${provider}`);
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

function withTomlWarning(ctx: ProjectContext, changeSet: ChangeSet): ChangeSet {
  if (ctx.wrangler.format !== "toml") return changeSet;
  if (!changeSet.changes.some((change) => change.path === "wrangler.jsonc")) return changeSet;

  return {
    ...changeSet,
    warnings: [
      `Existing ${path.basename(ctx.wrangler.path ?? "wrangler.toml")} was left untouched; Flarecel generated wrangler.jsonc instead. Having both can cause ambiguous Wrangler config. Migrate to one format before deploy.`,
      ...changeSet.warnings
    ]
  };
}

async function resolveRecipeChangeSet(
  ctx: ProjectContext,
  recipeName: string,
  options: RecipeOptions
): Promise<ChangeSet> {
  if (recipeName === "next-opennext") {
    if (ctx.framework !== "nextjs") {
      return {
        status: "error",
        title: "next-opennext requires a Next.js project",
        changes: [],
        warnings: [`Detected framework: ${ctx.framework}. The OpenNext adapter only applies to Next.js.`],
        nextActions: ["flarecel doctor --json"]
      };
    }
    return nextOpenNextRecipe(ctx);
  }

  if (recipeName === "r2") {
    const kind = options.positionals[0] ?? "uploads";
    if (kind !== "uploads") return unknownRecipe(`r2 ${kind}`);
    return r2UploadsRecipe(ctx);
  }

  if (recipeName === "rate-limit") return rateLimitRecipe(ctx, options);

  if (recipeName === "db") {
    const db = options.positionals[0] ?? "d1";
    const orm = String(options.flags.orm ?? "drizzle");
    if (db === "d1" && orm === "drizzle") return d1DrizzleRecipe(ctx);
    if (db === "d1" && orm === "prisma") return externalIntegrationRecipe(ctx, d1PrismaSpec(ctx));
    if (["supabase", "neon", "turso", "planetscale", "mongodb"].includes(db)) {
      return externalDbRecipe(ctx, db, options);
    }
    return unknownRecipe(`db ${db} --orm ${orm}`);
  }

  if (recipeName === "kv") {
    const kind = options.positionals[0] ?? "cache";
    if (kind !== "cache") return unknownRecipe(`kv ${kind}`);
    return kvCacheRecipe(ctx);
  }

  if (recipeName === "turnstile") return turnstileRecipe(ctx, options);

  if (recipeName === "cron") {
    const cronName = options.positionals[0] ?? "daily-cleanup";
    return cronRecipe(ctx, cronName, options);
  }

  if (recipeName === "workers-ai") return workersAiRecipe(ctx, options);

  if (recipeName === "vectorize") {
    const indexName = options.positionals[0] ?? "docs-search";
    return vectorizeRecipe(ctx, indexName, options);
  }

  if (recipeName === "ai-gateway") return aiGatewayRecipe(ctx, options);

  if (recipeName === "observability" || recipeName === "monitor") {
    return observabilityRecipe(ctx, options);
  }

  if (recipeName === "durable-object" || recipeName === "do") {
    const objectName = options.positionals[0] ?? "room";
    return durableObjectRecipe(ctx, objectName);
  }

  if (recipeName === "workflow" || recipeName === "workflows") {
    const workflowName = options.positionals[0] ?? "onboarding";
    return workflowRecipe(ctx, workflowName, options);
  }

  if (recipeName === "browser-run" || recipeName === "browser-rendering") {
    return browserRunRecipe(ctx);
  }

  if (recipeName === "queue") {
    const queueName = options.positionals[0] ?? "jobs";
    return queueRecipe(ctx, queueName);
  }

  if (recipeName === "auth") {
    const provider = options.positionals[0] ?? "";
    if (provider === "better-auth") return betterAuthRecipe(ctx, options);
    return authRecipe(ctx, provider);
  }

  if (recipeName === "backend") {
    return backendRecipe(ctx, options.positionals[0] ?? "");
  }

  if (recipeName === "redis") {
    return redisRecipe(ctx, options.positionals[0] ?? "upstash");
  }

  return unknownRecipe(recipeName);
}

async function nextOpenNextRecipe(ctx: ProjectContext): Promise<ChangeSet> {
  if (!ctx.packageJson) {
    return {
      status: "error",
      title: "Cannot patch project without package.json",
      changes: [],
      warnings: [],
      nextActions: ["Create a package.json first."]
    };
  }

  const changes: PlannedChange[] = [];
  changes.push(await packageJsonChange(ctx, "Add OpenNext Cloudflare dependencies and scripts", (pkg) => {
    pkg.dependencies = pkg.dependencies ?? {};
    pkg.devDependencies = pkg.devDependencies ?? {};
    pkg.scripts = pkg.scripts ?? {};

    pkg.dependencies["@opennextjs/cloudflare"] = pkg.dependencies["@opennextjs/cloudflare"] ?? depVersion("@opennextjs/cloudflare");
    pkg.devDependencies.wrangler = pkg.devDependencies.wrangler ?? depVersion("wrangler");
    pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");

    pkg.scripts.build = pkg.scripts.build ?? "next build";
    pkg.scripts.preview = "opennextjs-cloudflare build && opennextjs-cloudflare preview";
    pkg.scripts.deploy = "opennextjs-cloudflare build && opennextjs-cloudflare deploy";
    pkg.scripts.upload = "opennextjs-cloudflare build && opennextjs-cloudflare upload";
    pkg.scripts["cf-typegen"] = "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts";
  }));

  changes.push(await wranglerChange(ctx, "Configure OpenNext Worker entry, assets, and compatibility flags", (config) => {
    config.$schema = config.$schema ?? "node_modules/wrangler/config-schema.json";
    config.name = config.name ?? projectName(ctx);
    config.main = ".open-next/worker.js";
    config.compatibility_date = config.compatibility_date ?? today();
    config.compatibility_flags = addUniqueStrings(config.compatibility_flags, [
      "nodejs_compat",
      "global_fetch_strictly_public"
    ]);
    config.assets = {
      directory: ".open-next/assets",
      binding: "ASSETS"
    };
    config.services = upsertArrayObject(config.services, "binding", {
      binding: "WORKER_SELF_REFERENCE",
      service: String(config.name)
    });
  }));

  changes.push(await fileChange(ctx, "open-next.config.ts", openNextConfig(), "Add explicit OpenNext Cloudflare config"));
  changes.push(await appendLineChange(ctx, ".dev.vars", "NEXTJS_ENV=development", "Set local Next.js env for OpenNext dev bindings"));
  changes.push(await appendLineChange(ctx, ".gitignore", ".open-next", "Ignore OpenNext build output"));
  changes.push(await ensureHeadersChange(ctx));

  return {
    status: "planned",
    title: "Add OpenNext Cloudflare support",
    changes: changes.filter((change) => change.before !== change.after),
    warnings: [
      "This does not run npm install. Install dependencies after applying patches.",
      "If your app exports runtime = \"edge\", remove it manually before deploy."
    ],
    nextActions: [
      "npm install",
      "npm run cf-typegen",
      "flarecel verify --json",
      "npm run preview"
    ]
  };
}

async function r2UploadsRecipe(ctx: ProjectContext): Promise<ChangeSet> {
  const binding = "UPLOADS";
  const bucket = `${projectName(ctx)}-uploads`;
  const routePath = nextRoutePath(ctx, "uploads");

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Workers types for R2", (pkg) => {
      if (ctx.framework === "nextjs") {
        pkg.dependencies = pkg.dependencies ?? {};
        pkg.dependencies["@opennextjs/cloudflare"] = pkg.dependencies["@opennextjs/cloudflare"] ?? depVersion("@opennextjs/cloudflare");
      }
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
    }),
    await wranglerChange(ctx, "Bind an R2 bucket for uploads", (config) => {
      config.r2_buckets = upsertArrayObject(config.r2_buckets, "binding", {
        binding,
        bucket_name: bucket
      });
    }),
    await fileChange(ctx, routePath, r2UploadRoute(binding), "Add Next.js route handler for R2 uploads"),
    await appendEnvType(ctx, `${binding}: R2Bucket;`, "Add R2 binding type"),
    await fileChange(ctx, "docs/flarecel-r2-uploads.md", r2UploadsDoc(binding, bucket, routePath), "Explain R2 uploads recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: "Add R2 uploads",
    changes,
    warnings: [
      "Flarecel updates config and code, but it does not create the remote bucket yet.",
      "Create the bucket with Wrangler before production deploy."
    ],
    nextActions: [
      `wrangler r2 bucket create ${bucket}`,
      "npm run cf-typegen",
      "flarecel verify --json"
    ]
  };
}

async function rateLimitRecipe(ctx: ProjectContext, options: RecipeOptions): Promise<ChangeSet> {
  const parsedLimit = parseLimit(String(options.flags.limit ?? "20/min"));
  const route = String(options.flags.route ?? "/api/*");
  const binding = "RATE_LIMITER";

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Workers types for Rate Limiting", (pkg) => {
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
    }),
    await wranglerChange(ctx, "Add Cloudflare Rate Limiting binding", (config) => {
      config.ratelimits = upsertArrayObject(config.ratelimits, "name", {
        name: binding,
        namespace_id: "1001",
        simple: {
          limit: parsedLimit.limit,
          period: parsedLimit.period
        }
      });
    }),
    await fileChange(ctx, "src/cloudflare/rate-limit.ts", rateLimitHelper(binding), "Add reusable rate limit helper"),
    await appendEnvType(ctx, `${binding}: RateLimit;`, "Add Rate Limiting binding type"),
    await fileChange(ctx, "docs/flarecel-rate-limit.md", rateLimitDoc(binding, route, parsedLimit), "Explain Rate Limiting recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: "Add Cloudflare Rate Limiting",
    changes,
    warnings: [
      "Cloudflare Rate Limiting counters are local to each Cloudflare location and are not exact billing meters.",
      "The namespace_id should be changed if this limiter must not share counters with another Worker."
    ],
    nextActions: [
      "Wire enforceRateLimit into the selected route.",
      "flarecel verify --json"
    ]
  };
}

async function d1DrizzleRecipe(ctx: ProjectContext): Promise<ChangeSet> {
  const databaseName = `${projectName(ctx)}-db`;
  const binding = "DB";
  const schemaFile = nextDbPath(ctx, "schema.ts");
  const dbFile = nextLibPath(ctx, "db.ts");

  const changes = [
    await packageJsonChange(ctx, "Add D1, Drizzle, and migration scripts", (pkg) => {
      pkg.dependencies = pkg.dependencies ?? {};
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.scripts = pkg.scripts ?? {};

      pkg.dependencies["drizzle-orm"] = pkg.dependencies["drizzle-orm"] ?? depVersion("drizzle-orm");
      pkg.devDependencies.wrangler = pkg.devDependencies.wrangler ?? depVersion("wrangler");
      pkg.devDependencies["drizzle-kit"] = pkg.devDependencies["drizzle-kit"] ?? depVersion("drizzle-kit");
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");

      pkg.scripts["cf-typegen"] = "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts";
      pkg.scripts["db:generate"] = "drizzle-kit generate";
      pkg.scripts["db:migrate:local"] = `wrangler d1 migrations apply ${databaseName} --local`;
      pkg.scripts["db:migrate:remote"] = `wrangler d1 migrations apply ${databaseName} --remote`;
    }),
    await wranglerChange(ctx, "Bind a D1 database", (config) => {
      config.d1_databases = upsertArrayObject(config.d1_databases, "binding", {
        binding,
        database_name: databaseName,
        database_id: "replace-with-d1-database-id",
        migrations_dir: "drizzle"
      });
    }),
    await fileChange(ctx, schemaFile, d1DrizzleSchema(), "Add starter Drizzle schema for D1"),
    await fileChange(ctx, dbFile, d1DrizzleHelper(dbFile, schemaFile), "Add typed D1/Drizzle helper"),
    await fileChange(ctx, "drizzle.config.ts", drizzleConfig(schemaFile), "Add Drizzle migration config"),
    await appendEnvType(ctx, `${binding}: D1Database;`, "Add D1 binding type"),
    await fileChange(ctx, "docs/flarecel-d1-drizzle.md", d1DrizzleDoc(databaseName, binding, schemaFile), "Explain D1 + Drizzle recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: "Add D1 with Drizzle",
    changes,
    warnings: [
      "Flarecel updates config and code, but it does not create the remote D1 database yet.",
      "Copy the database_id returned by Wrangler into wrangler.jsonc before production deploy."
    ],
    nextActions: [
      `wrangler d1 create ${databaseName}`,
      "Copy the returned database_id into wrangler.jsonc.",
      "npm install",
      "npm run db:generate",
      "npm run db:migrate:local",
      "npm run db:migrate:remote",
      "npm run cf-typegen",
      "flarecel verify --json"
    ]
  };
}

async function kvCacheRecipe(ctx: ProjectContext): Promise<ChangeSet> {
  const binding = "CACHE";
  const namespaceName = `${projectName(ctx)}-cache`;

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Workers types for KV", (pkg) => {
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies.wrangler = pkg.devDependencies.wrangler ?? depVersion("wrangler");
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
      pkg.scripts = pkg.scripts ?? {};
      pkg.scripts["cf-typegen"] = "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts";
    }),
    await wranglerChange(ctx, "Bind a KV namespace for cache data", (config) => {
      config.kv_namespaces = upsertArrayObject(config.kv_namespaces, "binding", {
        binding,
        id: "replace-with-kv-namespace-id"
      });
    }),
    await fileChange(ctx, "src/cloudflare/kv-cache.ts", kvCacheHelper(binding), "Add typed KV cache helper"),
    await appendEnvType(ctx, `${binding}: KVNamespace;`, "Add KV binding type"),
    await fileChange(ctx, "docs/flarecel-kv-cache.md", kvCacheDoc(binding, namespaceName), "Explain KV cache recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: "Add KV cache",
    changes,
    warnings: [
      "KV is eventually consistent. Do not use it for strict counters, transactions, or billing-critical state.",
      "Flarecel updates config and code, but it does not create the remote KV namespace yet."
    ],
    nextActions: [
      `wrangler kv namespace create ${binding}`,
      "Copy the returned id into wrangler.jsonc.",
      "npm run cf-typegen",
      "flarecel verify --json"
    ]
  };
}

async function turnstileRecipe(ctx: ProjectContext, options: RecipeOptions): Promise<ChangeSet> {
  const formName = sanitizeFeatureName(String(options.flags.form ?? options.positionals[0] ?? "signup"));
  const routePath = nextRoutePath(ctx, `turnstile/${formName}/verify`);

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Workers types for Turnstile env values", (pkg) => {
      if (ctx.framework === "nextjs") {
        pkg.dependencies = pkg.dependencies ?? {};
        pkg.dependencies["@opennextjs/cloudflare"] = pkg.dependencies["@opennextjs/cloudflare"] ?? depVersion("@opennextjs/cloudflare");
      }
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
      pkg.scripts = pkg.scripts ?? {};
      pkg.scripts["cf-typegen"] = "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts";
    }),
    await fileChange(ctx, "src/cloudflare/turnstile.ts", turnstileHelper(), "Add Turnstile Siteverify helper"),
    await fileChange(ctx, routePath, turnstileRoute(routePath), "Add Next.js Turnstile verification route"),
    await appendLinesChange(ctx, ".dev.vars.example", [
      "TURNSTILE_SECRET_KEY=replace-with-turnstile-secret-key",
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY=replace-with-turnstile-site-key"
    ], "Document Turnstile environment values"),
    await appendEnvTypes(ctx, [
      "TURNSTILE_SECRET_KEY: string;",
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;"
    ], "Add Turnstile env types"),
    await fileChange(ctx, "docs/flarecel-turnstile.md", turnstileDoc(formName, routePath), "Explain Turnstile recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: `Add Turnstile protection for ${formName}`,
    changes,
    warnings: [
      "The client-side widget alone is not enough. Your server must validate every Turnstile token.",
      "Do not commit the real TURNSTILE_SECRET_KEY. Store it as a Wrangler secret in production."
    ],
    nextActions: [
      "wrangler secret put TURNSTILE_SECRET_KEY",
      "Add NEXT_PUBLIC_TURNSTILE_SITE_KEY to your frontend environment.",
      "Wire the generated verification route into the protected form submit flow.",
      "flarecel verify --json"
    ]
  };
}

async function cronRecipe(ctx: ProjectContext, cronNameInput: string, options: RecipeOptions): Promise<ChangeSet> {
  const cronName = sanitizeFeatureName(cronNameInput);
  const schedule = String(options.flags.schedule ?? "0 0 * * *");

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Workers types for Cron Triggers", (pkg) => {
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
    }),
    await wranglerChange(ctx, "Add Cloudflare Cron Trigger", (config) => {
      const triggers = asObject(config.triggers);
      triggers.crons = addUniqueStrings(triggers.crons, [schedule]);
      config.triggers = triggers;
    }),
    await fileChange(ctx, `src/cloudflare/cron/${cronName}.ts`, cronHelper(cronName), "Add scheduled job helper"),
    await fileChange(ctx, `docs/flarecel-cron-${cronName}.md`, cronDoc(cronName, schedule), "Explain Cron Trigger recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: `Add Cron Trigger: ${cronName}`,
    changes,
    warnings: [
      "This MVP adds the cron trigger and job helper. Next.js/OpenNext apps may need a custom Worker entry to call the helper from a scheduled handler."
    ],
    nextActions: [
      "Wire the generated helper into your Worker's scheduled handler.",
      "flarecel verify --json"
    ]
  };
}

async function workersAiRecipe(ctx: ProjectContext, options: RecipeOptions): Promise<ChangeSet> {
  const model = String(options.flags.model ?? "@cf/meta/llama-3.1-8b-instruct");
  const routePath = nextRoutePath(ctx, "ai/generate");

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Workers AI binding support", (pkg) => {
      if (ctx.framework === "nextjs") {
        pkg.dependencies = pkg.dependencies ?? {};
        pkg.dependencies["@opennextjs/cloudflare"] = pkg.dependencies["@opennextjs/cloudflare"] ?? depVersion("@opennextjs/cloudflare");
      }
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies.wrangler = pkg.devDependencies.wrangler ?? depVersion("wrangler");
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
      pkg.scripts = pkg.scripts ?? {};
      pkg.scripts["cf-typegen"] = "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts";
    }),
    await wranglerChange(ctx, "Bind Workers AI", (config) => {
      config.ai = {
        binding: "AI"
      };
    }),
    await fileChange(ctx, "src/cloudflare/workers-ai.ts", workersAiHelper(model), "Add Workers AI helper"),
    await fileChange(ctx, routePath, workersAiRoute(routePath), "Add Next.js Workers AI route"),
    await appendEnvType(ctx, "AI: Ai;", "Add Workers AI binding type"),
    await fileChange(ctx, "docs/flarecel-workers-ai.md", workersAiDoc(model, routePath), "Explain Workers AI recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: "Add Workers AI",
    changes,
    warnings: [
      "Workers AI has per-model usage pricing and daily free allocations. Run flarecel cost with --workers-ai-neurons before production."
    ],
    nextActions: [
      "npm run cf-typegen",
      "Wire the generated route into your AI UI.",
      "flarecel cost --workers-ai-neurons 300000 --json",
      "flarecel verify --json"
    ]
  };
}

async function vectorizeRecipe(ctx: ProjectContext, indexNameInput: string, options: RecipeOptions): Promise<ChangeSet> {
  const indexName = `${projectName(ctx)}-${sanitizeFeatureName(indexNameInput)}`;
  const binding = "VECTORIZE";
  const dimensions = numericOption(options.flags.dimensions, 768);
  const metric = parseVectorMetric(String(options.flags.metric ?? "cosine"));

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Vectorize binding support", (pkg) => {
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies.wrangler = pkg.devDependencies.wrangler ?? depVersion("wrangler");
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
      pkg.scripts = pkg.scripts ?? {};
      pkg.scripts["cf-typegen"] = "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts";
    }),
    await wranglerChange(ctx, "Bind a Vectorize index", (config) => {
      config.vectorize = upsertArrayObject(config.vectorize, "binding", {
        binding,
        index_name: indexName
      });
    }),
    await fileChange(ctx, "src/cloudflare/vectorize.ts", vectorizeHelper(binding), "Add Vectorize helper"),
    await appendEnvType(ctx, `${binding}: VectorizeIndex;`, "Add Vectorize binding type"),
    await fileChange(ctx, ".flarecel/resources.json", vectorizeResourceMetadata(indexName, dimensions, metric), "Track Vectorize provisioning metadata"),
    await fileChange(ctx, "docs/flarecel-vectorize.md", vectorizeDoc(indexName, binding, dimensions, metric), "Explain Vectorize recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: `Add Vectorize index: ${indexNameInput}`,
    changes,
    warnings: [
      "Vectorize index dimensions and metric cannot be changed after creation. Choose them carefully.",
      "Flarecel updates config and code, but it does not create the remote Vectorize index yet."
    ],
    nextActions: [
      `wrangler vectorize create ${indexName} --dimensions=${dimensions} --metric=${metric}`,
      "npm run cf-typegen",
      "flarecel cost --vectorize-queries 30000 --vectorize-stored-vectors 10000 --vectorize-dimensions 768 --json",
      "flarecel verify --json"
    ]
  };
}

async function aiGatewayRecipe(ctx: ProjectContext, options: RecipeOptions): Promise<ChangeSet> {
  const provider = String(options.flags.provider ?? options.positionals[0] ?? "openai");

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Workers types for AI Gateway env values", (pkg) => {
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
    }),
    await fileChange(ctx, "src/cloudflare/ai-gateway.ts", aiGatewayHelper(provider), "Add AI Gateway fetch helper"),
    await appendLinesChange(ctx, ".dev.vars.example", [
      "CLOUDFLARE_ACCOUNT_ID=replace-with-account-id",
      "AI_GATEWAY_ID=replace-with-gateway-id",
      "OPENAI_API_KEY=replace-with-openai-api-key"
    ], "Document AI Gateway environment values"),
    await appendEnvTypes(ctx, [
      "CLOUDFLARE_ACCOUNT_ID: string;",
      "AI_GATEWAY_ID: string;",
      "OPENAI_API_KEY?: string;",
      "CF_AIG_TOKEN?: string;"
    ], "Add AI Gateway env types"),
    await fileChange(ctx, "docs/flarecel-ai-gateway.md", aiGatewayDoc(provider), "Explain AI Gateway recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: "Add AI Gateway helper",
    changes,
    warnings: [
      "AI Gateway routes provider calls and improves observability, but provider usage can still bill through the provider or Cloudflare unified billing.",
      "Do not commit provider API keys. Store production keys as Wrangler secrets."
    ],
    nextActions: [
      "Create an AI Gateway in the Cloudflare dashboard.",
      "wrangler secret put OPENAI_API_KEY",
      "Optionally set CF_AIG_TOKEN for authenticated gateways.",
      "flarecel verify --json"
    ]
  };
}

async function observabilityRecipe(ctx: ProjectContext, options: RecipeOptions): Promise<ChangeSet> {
  const sampling = parseSampling(String(options.flags.sampling ?? options.flags["head-sampling-rate"] ?? "1"));

  const changes = [
    await packageJsonChange(ctx, "Add Wrangler for Workers observability commands", (pkg) => {
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies.wrangler = pkg.devDependencies.wrangler ?? depVersion("wrangler");
      pkg.scripts = pkg.scripts ?? {};
      pkg.scripts["logs:tail"] = "wrangler tail";
    }),
    await wranglerChange(ctx, "Enable Workers Logs observability", (config) => {
      config.observability = {
        enabled: true,
        head_sampling_rate: sampling
      };
    }),
    await fileChange(ctx, "src/cloudflare/observability.ts", observabilityHelper(), "Add request ID and structured logging helpers"),
    await fileChange(ctx, "docs/flarecel-observability.md", observabilityDoc(sampling), "Explain observability recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: "Add Workers observability",
    changes,
    warnings: [
      "A sampling rate of 1 logs every request. Lower it for high-traffic production apps if log volume is noisy or costly."
    ],
    nextActions: [
      "npm run logs:tail",
      "Use Cloudflare Workers Logs and Query Builder after deploy.",
      "flarecel verify --json"
    ]
  };
}

async function durableObjectRecipe(ctx: ProjectContext, objectNameInput: string): Promise<ChangeSet> {
  const objectName = sanitizeFeatureName(objectNameInput);
  const binding = `${objectName.toUpperCase().replace(/-/g, "_")}_DO`;
  const className = `${pascalCase(objectName)}DurableObject`;
  const sourcePath = `src/cloudflare/durable-objects/${objectName}.ts`;
  const routePath = nextRoutePath(ctx, `durable-objects/${objectName}`);

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Workers types for Durable Objects", (pkg) => {
      if (ctx.framework === "nextjs") {
        pkg.dependencies = pkg.dependencies ?? {};
        pkg.dependencies["@opennextjs/cloudflare"] = pkg.dependencies["@opennextjs/cloudflare"] ?? depVersion("@opennextjs/cloudflare");
        pkg.scripts = pkg.scripts ?? {};
        pkg.scripts.build = pkg.scripts.build ?? "next build";
        pkg.scripts.preview = "opennextjs-cloudflare build && opennextjs-cloudflare preview";
        pkg.scripts.deploy = "opennextjs-cloudflare build && opennextjs-cloudflare deploy";
        pkg.scripts.upload = "opennextjs-cloudflare build && opennextjs-cloudflare upload";
      }
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies.wrangler = pkg.devDependencies.wrangler ?? depVersion("wrangler");
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
      pkg.scripts = pkg.scripts ?? {};
      pkg.scripts["cf-typegen"] = "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts";
    }),
    await wranglerChange(ctx, "Bind a SQLite-backed Durable Object", (config) => {
      configureOpenNextMainIfNeeded(ctx, config);
      const durableObjects = asObject(config.durable_objects);
      durableObjects.bindings = upsertArrayObject(durableObjects.bindings, "name", {
        name: binding,
        class_name: className
      });
      config.durable_objects = durableObjects;
      config.migrations = upsertDurableObjectMigration(config.migrations, `v1-${objectName}`, className);
    }),
    await fileChange(ctx, sourcePath, durableObjectClass(className), "Add Durable Object class"),
    await appendEnvType(ctx, `${binding}: DurableObjectNamespace;`, "Add Durable Object binding type"),
    await fileChange(ctx, "docs/flarecel-durable-object.md", durableObjectDoc(objectName, binding, className, routePath), "Explain Durable Object recipe")
  ];

  if (ctx.framework === "nextjs") {
    changes.push(
      await customOpenNextWorkerChange(ctx, [
        { exportName: className, sourcePath }
      ], "Export Durable Object class from a custom OpenNext worker"),
      await fileChange(ctx, routePath, durableObjectRoute(routePath, binding), "Add Next.js route handler for Durable Object RPC")
    );
  }

  return {
    status: "planned",
    title: `Add Durable Object: ${objectName}`,
    changes: changes.filter((change) => change.before !== change.after),
    warnings: [
      "Durable Object namespaces are created by Wrangler deploy through migrations; do not remove migration tags after deploying.",
      "For OpenNext, Flarecel switches Wrangler main to cloudflare-worker.ts so the Durable Object class is exported with the generated Next fetch handler."
    ],
    nextActions: [
      "npm install",
      "npm run cf-typegen",
      "flarecel verify --json",
      "npm run preview"
    ]
  };
}

async function workflowRecipe(ctx: ProjectContext, workflowNameInput: string, options: RecipeOptions): Promise<ChangeSet> {
  const workflowSlug = sanitizeFeatureName(workflowNameInput);
  const workflowName = `${projectName(ctx)}-${workflowSlug}`;
  const binding = `${workflowSlug.toUpperCase().replace(/-/g, "_")}_WORKFLOW`;
  const className = `${pascalCase(workflowSlug)}Workflow`;
  const sourcePath = `src/cloudflare/workflows/${workflowSlug}.ts`;
  const routePath = nextRoutePath(ctx, `workflows/${workflowSlug}`);
  const schedule = typeof options.flags.schedule === "string" ? options.flags.schedule : null;

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Workflows support", (pkg) => {
      if (ctx.framework === "nextjs") {
        pkg.dependencies = pkg.dependencies ?? {};
        pkg.dependencies["@opennextjs/cloudflare"] = pkg.dependencies["@opennextjs/cloudflare"] ?? depVersion("@opennextjs/cloudflare");
        pkg.scripts = pkg.scripts ?? {};
        pkg.scripts.build = pkg.scripts.build ?? "next build";
        pkg.scripts.preview = "opennextjs-cloudflare build && opennextjs-cloudflare preview";
        pkg.scripts.deploy = "opennextjs-cloudflare build && opennextjs-cloudflare deploy";
        pkg.scripts.upload = "opennextjs-cloudflare build && opennextjs-cloudflare upload";
      }
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies.wrangler = pkg.devDependencies.wrangler ?? depVersion("wrangler");
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
      pkg.scripts = pkg.scripts ?? {};
      pkg.scripts["cf-typegen"] = "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts";
      pkg.scripts["workflows:list"] = `wrangler workflows instances list ${workflowName}`;
    }),
    await wranglerChange(ctx, "Bind a Cloudflare Workflow", (config) => {
      configureOpenNextMainIfNeeded(ctx, config);
      const workflowConfig: JsonObject = {
        name: workflowName,
        binding,
        class_name: className
      };
      if (schedule) workflowConfig.schedules = [schedule];
      config.workflows = upsertArrayObject(config.workflows, "binding", workflowConfig);
      config.observability = {
        ...asObject(config.observability),
        enabled: true
      };
    }),
    await fileChange(ctx, sourcePath, workflowClass(className), "Add Workflow class"),
    await appendEnvType(ctx, `${binding}: Workflow;`, "Add Workflow binding type"),
    await fileChange(ctx, "docs/flarecel-workflow.md", workflowDoc(workflowName, workflowSlug, binding, className, routePath, schedule), "Explain Workflow recipe")
  ];

  if (ctx.framework === "nextjs") {
    changes.push(
      await customOpenNextWorkerChange(ctx, [
        { exportName: className, sourcePath }
      ], "Export Workflow class from a custom OpenNext worker"),
      await fileChange(ctx, routePath, workflowRoute(routePath, binding), "Add Next.js route handler for Workflow instances")
    );
  }

  return {
    status: "planned",
    title: `Add Cloudflare Workflow: ${workflowSlug}`,
    changes: changes.filter((change) => change.before !== change.after),
    warnings: [
      "Workflow state retention and storage can become billable. Estimate usage before production.",
      "For OpenNext, Flarecel switches Wrangler main to cloudflare-worker.ts so the Workflow class is exported with the generated Next fetch handler."
    ],
    nextActions: [
      "npm install",
      "npm run cf-typegen",
      "flarecel verify --json",
      "npm run preview"
    ]
  };
}

async function browserRunRecipe(ctx: ProjectContext): Promise<ChangeSet> {
  const binding = "BROWSER";
  const routePath = nextRoutePath(ctx, "browser/screenshot");

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Browser Run support", (pkg) => {
      pkg.dependencies = pkg.dependencies ?? {};
      if (ctx.framework === "nextjs") {
        pkg.dependencies["@opennextjs/cloudflare"] = pkg.dependencies["@opennextjs/cloudflare"] ?? depVersion("@opennextjs/cloudflare");
      }
      pkg.dependencies["@cloudflare/puppeteer"] = pkg.dependencies["@cloudflare/puppeteer"] ?? depVersion("@cloudflare/puppeteer");
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies.wrangler = pkg.devDependencies.wrangler ?? depVersion("wrangler");
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
      pkg.scripts = pkg.scripts ?? {};
      pkg.scripts["cf-typegen"] = "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts";
    }),
    await wranglerChange(ctx, "Bind Cloudflare Browser Run", (config) => {
      config.browser = { binding };
      config.compatibility_flags = addUniqueStrings(config.compatibility_flags, ["nodejs_compat"]);
    }),
    await fileChange(ctx, "src/cloudflare/browser-run.ts", browserRunHelper(binding), "Add Browser Run screenshot helper"),
    await appendEnvType(ctx, `${binding}: Fetcher;`, "Add Browser Run binding type"),
    await fileChange(ctx, "docs/flarecel-browser-run.md", browserRunDoc(binding, routePath), "Explain Browser Run recipe")
  ];

  if (ctx.framework === "nextjs") {
    changes.push(await fileChange(ctx, routePath, browserRunRoute(routePath), "Add Next.js route handler for Browser Run screenshots"));
  }

  return {
    status: "planned",
    title: "Add Cloudflare Browser Run",
    changes: changes.filter((change) => change.before !== change.after),
    warnings: [
      "Browser Run is billable by browser time and, for sessions, averaged concurrency. Put auth/rate limiting in front of public routes.",
      "Use this for screenshots, PDFs, rendered crawling, and agent browser tasks instead of bundling normal Puppeteer."
    ],
    nextActions: [
      "npm install",
      "npm run cf-typegen",
      "flarecel cost --browser-run-hours 10 --json",
      "flarecel verify --json"
    ]
  };
}

async function queueRecipe(ctx: ProjectContext, queueNameInput: string): Promise<ChangeSet> {
  const queueName = `${projectName(ctx)}-${sanitizeQueueName(queueNameInput)}`;
  const binding = `${sanitizeQueueName(queueNameInput).toUpperCase().replace(/-/g, "_")}_QUEUE`;

  const changes = [
    await packageJsonChange(ctx, "Add Cloudflare Workers types for Queues", (pkg) => {
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
    }),
    await wranglerChange(ctx, "Add Cloudflare Queue producer config", (config) => {
      const queues = asObject(config.queues);
      queues.producers = upsertArrayObject(queues.producers, "binding", {
        queue: queueName,
        binding
      });
      config.queues = queues;
    }),
    await fileChange(ctx, `src/cloudflare/queues/${sanitizeQueueName(queueNameInput)}.ts`, queueHelper(binding), "Add Queue producer helper"),
    await appendEnvType(ctx, `${binding}: Queue;`, "Add Queue binding type"),
    await fileChange(ctx, `docs/flarecel-queue-${sanitizeQueueName(queueNameInput)}.md`, queueDoc(binding, queueName), "Explain Queue recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: `Add Cloudflare Queue: ${queueNameInput}`,
    changes,
    warnings: [
      "Flarecel updates config and code, but it does not create the remote queue yet.",
      "This MVP adds a Queue producer binding only. Queue consumers for OpenNext apps need a custom Worker or separate consumer Worker."
    ],
    nextActions: [
      `wrangler queues create ${queueName}`,
      "flarecel verify --json"
    ]
  };
}

async function betterAuthRecipe(ctx: ProjectContext, options: RecipeOptions): Promise<ChangeSet> {
  const db = String(options.flags.db ?? "d1");
  const orm = String(options.flags.orm ?? "drizzle");

  if (db === "d1" && orm === "drizzle") {
    return betterAuthD1DrizzleRecipe(ctx);
  }

  const changes = [
    await fileChange(
      ctx,
      "docs/flarecel-better-auth.md",
      betterAuthDoc(db, orm),
      "Create Better Auth implementation checklist"
    )
  ];

  return {
    status: "planned",
    title: "Plan Better Auth recipe",
    changes,
    warnings: [
      "The Better Auth recipe is a documented placeholder in this MVP; code generation comes after the Next/R2/Rate Limit/Queue loop is proven."
    ],
    nextActions: [
      "Review docs/flarecel-better-auth.md",
      "flarecel verify --json"
    ]
  };
}

async function betterAuthD1DrizzleRecipe(ctx: ProjectContext): Promise<ChangeSet> {
  const databaseName = `${projectName(ctx)}-auth`;
  const binding = "DB";
  const routePath = nextRoutePath(ctx, "auth/[...all]");
  const authFile = nextLibPath(ctx, "auth.ts");
  const authClientFile = nextLibPath(ctx, "auth-client.ts");
  const schemaFile = nextDbPath(ctx, "schema.ts");

  const changes = [
    await packageJsonChange(ctx, "Add Better Auth, Drizzle, D1, and OpenNext dependencies/scripts", (pkg) => {
      pkg.dependencies = pkg.dependencies ?? {};
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.scripts = pkg.scripts ?? {};

      pkg.dependencies["@opennextjs/cloudflare"] = pkg.dependencies["@opennextjs/cloudflare"] ?? depVersion("@opennextjs/cloudflare");
      pkg.dependencies["better-auth"] = pkg.dependencies["better-auth"] ?? depVersion("better-auth");
      pkg.dependencies["drizzle-orm"] = pkg.dependencies["drizzle-orm"] ?? depVersion("drizzle-orm");

      pkg.devDependencies.wrangler = pkg.devDependencies.wrangler ?? depVersion("wrangler");
      pkg.devDependencies["drizzle-kit"] = pkg.devDependencies["drizzle-kit"] ?? depVersion("drizzle-kit");
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");

      pkg.scripts.build = pkg.scripts.build ?? "next build";
      pkg.scripts.preview = "opennextjs-cloudflare build && opennextjs-cloudflare preview";
      pkg.scripts.deploy = "opennextjs-cloudflare build && opennextjs-cloudflare deploy";
      pkg.scripts.upload = "opennextjs-cloudflare build && opennextjs-cloudflare upload";
      pkg.scripts["cf-typegen"] = "wrangler types --env-interface CloudflareEnv cloudflare-env.d.ts";
      pkg.scripts["auth:generate"] = "npx auth@latest generate";
      pkg.scripts["db:generate"] = "drizzle-kit generate";
      pkg.scripts["db:migrate:local"] = `wrangler d1 migrations apply ${databaseName} --local`;
      pkg.scripts["db:migrate:remote"] = `wrangler d1 migrations apply ${databaseName} --remote`;
    }),
    await wranglerChange(ctx, "Bind a D1 database for Better Auth", (config) => {
      config.$schema = config.$schema ?? "node_modules/wrangler/config-schema.json";
      config.name = config.name ?? projectName(ctx);
      if (ctx.framework === "nextjs") {
        config.main = ".open-next/worker.js";
        config.assets = {
          directory: ".open-next/assets",
          binding: "ASSETS"
        };
        config.services = upsertArrayObject(config.services, "binding", {
          binding: "WORKER_SELF_REFERENCE",
          service: String(config.name)
        });
      }
      config.compatibility_date = config.compatibility_date ?? today();
      config.compatibility_flags = addUniqueStrings(config.compatibility_flags, [
        "nodejs_compat",
        "global_fetch_strictly_public"
      ]);
      config.d1_databases = upsertArrayObject(config.d1_databases, "binding", {
        binding,
        database_name: databaseName,
        database_id: "replace-with-d1-database-id",
        migrations_dir: "drizzle"
      });
    }),
    await fileChange(ctx, authFile, betterAuthFactory(schemaFile), "Add Better Auth factory for D1/Drizzle"),
    await fileChange(ctx, authClientFile, betterAuthClient(), "Add Better Auth React client"),
    await fileChange(ctx, routePath, betterAuthRoute(routePath, authFile), "Add Better Auth route handler"),
    await fileChange(ctx, schemaFile, betterAuthDrizzleSchema(), "Add Better Auth Drizzle schema for SQLite/D1"),
    await fileChange(ctx, "drizzle.config.ts", drizzleConfig(schemaFile), "Add Drizzle migration config"),
    await appendLinesChange(ctx, ".gitignore", [".wrangler", "cloudflare-env.d.ts"], "Ignore local Wrangler state and generated binding types"),
    await appendLinesChange(ctx, ".dev.vars.example", [
      "BETTER_AUTH_URL=http://localhost:3000",
      "BETTER_AUTH_SECRET=replace-with-a-32-byte-secret"
    ], "Document local Better Auth environment values"),
    await appendEnvTypes(ctx, [
      "DB: D1Database;",
      "BETTER_AUTH_SECRET: string;",
      "BETTER_AUTH_URL?: string;"
    ], "Add Better Auth and D1 binding types"),
    await fileChange(ctx, "docs/flarecel-better-auth-d1-drizzle.md", betterAuthD1DrizzleDoc(databaseName, binding), "Explain Better Auth + D1 + Drizzle recipe")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: "Add Better Auth with D1 and Drizzle",
    changes,
    warnings: [
      "This recipe generates app code/config but does not create the remote D1 database.",
      "Do not commit real BETTER_AUTH_SECRET values. Use Wrangler secrets for production.",
      "Run the generated migration flow before relying on auth in preview or production."
    ],
    nextActions: [
      `wrangler d1 create ${databaseName}`,
      "Copy the returned database_id into wrangler.jsonc.",
      "openssl rand -base64 32",
      "wrangler secret put BETTER_AUTH_SECRET",
      "npm install",
      "npm run db:generate",
      "npm run db:migrate:local",
      "npm run cf-typegen",
      "flarecel verify --json"
    ]
  };
}

function shouldPatchOpenNext(report: DoctorReport): boolean {
  const patchableIds = new Set([
    "missing-opennext",
    "missing-wrangler-config",
    "missing-nodejs-compat",
    "missing-global-fetch-strictly-public"
  ]);
  return report.issues.some((candidate) => patchableIds.has(candidate.id));
}

async function packageJsonChange(
  ctx: ProjectContext,
  reason: string,
  mutate: (pkg: PackageJson) => void
): Promise<PlannedChange> {
  const before = ctx.packageJsonRaw;
  const pkg = before ? (JSON.parse(before) as PackageJson) : ({ scripts: {} } as PackageJson);
  mutate(pkg);

  return {
    path: "package.json",
    before,
    after: `${JSON.stringify(pkg, null, 2)}\n`,
    reason
  };
}

async function wranglerChange(
  ctx: ProjectContext,
  reason: string,
  mutate: (config: JsonObject) => void
): Promise<PlannedChange> {
  if (ctx.wrangler.format === "toml") {
    const generated = baseWrangler(ctx);
    mutate(generated);

    return {
      path: "wrangler.jsonc",
      before: null,
      after: JSON.stringify(generated, null, 2) + "\n",
      reason: `${reason}. Existing TOML was not modified; this JSONC file is generated for review.`
    };
  }

  const before = ctx.wrangler.rawText;
  const config = ctx.wrangler.data
    ? structuredClone(ctx.wrangler.data)
    : baseWrangler(ctx);

  mutate(config);

  return {
    path: ctx.wrangler.path ? path.basename(ctx.wrangler.path) : "wrangler.jsonc",
    before,
    after: `${JSON.stringify(config, null, 2)}\n`,
    reason
  };
}

function configureOpenNextMainIfNeeded(ctx: ProjectContext, config: JsonObject): void {
  config.$schema = config.$schema ?? "node_modules/wrangler/config-schema.json";
  config.name = config.name ?? projectName(ctx);
  config.compatibility_date = config.compatibility_date ?? today();

  if (ctx.framework !== "nextjs") return;

  config.main = "cloudflare-worker.ts";
  config.compatibility_flags = addUniqueStrings(config.compatibility_flags, [
    "nodejs_compat",
    "global_fetch_strictly_public"
  ]);
  config.assets = {
    directory: ".open-next/assets",
    binding: "ASSETS"
  };
  config.services = upsertArrayObject(config.services, "binding", {
    binding: "WORKER_SELF_REFERENCE",
    service: String(config.name)
  });
}

async function customOpenNextWorkerChange(
  ctx: ProjectContext,
  exportsToAdd: Array<{ exportName: string; sourcePath: string }>,
  reason: string
): Promise<PlannedChange> {
  const relativePath = "cloudflare-worker.ts";
  const before = await readFileIfExists(path.join(ctx.cwd, relativePath));
  const exportLines = exportsToAdd.map((item) => {
    const source = `./${item.sourcePath.replace(/\.ts$/, "")}`;
    return `export { ${item.exportName} } from "${source}";`;
  });

  if (!before) {
    return {
      path: relativePath,
      before,
      after: customOpenNextWorker(exportLines),
      reason
    };
  }

  const missing = exportLines.filter((line) => !before.includes(line));
  if (missing.length === 0) {
    return {
      path: relativePath,
      before,
      after: before,
      reason
    };
  }

  return {
    path: relativePath,
    before,
    after: `${before.replace(/\n?$/, "\n")}${missing.join("\n")}\n`,
    reason
  };
}

function customOpenNextWorker(exportLines: string[]): string {
  return `// @ts-ignore .open-next/worker.js is generated by @opennextjs/cloudflare at build time.
import { default as handler } from "./.open-next/worker.js";

export default {
  fetch: handler.fetch
} satisfies ExportedHandler<CloudflareEnv>;

${exportLines.join("\n")}
`;
}

async function fileChange(ctx: ProjectContext, relativePath: string, content: string, reason: string): Promise<PlannedChange> {
  const before = await readFileIfExists(path.join(ctx.cwd, relativePath));
  return {
    path: relativePath,
    before,
    after: content.endsWith("\n") ? content : `${content}\n`,
    reason
  };
}

async function appendLineChange(ctx: ProjectContext, relativePath: string, line: string, reason: string): Promise<PlannedChange> {
  return appendLinesChange(ctx, relativePath, [line], reason);
}

async function appendLinesChange(ctx: ProjectContext, relativePath: string, linesToAppend: string[], reason: string): Promise<PlannedChange> {
  const before = await readFileIfExists(path.join(ctx.cwd, relativePath));
  const lines = before ? before.split(/\r?\n/) : [];
  const missing = linesToAppend.filter((line) => !lines.includes(line));

  if (missing.length === 0) {
    return {
      path: relativePath,
      before,
      after: before ?? "",
      reason
    };
  }

  const after = `${before ? before.replace(/\n?$/, "\n") : ""}${missing.join("\n")}\n`;
  return {
    path: relativePath,
    before,
    after,
    reason
  };
}

async function appendEnvType(ctx: ProjectContext, declaration: string, reason: string): Promise<PlannedChange> {
  return appendEnvTypes(ctx, [declaration], reason);
}

async function appendEnvTypes(ctx: ProjectContext, declarations: string[], reason: string): Promise<PlannedChange> {
  const relativePath = "cloudflare-env.d.ts";
  const before = await readFileIfExists(path.join(ctx.cwd, relativePath));
  const header = "/// <reference types=\"@cloudflare/workers-types\" />\n\ninterface CloudflareEnv {\n";
  const footer = "}\n";
  const missing = declarations.filter((declaration) => !before?.includes(declaration));

  if (!before) {
    return {
      path: relativePath,
      before,
      after: `${header}${declarations.map((declaration) => `  ${declaration}`).join("\n")}\n${footer}`,
      reason
    };
  }

  if (missing.length === 0) {
    return {
      path: relativePath,
      before,
      after: before,
      reason
    };
  }

  const after = before.includes("interface CloudflareEnv")
    ? before.replace(/interface CloudflareEnv\s*\{\n/, (match) => `${match}${missing.map((declaration) => `  ${declaration}`).join("\n")}\n`)
    : `${before.replace(/\n?$/, "\n")}\n${header}${missing.map((declaration) => `  ${declaration}`).join("\n")}\n${footer}`;

  return {
    path: relativePath,
    before,
    after,
    reason
  };
}

async function ensureHeadersChange(ctx: ProjectContext): Promise<PlannedChange> {
  const relativePath = "public/_headers";
  const before = await readFileIfExists(path.join(ctx.cwd, relativePath));
  const block = "/_next/static/*\n  Cache-Control: public,max-age=31536000,immutable";

  if (before?.includes("/_next/static/*")) {
    return {
      path: relativePath,
      before,
      after: before,
      reason: "Ensure static asset caching headers"
    };
  }

  return {
    path: relativePath,
    before,
    after: `${before ? `${before.replace(/\n?$/, "\n")}\n` : ""}${block}\n`,
    reason: "Ensure static asset caching headers"
  };
}

function baseWrangler(ctx: ProjectContext): JsonObject {
  const config: JsonObject = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: projectName(ctx),
    main: ctx.framework === "nextjs" ? ".open-next/worker.js" : "src/index.ts",
    compatibility_date: today(),
    compatibility_flags: ctx.framework === "nextjs"
      ? ["nodejs_compat", "global_fetch_strictly_public"]
      : []
  };

  if (ctx.framework === "nextjs") {
    config.assets = {
      directory: ".open-next/assets",
      binding: "ASSETS"
    };
    config.services = [
      {
        binding: "WORKER_SELF_REFERENCE",
        service: projectName(ctx)
      }
    ];
  }

  return config;
}

function openNextConfig(): string {
  return `import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
`;
}

function r2UploadRoute(binding: string): string {
  return `import { getCloudflareContext } from "@opennextjs/cloudflare";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type UploadEnv = {
  ${binding}: R2Bucket;
};

export async function PUT(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "File is too large." }, { status: 413 });
  }

  if (!request.body) {
    return Response.json({ error: "Missing request body." }, { status: 400 });
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("key") ?? crypto.randomUUID();
  const contentType = request.headers.get("content-type") ?? undefined;
  const { env } = await getCloudflareContext();

  await (env as UploadEnv).${binding}.put(key, request.body, {
    httpMetadata: contentType ? { contentType } : undefined
  });

  return Response.json({ key });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) {
    return Response.json({ error: "Missing key." }, { status: 400 });
  }

  const { env } = await getCloudflareContext();
  const object = await (env as UploadEnv).${binding}.get(key);
  if (!object) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);

  return new Response(object.body, { headers });
}
`;
}

function rateLimitHelper(binding: string): string {
  return `type RateLimitEnv = {
  ${binding}: RateLimit;
};

export async function enforceRateLimit(
  env: RateLimitEnv,
  key: string,
  message = "Rate limit exceeded."
): Promise<Response | null> {
  const result = await env.${binding}.limit({ key });

  if (!result.success) {
    return Response.json({ error: message }, { status: 429 });
  }

  return null;
}
`;
}

function betterAuthFactory(schemaFile: string): string {
  const schemaImport = relativeImport(nextLibPathFromSchema(schemaFile), schemaFile);

  return `import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "${schemaImport}";

export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
}

export function createAuth(env: AuthEnv) {
  const db = drizzle(env.DB, { schema });

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: {
      enabled: true
    },
    plugins: [
      nextCookies()
    ]
  });
}

export type Auth = ReturnType<typeof createAuth>;
`;
}

function betterAuthClient(): string {
  return `import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
`;
}

function betterAuthRoute(routePath: string, authFile: string): string {
  const authImport = relativeImport(routePath, authFile);

  return `import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createAuth, type AuthEnv } from "${authImport}";

function authForRequest() {
  const { env } = getCloudflareContext();
  return createAuth(env as AuthEnv);
}

export async function GET(request: Request) {
  return authForRequest().handler(request);
}

export async function POST(request: Request) {
  return authForRequest().handler(request);
}
`;
}

function betterAuthDrizzleSchema(): string {
  return `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull()
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" })
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull()
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
});
`;
}

function drizzleConfig(schemaFile: string): string {
  return `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./${schemaFile}",
  out: "./drizzle",
  dialect: "sqlite"
});
`;
}

function d1DrizzleSchema(): string {
  return `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const exampleItems = sqliteTable("example_items", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
});
`;
}

function d1DrizzleHelper(dbFile: string, schemaFile: string): string {
  const schemaImport = relativeImport(dbFile, schemaFile);

  return `import { drizzle } from "drizzle-orm/d1";
import * as schema from "${schemaImport}";

export interface DbEnv {
  DB: D1Database;
}

export function createDb(env: DbEnv) {
  return drizzle(env.DB, { schema });
}

export type AppDb = ReturnType<typeof createDb>;
`;
}

function kvCacheHelper(binding: string): string {
  return `type CacheEnv = {
  ${binding}: KVNamespace;
};

export async function getCachedJson<T>(env: CacheEnv, key: string): Promise<T | null> {
  return await env.${binding}.get<T>(key, "json");
}

export async function putCachedJson(
  env: CacheEnv,
  key: string,
  value: unknown,
  ttlSeconds = 300
): Promise<void> {
  await env.${binding}.put(key, JSON.stringify(value), {
    expirationTtl: ttlSeconds
  });
}

export async function deleteCached(env: CacheEnv, key: string): Promise<void> {
  await env.${binding}.delete(key);
}
`;
}

function turnstileHelper(): string {
  return `export interface TurnstileEnv {
  TURNSTILE_SECRET_KEY: string;
}

export interface TurnstileResult {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  "error-codes"?: string[];
  action?: string;
  cdata?: string;
}

export async function validateTurnstile(
  env: TurnstileEnv,
  token: string,
  remoteIp?: string
): Promise<TurnstileResult> {
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: remoteIp,
      idempotency_key: crypto.randomUUID()
    })
  });

  return await response.json<TurnstileResult>();
}
`;
}

function turnstileRoute(routePath: string): string {
  const helperImport = relativeImport(routePath, "src/cloudflare/turnstile.ts");

  return `import { getCloudflareContext } from "@opennextjs/cloudflare";
import { validateTurnstile, type TurnstileEnv } from "${helperImport}";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { token?: unknown } | null;
  const token = body?.token;

  if (typeof token !== "string" || token.length === 0) {
    return Response.json({ error: "Missing Turnstile token." }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  const remoteIp = request.headers.get("CF-Connecting-IP") ?? undefined;
  const result = await validateTurnstile(env as TurnstileEnv, token, remoteIp);

  if (!result.success) {
    return Response.json({
      error: "Turnstile verification failed.",
      codes: result["error-codes"] ?? []
    }, { status: 400 });
  }

  return Response.json({ ok: true });
}
`;
}

function cronHelper(cronName: string): string {
  const functionName = `run${pascalCase(cronName)}`;

  return `export interface CronJobContext {
  cron: string;
  scheduledTime: number;
}

export async function ${functionName}(ctx: CronJobContext): Promise<void> {
  console.log("Running scheduled job", {
    job: "${cronName}",
    cron: ctx.cron,
    scheduledTime: ctx.scheduledTime
  });

  // Add the real job work here.
}
`;
}

function workersAiHelper(defaultModel: string): string {
  return `export interface WorkersAiEnv {
  AI: Ai;
}

export interface WorkersAiTextResult {
  response?: string;
  [key: string]: unknown;
}

export async function runWorkersAiText(
  env: WorkersAiEnv,
  prompt: string,
  model = "${defaultModel}"
): Promise<WorkersAiTextResult> {
  return await env.AI.run(model, { prompt }) as WorkersAiTextResult;
}
`;
}

function workersAiRoute(routePath: string): string {
  const helperImport = relativeImport(routePath, "src/cloudflare/workers-ai.ts");

  return `import { getCloudflareContext } from "@opennextjs/cloudflare";
import { runWorkersAiText, type WorkersAiEnv } from "${helperImport}";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { prompt?: unknown; model?: unknown } | null;
  const prompt = body?.prompt;

  if (typeof prompt !== "string" || prompt.length === 0) {
    return Response.json({ error: "Missing prompt." }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  const model = typeof body?.model === "string" ? body.model : undefined;
  const result = await runWorkersAiText(env as WorkersAiEnv, prompt, model);

  return Response.json(result);
}
`;
}

function vectorizeHelper(binding: string): string {
  return `type VectorizeEnv = {
  ${binding}: VectorizeIndex;
};

export interface VectorizeMetadata {
  [key: string]: string | number | boolean | string[] | null;
}

export async function upsertVector(
  env: VectorizeEnv,
  id: string,
  values: number[],
  metadata: VectorizeMetadata = {}
): Promise<void> {
  await env.${binding}.upsert([
    {
      id,
      values,
      metadata
    }
  ]);
}

export async function queryVectorize(
  env: VectorizeEnv,
  values: number[],
  topK = 5
) {
  return await env.${binding}.query(values, {
    topK,
    returnMetadata: "all"
  });
}
`;
}

function vectorizeResourceMetadata(indexName: string, dimensions: number, metric: string): string {
  return `${JSON.stringify({
    version: 1,
    resources: {
      vectorize: [
        {
          index_name: indexName,
          dimensions,
          metric
        }
      ]
    }
  }, null, 2)}\n`;
}

function aiGatewayHelper(provider: string): string {
  return `export interface AiGatewayEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  OPENAI_API_KEY?: string;
  CF_AIG_TOKEN?: string;
}

export function aiGatewayBaseUrl(env: AiGatewayEnv, provider = "${provider}") {
  return \`https://gateway.ai.cloudflare.com/v1/\${env.CLOUDFLARE_ACCOUNT_ID}/\${env.AI_GATEWAY_ID}/\${provider}\`;
}

export async function callAiGateway(
  env: AiGatewayEnv,
  path: string,
  body: unknown,
  provider = "${provider}"
): Promise<unknown> {
  const headers = new Headers({
    "Content-Type": "application/json"
  });

  if (env.OPENAI_API_KEY) headers.set("Authorization", \`Bearer \${env.OPENAI_API_KEY}\`);
  if (env.CF_AIG_TOKEN) headers.set("cf-aig-authorization", \`Bearer \${env.CF_AIG_TOKEN}\`);

  const response = await fetch(\`\${aiGatewayBaseUrl(env, provider)}\${path}\`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(\`AI Gateway request failed: \${response.status} \${await response.text()}\`);
  }

  return await response.json();
}
`;
}

function observabilityHelper(): string {
  return `export function requestId(request: Request): string {
  return request.headers.get("cf-ray")
    ?? request.headers.get("x-request-id")
    ?? crypto.randomUUID();
}

export function logRequestEvent(
  request: Request,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  console.log(JSON.stringify({
    event,
    requestId: requestId(request),
    method: request.method,
    url: request.url,
    ...fields
  }));
}
`;
}

function durableObjectClass(className: string): string {
  return `import { DurableObject } from "cloudflare:workers";

export class ${className} extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
  }

  async increment(key = "default"): Promise<{ key: string; value: number }> {
    const current = await this.ctx.storage.get<number>(key) ?? 0;
    const value = current + 1;
    await this.ctx.storage.put(key, value);
    return { key, value };
  }

  async getValue(key = "default"): Promise<{ key: string; value: number }> {
    const value = await this.ctx.storage.get<number>(key) ?? 0;
    return { key, value };
  }
}
`;
}

function durableObjectRoute(routePath: string, binding: string): string {
  const helperType = `${binding}: DurableObjectNamespace;`;

  return `import { getCloudflareContext } from "@opennextjs/cloudflare";

type DurableObjectEnv = {
  ${helperType}
};

type CounterStub = DurableObjectStub & {
  increment(key?: string): Promise<{ key: string; value: number }>;
  getValue(key?: string): Promise<{ key: string; value: number }>;
};

function counterStub(env: DurableObjectEnv, name: string): CounterStub {
  const id = env.${binding}.idFromName(name);
  return env.${binding}.get(id) as CounterStub;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const name = url.searchParams.get("name") ?? "demo";
  const key = url.searchParams.get("key") ?? "default";
  const { env } = getCloudflareContext();
  const result = await counterStub(env as DurableObjectEnv, name).getValue(key);

  return Response.json(result);
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { name?: unknown; key?: unknown } | null;
  const name = typeof body?.name === "string" && body.name.length > 0 ? body.name : "demo";
  const key = typeof body?.key === "string" && body.key.length > 0 ? body.key : "default";
  const { env } = getCloudflareContext();
  const result = await counterStub(env as DurableObjectEnv, name).increment(key);

  return Response.json(result);
}
`;
}

function workflowClass(className: string): string {
  return `import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export type ${className}Params = {
  name?: string;
  source?: string;
};

export class ${className} extends WorkflowEntrypoint<CloudflareEnv, ${className}Params> {
  async run(event: WorkflowEvent<${className}Params>, step: WorkflowStep) {
    const startedAt = await step.do("record start", async () => {
      return new Date().toISOString();
    });

    await step.sleep("small durable pause", "5 seconds");

    return await step.do("finish", async () => {
      return {
        message: \`Hello \${event.payload.name ?? "from Flarecel"}\`,
        source: event.payload.source ?? "manual",
        startedAt,
        finishedAt: new Date().toISOString()
      };
    });
  }
}
`;
}

function workflowRoute(routePath: string, binding: string): string {
  return `import { getCloudflareContext } from "@opennextjs/cloudflare";

type WorkflowEnv = {
  ${binding}: Workflow;
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const instanceId = url.searchParams.get("instanceId");

  if (!instanceId) {
    return Response.json({ error: "Missing instanceId." }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  const instance = await (env as WorkflowEnv).${binding}.get(instanceId);

  return Response.json({
    id: instance.id,
    details: await instance.status()
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" && body.id.length > 0 ? body.id : undefined;
  const params = body?.params && typeof body.params === "object" ? body.params : body ?? {};
  const { env } = getCloudflareContext();
  const instance = await (env as WorkflowEnv).${binding}.create({
    id,
    params
  });

  return Response.json({
    id: instance.id,
    details: await instance.status()
  });
}
`;
}

function browserRunHelper(binding: string): string {
  return `import puppeteer from "@cloudflare/puppeteer";

export interface BrowserRunEnv {
  ${binding}: Fetcher;
}

export interface ScreenshotOptions {
  width?: number;
  height?: number;
  quality?: number;
}

export async function captureScreenshot(
  env: BrowserRunEnv,
  url: string,
  options: ScreenshotOptions = {}
): Promise<Uint8Array> {
  const browser = await puppeteer.launch(env.${binding});

  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: options.width ?? 1200,
      height: options.height ?? 630
    });
    await page.goto(url, {
      waitUntil: "networkidle0"
    });

    return await page.screenshot({
      type: "jpeg",
      quality: options.quality ?? 80
    }) as Uint8Array;
  } finally {
    await browser.close();
  }
}
`;
}

function browserRunRoute(routePath: string): string {
  const helperImport = relativeImport(routePath, "src/cloudflare/browser-run.ts");

  return `import { getCloudflareContext } from "@opennextjs/cloudflare";
import { captureScreenshot, type BrowserRunEnv } from "${helperImport}";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");

  if (!target) {
    return Response.json({ error: "Missing url query parameter." }, { status: 400 });
  }

  let safeUrl: URL;
  try {
    safeUrl = new URL(target);
  } catch {
    return Response.json({ error: "Invalid url." }, { status: 400 });
  }

  if (!["http:", "https:"].includes(safeUrl.protocol)) {
    return Response.json({ error: "Only http and https URLs are allowed." }, { status: 400 });
  }

  const { env } = getCloudflareContext();
  const image = await captureScreenshot(env as BrowserRunEnv, safeUrl.toString());

  return new Response(image, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store"
    }
  });
}
`;
}

function queueHelper(binding: string): string {
  return `export interface QueueJob {
  type: string;
  payload: unknown;
  createdAt: string;
}

type QueueEnv = {
  ${binding}: Queue<QueueJob>;
};

export async function enqueueJob(env: QueueEnv, type: string, payload: unknown): Promise<void> {
  await env.${binding}.send({
    type,
    payload,
    createdAt: new Date().toISOString()
  });
}
`;
}

function r2UploadsDoc(binding: string, bucket: string, routePath: string): string {
  return `# Flarecel R2 Uploads

This recipe adds Cloudflare R2 file storage.

Binding: \`${binding}\`
Bucket: \`${bucket}\`
Route: \`${routePath}\`

Create the remote bucket:

\`\`\`bash
wrangler r2 bucket create ${bucket}
\`\`\`

Then regenerate types:

\`\`\`bash
npm run cf-typegen
\`\`\`

The upload route accepts:

\`\`\`bash
curl -X PUT "http://localhost:8787/api/uploads?key=hello.txt" --data-binary @hello.txt
\`\`\`
`;
}

function rateLimitDoc(
  binding: string,
  route: string,
  parsedLimit: { limit: number; period: 10 | 60 }
): string {
  return `# Flarecel Rate Limiting

This recipe adds a Cloudflare Rate Limiting binding.

Binding: \`${binding}\`
Suggested route: \`${route}\`
Limit: ${parsedLimit.limit} request(s) per ${parsedLimit.period} seconds

Important:

Cloudflare Rate Limiting is excellent for abuse protection, but counters are local to each Cloudflare location. Do not use it as an exact billing meter.
`;
}

function d1DrizzleDoc(databaseName: string, binding: string, schemaFile: string): string {
  return `# Flarecel D1 + Drizzle

This recipe wires Cloudflare D1 to Drizzle.

Binding: \`${binding}\`
Database: \`${databaseName}\`
Schema: \`${schemaFile}\`
Migration directory: \`drizzle\`

Create the remote D1 database:

\`\`\`bash
wrangler d1 create ${databaseName}
\`\`\`

Copy the returned \`database_id\` into \`wrangler.jsonc\`.

Generate and apply migrations:

\`\`\`bash
npm run db:generate
npm run db:migrate:local
npm run db:migrate:remote
\`\`\`

Human explanation:

D1 is Cloudflare's serverless SQL database. Drizzle gives your app typed database queries and migrations.
`;
}

function kvCacheDoc(binding: string, namespaceName: string): string {
  return `# Flarecel KV Cache

This recipe adds Cloudflare Workers KV for cache-like data.

Binding: \`${binding}\`
Namespace: \`${namespaceName}\`

Create the remote namespace:

\`\`\`bash
wrangler kv namespace create ${binding}
\`\`\`

Copy the returned \`id\` into \`wrangler.jsonc\`.

Use KV for:

- Config cache
- Feature flags
- Public page cache metadata
- Low-write, high-read data

Do not use KV for:

- Strict counters
- Transactions
- Billing-critical state
- Data that must be immediately consistent everywhere

Human explanation:

KV is a global key-value store. It is fast for reads, but eventually consistent.
`;
}

function turnstileDoc(formName: string, routePath: string): string {
  return `# Flarecel Turnstile

This recipe adds Cloudflare Turnstile server-side token validation.

Form: \`${formName}\`
Verification route: \`${routePath}\`

Create a Turnstile widget in the Cloudflare dashboard, then set:

\`\`\`bash
wrangler secret put TURNSTILE_SECRET_KEY
\`\`\`

Expose the site key to your frontend:

\`\`\`bash
NEXT_PUBLIC_TURNSTILE_SITE_KEY=...
\`\`\`

Important:

The client-side widget alone does not protect your app. The server must call Siteverify for every protected submit.

Human explanation:

Turnstile is Cloudflare's bot check. It helps protect forms like signup, login, waitlists, contact forms, and checkout.
`;
}

function cronDoc(cronName: string, schedule: string): string {
  const functionName = `run${pascalCase(cronName)}`;

  return `# Flarecel Cron Trigger

This recipe adds a Cloudflare Cron Trigger.

Job: \`${cronName}\`
Schedule: \`${schedule}\`
Helper: \`src/cloudflare/cron/${cronName}.ts\`

Wrangler config now includes this schedule under:

\`\`\`json
{
  "triggers": {
    "crons": ["${schedule}"]
  }
}
\`\`\`

Wire the helper into a Worker scheduled handler:

\`\`\`ts
import { ${functionName} } from "./cloudflare/cron/${cronName}";

export default {
  async scheduled(controller: ScheduledController) {
    await ${functionName}({
      cron: controller.cron,
      scheduledTime: controller.scheduledTime
    });
  }
};
\`\`\`

Human explanation:

Cron Triggers let Cloudflare run scheduled jobs like cleanup, syncs, digests, billing checks, and cache warmups.
`;
}

function workersAiDoc(model: string, routePath: string): string {
  return `# Flarecel Workers AI

This recipe adds a Workers AI binding and a simple generation route.

Binding: \`AI\`
Default model: \`${model}\`
Route: \`${routePath}\`

Regenerate binding types:

\`\`\`bash
npm run cf-typegen
\`\`\`

Estimate usage:

\`\`\`bash
flarecel cost --workers-ai-neurons 300000 --json
\`\`\`

Human explanation:

Workers AI lets your app run AI models through Cloudflare's platform without managing model infrastructure. Usage is metered, so add rate limits before public launch.
`;
}

function vectorizeDoc(indexName: string, binding: string, dimensions: number, metric: string): string {
  return `# Flarecel Vectorize

This recipe adds a Cloudflare Vectorize index binding.

Binding: \`${binding}\`
Index: \`${indexName}\`
Dimensions: ${dimensions}
Metric: \`${metric}\`

Create the remote index:

\`\`\`bash
wrangler vectorize create ${indexName} --dimensions=${dimensions} --metric=${metric}
\`\`\`

Important:

Vector dimensions and metric cannot be changed after the index is created. Match dimensions to your embedding model.

Estimate usage:

\`\`\`bash
flarecel cost --vectorize-queries 30000 --vectorize-stored-vectors 10000 --vectorize-dimensions ${dimensions} --json
\`\`\`

Human explanation:

Vectorize is Cloudflare's vector database for semantic search, recommendations, RAG, and AI memory.
`;
}

function aiGatewayDoc(provider: string): string {
  return `# Flarecel AI Gateway

This recipe adds an AI Gateway helper for provider: \`${provider}\`.

Environment values:

- \`CLOUDFLARE_ACCOUNT_ID\`
- \`AI_GATEWAY_ID\`
- \`OPENAI_API_KEY\` when using OpenAI
- \`CF_AIG_TOKEN\` when your gateway requires Cloudflare AI Gateway auth

Set production secrets:

\`\`\`bash
wrangler secret put OPENAI_API_KEY
wrangler secret put CF_AIG_TOKEN
\`\`\`

Human explanation:

AI Gateway routes AI provider calls through Cloudflare so you can add observability, caching, retries, and governance around model usage.
`;
}

function observabilityDoc(sampling: number): string {
  return `# Flarecel Observability

This recipe enables Workers Logs in Wrangler.

Sampling rate: ${sampling}

Tail logs locally:

\`\`\`bash
npm run logs:tail
\`\`\`

After deploy, use Cloudflare Workers Logs and Query Builder to inspect requests, errors, CPU time, and logs.

Human explanation:

Observability is how you debug production without guessing. It should be enabled before launch, not after something breaks.
`;
}

function durableObjectDoc(objectName: string, binding: string, className: string, routePath: string): string {
  return `# Flarecel Durable Object

This recipe adds a SQLite-backed Cloudflare Durable Object.

Object: \`${objectName}\`
Binding: \`${binding}\`
Class: \`${className}\`
Demo route: \`${routePath}\`

What changed:

- \`wrangler.jsonc\` now has a \`durable_objects.bindings\` entry.
- \`wrangler.jsonc\` now has a migration tag with \`new_sqlite_classes\`.
- OpenNext apps use \`cloudflare-worker.ts\` so Wrangler can export the Durable Object class and the Next.js fetch handler together.

Try the demo route:

\`\`\`bash
curl -X POST "http://localhost:8787/api/durable-objects/${objectName}" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"demo","key":"visits"}'
\`\`\`

Human explanation:

Durable Objects are for strongly consistent per-object state: rooms, carts, collaborative sessions, locks, game lobbies, rate limit state, and tiny state machines.

Do not delete or rename deployed migration tags casually. Durable Object migrations are part of production state history.
`;
}

function workflowDoc(
  workflowName: string,
  workflowSlug: string,
  binding: string,
  className: string,
  routePath: string,
  schedule: string | null
): string {
  return `# Flarecel Workflow

This recipe adds a Cloudflare Workflow.

Workflow: \`${workflowName}\`
Binding: \`${binding}\`
Class: \`${className}\`
Trigger route: \`${routePath}\`
Schedule: ${schedule ? `\`${schedule}\`` : "none"}

Start an instance:

\`\`\`bash
curl -X POST "http://localhost:8787/api/workflows/${workflowSlug}" \\
  -H "Content-Type: application/json" \\
  -d '{"params":{"name":"demo","source":"curl"}}'
\`\`\`

List instances:

\`\`\`bash
npm run workflows:list
\`\`\`

Human explanation:

Workflows are durable multi-step jobs. Use them for onboarding, billing follow-ups, AI pipelines, webhooks, imports, retries, approvals, and jobs that should survive a deploy.
`;
}

function browserRunDoc(binding: string, routePath: string): string {
  return `# Flarecel Browser Run

This recipe adds Cloudflare Browser Run with \`@cloudflare/puppeteer\`.

Binding: \`${binding}\`
Screenshot route: \`${routePath}\`

Try the demo route:

\`\`\`bash
curl "http://localhost:8787/api/browser/screenshot?url=https://example.com" --output screenshot.jpg
\`\`\`

Estimate usage:

\`\`\`bash
flarecel cost --browser-run-hours 20 --browser-run-concurrency 10 --json
\`\`\`

Human explanation:

Browser Run lets a Worker drive a real browser for screenshots, PDFs, rendered crawling, link previews, and browser-like agent tasks. It is the Cloudflare-native replacement for trying to bundle normal Puppeteer or Playwright into a Worker.

Security note:

Do not expose arbitrary browser rendering to the public without auth, rate limits, URL allowlists, and timeout controls.
`;
}

function queueDoc(binding: string, queueName: string): string {
  return `# Flarecel Queue

This recipe adds a Cloudflare Queue.

Binding: \`${binding}\`
Queue: \`${queueName}\`

Create the remote queue:

\`\`\`bash
wrangler queues create ${queueName}
\`\`\`

Use queues for background work like emails, webhook retries, AI jobs, or ingestion.

This MVP wires the producer binding. For consumption, use a custom OpenNext Worker entry or a separate consumer Worker and attach it with Wrangler.
`;
}

function betterAuthDoc(db: string, orm: string): string {
  return `# Better Auth On Cloudflare

Status: planned recipe placeholder.

Requested stack:

- Auth: Better Auth
- Database: ${db}
- ORM: ${orm}

MVP rule:

Do not generate Better Auth code until the base Next.js -> OpenNext -> Workers flow is proven end-to-end.

Future recipe should generate:

- Better Auth install
- D1 binding when \`db=d1\`
- Drizzle schema when \`orm=drizzle\`
- Auth route handler
- Wrangler secrets checklist
- OAuth callback domain checklist
- Turnstile signup protection option
`;
}

function betterAuthD1DrizzleDoc(databaseName: string, binding: string): string {
  return `# Flarecel Better Auth + D1 + Drizzle

This recipe wires Better Auth to Cloudflare D1 through Drizzle.

Binding: \`${binding}\`
Database: \`${databaseName}\`
Migration directory: \`drizzle\`

Create the remote D1 database:

\`\`\`bash
wrangler d1 create ${databaseName}
\`\`\`

Copy the returned \`database_id\` into \`wrangler.jsonc\`.

Generate a local secret:

\`\`\`bash
openssl rand -base64 32
\`\`\`

Set the production secret:

\`\`\`bash
wrangler secret put BETTER_AUTH_SECRET
\`\`\`

Generate and apply migrations:

\`\`\`bash
npm run db:generate
npm run db:migrate:local
npm run db:migrate:remote
\`\`\`

Security note:

Do not do full database-backed auth checks in old Edge middleware. Prefer route/page/server-action checks, or Next 16 proxy with a runtime that supports the needed APIs.
`;
}

function nextRoutePath(ctx: ProjectContext, segment: string): string {
  const srcApp = path.join(ctx.cwd, "src", "app");
  const app = path.join(ctx.cwd, "app");

  if (pathExistsSync(srcApp)) return `src/app/api/${segment}/route.ts`;
  if (pathExistsSync(app)) return `app/api/${segment}/route.ts`;
  return `app/api/${segment}/route.ts`;
}

function nextLibPath(ctx: ProjectContext, fileName: string): string {
  return pathExistsSync(path.join(ctx.cwd, "src", "app"))
    ? `src/lib/${fileName}`
    : `lib/${fileName}`;
}

// Files that live at the app root or under src/ (e.g. middleware.ts, auth.ts).
function nextSrcRootPath(ctx: ProjectContext, fileName: string): string {
  return pathExistsSync(path.join(ctx.cwd, "src", "app")) ? `src/${fileName}` : fileName;
}

function nextRootFile(ctx: ProjectContext, fileName: string): string {
  return nextSrcRootPath(ctx, fileName);
}

function nextDbPath(ctx: ProjectContext, fileName: string): string {
  return pathExistsSync(path.join(ctx.cwd, "src", "app"))
    ? `src/db/${fileName}`
    : `db/${fileName}`;
}

function nextLibPathFromSchema(schemaFile: string): string {
  return schemaFile.startsWith("src/")
    ? "src/lib/auth.ts"
    : "lib/auth.ts";
}

function relativeImport(fromFile: string, toFile: string): string {
  let relativePath = path.relative(path.dirname(fromFile), toFile.replace(/\.ts$/, ""));
  if (!relativePath.startsWith(".")) relativePath = `./${relativePath}`;
  return relativePath.replace(/\\/g, "/");
}

function parseLimit(value: string): { limit: number; period: 10 | 60 } {
  const match = value.match(/^(\d+)\/(10s|60s|min|minute)$/);
  if (!match) return { limit: 20, period: 60 };

  return {
    limit: Number(match[1]),
    period: match[2] === "10s" ? 10 : 60
  };
}

function numericOption(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseVectorMetric(value: string): string {
  return ["cosine", "euclidean", "dot-product"].includes(value) ? value : "cosine";
}

function parseSampling(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(1, Math.max(0, parsed));
}

function addUniqueStrings(existing: unknown, values: string[]): string[] {
  const set = new Set(Array.isArray(existing) ? existing.filter((value) => typeof value === "string") as string[] : []);
  for (const value of values) set.add(value);
  return [...set];
}

function upsertArrayObject(existing: unknown, key: string, value: JsonObject): JsonObject[] {
  const array = Array.isArray(existing) ? existing.filter(isObject) : [];
  const index = array.findIndex((candidate) => candidate[key] === value[key]);

  if (index === -1) return [...array, value];

  const next = [...array];
  next[index] = { ...next[index], ...value };
  return next;
}

function upsertDurableObjectMigration(existing: unknown, tag: string, className: string): JsonObject[] {
  const migrations = Array.isArray(existing) ? existing.filter(isObject) : [];
  const index = migrations.findIndex((candidate) => candidate.tag === tag);

  if (index === -1) {
    return [
      ...migrations,
      {
        tag,
        new_sqlite_classes: [className]
      }
    ];
  }

  const next = [...migrations];
  const migration = { ...next[index] };
  migration.new_sqlite_classes = addUniqueStrings(migration.new_sqlite_classes, [className]);
  next[index] = migration;
  return next;
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? { ...value } : {};
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function sanitizeFeatureName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "feature";
}

function sanitizeQueueName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "jobs";
}

function pascalCase(value: string): string {
  const result = value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");

  return result || "Job";
}

function pathExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

function unknownRecipe(name: string): ChangeSet {
  return {
    status: "error",
    title: `Unknown recipe: ${name}`,
    changes: [],
    warnings: [`Recipe "${name}" is not implemented yet.`],
    nextActions: ["flarecel plan --json"]
  };
}
