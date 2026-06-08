import { relativeImport, nextLibPathFromSchema, pascalCase } from "./addon-utils.js";

export function r2UploadRoute(binding: string): string {
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

export function rateLimitHelper(binding: string): string {
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

export function betterAuthFactory(schemaFile: string): string {
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

export function betterAuthClient(): string {
  return `import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
`;
}

export function betterAuthRoute(routePath: string, authFile: string): string {
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

export function betterAuthDrizzleSchema(): string {
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

export function drizzleConfig(schemaFile: string): string {
  return `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./${schemaFile}",
  out: "./drizzle",
  dialect: "sqlite"
});
`;
}

export function d1DrizzleSchema(): string {
  return `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const exampleItems = sqliteTable("example_items", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull()
});
`;
}

export function d1DrizzleHelper(dbFile: string, schemaFile: string): string {
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

export function kvCacheHelper(binding: string): string {
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

export function turnstileHelper(): string {
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

export function turnstileRoute(routePath: string): string {
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

export function cronHelper(cronName: string): string {
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

  // add the real job work here.
}
`;
}

export function workersAiHelper(defaultModel: string): string {
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

export function workersAiRoute(routePath: string): string {
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

export function vectorizeHelper(binding: string): string {
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

export function vectorizeResourceMetadata(indexName: string, dimensions: number, metric: string): string {
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

export function aiGatewayHelper(provider: string): string {
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

export function observabilityHelper(): string {
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

export function durableObjectClass(className: string): string {
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

export function durableObjectRoute(routePath: string, binding: string): string {
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

export function workflowClass(className: string): string {
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

export function workflowRoute(routePath: string, binding: string): string {
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

export function browserRunHelper(binding: string): string {
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

export function browserRunRoute(routePath: string): string {
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

export function queueHelper(binding: string): string {
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

export function r2UploadsDoc(binding: string, bucket: string, routePath: string): string {
  return `# Flarecel R2 Uploads

This add-on adds Cloudflare R2 file storage.

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

export function rateLimitDoc(
  binding: string,
  route: string,
  parsedLimit: { limit: number; period: 10 | 60 }
): string {
  return `# Flarecel Rate Limiting

This add-on adds a Cloudflare Rate Limiting binding.

Binding: \`${binding}\`
Suggested route: \`${route}\`
Limit: ${parsedLimit.limit} request(s) per ${parsedLimit.period} seconds

Important:

Cloudflare Rate Limiting is excellent for abuse protection, but counters are local to each Cloudflare location. Do not use it as an exact billing meter.
`;
}

export function d1DrizzleDoc(databaseName: string, binding: string, schemaFile: string): string {
  return `# Flarecel D1 + Drizzle

This add-on wires Cloudflare D1 to Drizzle.

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

export function kvCacheDoc(binding: string, namespaceName: string): string {
  return `# Flarecel KV Cache

This add-on adds Cloudflare Workers KV for cache-like data.

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

export function turnstileDoc(formName: string, routePath: string): string {
  return `# Flarecel Turnstile

This add-on adds Cloudflare Turnstile server-side token validation.

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

export function cronDoc(cronName: string, schedule: string): string {
  const functionName = `run${pascalCase(cronName)}`;

  return `# Flarecel Cron Trigger

This add-on adds a Cloudflare Cron Trigger.

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

export function workersAiDoc(model: string, routePath: string): string {
  return `# Flarecel Workers AI

This add-on adds a Workers AI binding and a simple generation route.

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

export function vectorizeDoc(indexName: string, binding: string, dimensions: number, metric: string): string {
  return `# Flarecel Vectorize

This add-on adds a Cloudflare Vectorize index binding.

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

export function aiGatewayDoc(provider: string): string {
  return `# Flarecel AI Gateway

This add-on adds an AI Gateway helper for provider: \`${provider}\`.

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

export function observabilityDoc(sampling: number): string {
  return `# Flarecel Observability

This add-on enables Workers Logs in Wrangler.

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

export function durableObjectDoc(objectName: string, binding: string, className: string, routePath: string): string {
  return `# Flarecel Durable Object

This add-on adds a SQLite-backed Cloudflare Durable Object.

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

export function workflowDoc(
  workflowName: string,
  workflowSlug: string,
  binding: string,
  className: string,
  routePath: string,
  schedule: string | null
): string {
  return `# Flarecel Workflow

This add-on adds a Cloudflare Workflow.

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

export function browserRunDoc(binding: string, routePath: string): string {
  return `# Flarecel Browser Run

This add-on adds Cloudflare Browser Run with \`@cloudflare/puppeteer\`.

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

export function queueDoc(binding: string, queueName: string): string {
  return `# Flarecel Queue

This add-on adds a Cloudflare Queue.

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

export function betterAuthDoc(db: string, orm: string): string {
  return `# Better Auth On Cloudflare

Status: planned add-on placeholder.

Requested stack:

- Auth: Better Auth
- Database: ${db}
- ORM: ${orm}

MVP rule:

Do not generate Better Auth code until the base Next.js -> OpenNext -> Workers flow is proven end-to-end.

Future add-on should generate:

- Better Auth install
- D1 binding when \`db=d1\`
- Drizzle schema when \`orm=drizzle\`
- Auth route handler
- Wrangler secrets checklist
- OAuth callback domain checklist
- Turnstile signup protection option
`;
}

export function betterAuthD1DrizzleDoc(databaseName: string, binding: string): string {
  return `# Flarecel Better Auth + D1 + Drizzle

This add-on wires Better Auth to Cloudflare D1 through Drizzle.

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

