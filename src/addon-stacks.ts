import { projectName } from "./project.js";
import { VERIFIED_ON, depVersion } from "./addon-versions.js";
import {
  packageJsonChange, wranglerChange, fileChange, appendLinesChange, appendEnvTypes
} from "./addon-changes.js";
import {
  betterAuthFactory, betterAuthClient, betterAuthRoute, betterAuthDrizzleSchema,
  drizzleConfig, betterAuthDoc, betterAuthD1DrizzleDoc
} from "./addon-templates.js";
import { integrationDoc, type AddOnOptions } from "./addon-spec.js";
import {
  nextRoutePath, nextLibPath, nextDbPath, relativeImport, today, addUniqueStrings, upsertArrayObject
} from "./addon-utils.js";
import type { ChangeSet, ProjectContext } from "./types.js";

export async function betterAuthAddOn(ctx: ProjectContext, options: AddOnOptions): Promise<ChangeSet> {
  const db = String(options.flags.db ?? "d1");
  const orm = String(options.flags.orm ?? "drizzle");

  if (db === "d1" && orm === "drizzle") {
    return betterAuthD1DrizzleAddOn(ctx);
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
    title: "Plan Better Auth add-on",
    changes,
    warnings: [
      "The Better Auth add-on is a documented placeholder in this MVP; code generation comes after the Next/R2/Rate Limit/Queue loop is proven."
    ],
    nextActions: [
      "Review docs/flarecel-better-auth.md",
      "flarecel verify --json"
    ]
  };
}

async function betterAuthD1DrizzleAddOn(ctx: ProjectContext): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-better-auth-d1-drizzle.md", betterAuthD1DrizzleDoc(databaseName, binding), "Explain Better Auth + D1 + Drizzle add-on")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: "Add Better Auth with D1 and Drizzle",
    changes,
    warnings: [
      "This add-on generates app code/config but does not create the remote D1 database.",
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

export async function sasBillingAddOn(ctx: ProjectContext): Promise<ChangeSet> {
  const routePath = nextRoutePath(ctx, "stripe/webhook");
  const checkoutPath = nextRoutePath(ctx, "stripe/checkout");
  const schemaPath = nextDbPath(ctx, "billing-schema.ts");
  const helperPath = nextLibPath(ctx, "billing.ts");

  const changes = [
    await packageJsonChange(ctx, "Add Stripe + Drizzle for SaaS billing", (pkg) => {
      pkg.dependencies = pkg.dependencies ?? {};
      pkg.dependencies["stripe"] = pkg.dependencies["stripe"] ?? depVersion("stripe");
      pkg.dependencies["drizzle-orm"] = pkg.dependencies["drizzle-orm"] ?? depVersion("drizzle-orm");
      pkg.devDependencies = pkg.devDependencies ?? {};
      pkg.devDependencies["@cloudflare/workers-types"] = pkg.devDependencies["@cloudflare/workers-types"] ?? depVersion("@cloudflare/workers-types");
    }),
    await wranglerChange(ctx, "Ensure D1 binding for billing", (config) => {
      config.d1_databases = upsertArrayObject(config.d1_databases, "binding", {
        binding: "DB",
        database_name: `${projectName(ctx)}-db`,
        database_id: "replace-with-d1-database-id",
        migrations_dir: "drizzle"
      });
    }),
    await fileChange(ctx, schemaPath, billingSchema(), "Add billing/subscriptions schema"),
    await fileChange(ctx, helperPath, billingHelper(), "Add entitlement helper"),
    await fileChange(ctx, checkoutPath, billingCheckout(helperPath), "Add Stripe checkout session route"),
    await fileChange(ctx, routePath, billingWebhook(relativeImport(routePath, helperPath)), "Add Stripe webhook with subscription handling (subsumes basic stripe add-on)"),
    await appendEnvTypes(ctx, [
      "DB: D1Database;",
      "STRIPE_SECRET_KEY: string;",
      "STRIPE_WEBHOOK_SECRET: string;",
      "STRIPE_PRICE_ID: string;"
    ], "Add SaaS billing env types"),
    await appendLinesChange(ctx, ".dev.vars.example", [
      "STRIPE_SECRET_KEY=sk_test_replace",
      "STRIPE_WEBHOOK_SECRET=whsec_replace",
      "STRIPE_PRICE_ID=price_replace"
    ], "Document billing env values"),
    await fileChange(ctx, "docs/flarecel-saas-billing.md", billingDoc(), "Explain SaaS billing add-on")
  ].filter((change) => change.before !== change.after);

  return {
    status: "planned",
    title: "Add SaaS billing (Stripe + D1 entitlements)",
    changes,
    warnings: [
      `EXPERIMENTAL add-on. Verified on ${VERIFIED_ON}.`,
      "If you previously ran `add stripe`, this replaces the webhook route with a fuller subscription handler.",
      "Create the D1 database and set Stripe secrets before production.",
      "Does not run npm install or set remote secrets."
    ],
    nextActions: ["npm install", "wrangler secret put STRIPE_SECRET_KEY", "wrangler secret put STRIPE_WEBHOOK_SECRET", "npm run db:generate", "flarecel verify --json"]
  };
}

function billingSchema(): string {
  return `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const subscriptions = sqliteTable("subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull(),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  plan: text("plan").notNull().default("free"),
  status: text("status").notNull().default("active"),
  currentPeriodEnd: integer("current_period_end")
});
`;
}

function billingHelper(): string {
  return `import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { subscriptions } from "../db/billing-schema.js";

export function getBillingDb(env: { DB: D1Database }) {
  return drizzle(env.DB, { schema: { subscriptions } });
}

export async function getUserPlan(env: { DB: D1Database }, userId: string) {
  const db = getBillingDb(env);
  const row = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)).get();
  return row?.plan ?? "free";
}

export async function upsertSubscription(
  env: { DB: D1Database },
  data: { userId: string; stripeCustomerId: string; stripeSubscriptionId: string; plan: string; status: string; currentPeriodEnd: number }
) {
  const db = getBillingDb(env);
  const existing = await db.select().from(subscriptions).where(eq(subscriptions.stripeCustomerId, data.stripeCustomerId)).get();
  if (existing) {
    await db.update(subscriptions).set(data).where(eq(subscriptions.id, existing.id));
  } else {
    await db.insert(subscriptions).values(data);
  }
}
`;
}

function billingCheckout(helperPath: string): string {
  return `import Stripe from "stripe";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function POST(request: Request) {
  const { env } = getCloudflareContext();
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  const { userId } = await request.json() as { userId: string };

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: new URL("/billing/success", request.url).toString(),
    cancel_url: new URL("/billing/cancel", request.url).toString(),
    metadata: { userId }
  });

  return Response.json({ url: session.url });
}
`;
}

function billingWebhook(helperImport: string): string {
  return `import Stripe from "stripe";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { upsertSubscription } from "${helperImport}";

// workers-safe webhook verification (async + SubtleCrypto).
export async function POST(request: Request) {
  const { env } = getCloudflareContext();
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });

  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await request.text(),
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      undefined,
      Stripe.createSubtleCryptoProvider()
    );
  } catch (error) {
    return new Response("Webhook verification failed", { status: 400 });
  }

  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
    const sub = event.data.object as Stripe.Subscription;
    await upsertSubscription(env, {
      userId: sub.metadata?.userId ?? "",
      stripeCustomerId: sub.customer as string,
      stripeSubscriptionId: sub.id,
      plan: sub.items.data[0]?.price?.lookup_key ?? "pro",
      status: sub.status,
      currentPeriodEnd: sub.current_period_end
    });
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    await upsertSubscription(env, {
      userId: sub.metadata?.userId ?? "",
      stripeCustomerId: sub.customer as string,
      stripeSubscriptionId: sub.id,
      plan: "free",
      status: "canceled",
      currentPeriodEnd: sub.current_period_end
    });
  }

  return Response.json({ received: true });
}
`;
}

function billingDoc(): string {
  return integrationDoc("SaaS Billing (Stripe + D1)", `Opinionated billing module: Stripe Checkout + subscription webhooks + D1 entitlements.

Generated files:
- Checkout route (creates Stripe Checkout session)
- Webhook route (handles subscription.created/updated/deleted, updates D1)
- Billing schema (subscriptions table with plan/status/period)
- Entitlement helper (getUserPlan, upsertSubscription)

Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID.

If you previously ran \`flarecel add stripe\`, this replaces that webhook route with a fuller subscription handler.`);
}
