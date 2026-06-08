import path from "node:path";
import { findUserAddon, UserAddonError } from "./user-addons.js";
import { externalIntegrationAddOn } from "./addon-spec.js";
import { shouldPatchOpenNext, nextOpenNextAddOn, isrAddOn } from "./addon-opennext.js";
import {
  r2UploadsAddOn, rateLimitAddOn, d1DrizzleAddOn, kvCacheAddOn, turnstileAddOn, cronAddOn,
  workersAiAddOn, vectorizeAddOn, aiGatewayAddOn, observabilityAddOn, durableObjectAddOn,
  workflowAddOn, browserRunAddOn, queueAddOn
} from "./addon-bindings.js";
import {
  authAddOn, externalDbAddOn, backendAddOn, redisAddOn, d1PrismaSpec,
  stripeSpec, resendSpec, cloudflareImagesSpec, hyperdriveSpec, emailRoutingSpec
} from "./addon-providers.js";
import { betterAuthAddOn, sasBillingAddOn } from "./addon-stacks.js";
import { unknownAddOn } from "./addon-utils.js";
import type { ChangeSet, DoctorReport, PlannedChange, ProjectContext } from "./types.js";
import type { AddOnOptions } from "./addon-spec.js";

// public API barrel: these stay importable from "./addon-dispatch.js" so cli.ts,
// mcp.ts, compose.ts, and user-addons.ts need no changes after the split.
export { externalIntegrationAddOn } from "./addon-spec.js";
export type { IntegrationSpec, AddOnOptions } from "./addon-spec.js";

export async function createFixChangeSet(ctx: ProjectContext, report: DoctorReport): Promise<ChangeSet> {
  const changes: PlannedChange[] = [];
  const warnings: string[] = [];

  if (ctx.framework === "nextjs" && shouldPatchOpenNext(report)) {
    const result = await nextOpenNextAddOn(ctx);
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

export async function createAddOnChangeSet(
  ctx: ProjectContext,
  addOnName: string,
  options: AddOnOptions
): Promise<ChangeSet> {
  if (ctx.packageJsonRaw !== null && ctx.packageJson === null) {
    return malformedPackageJson(ctx);
  }
  return withFrameworkWarning(ctx, withTomlWarning(ctx, await resolveAddOnChangeSet(ctx, addOnName, options)));
}

function withFrameworkWarning(ctx: ProjectContext, changeSet: ChangeSet): ChangeSet {
  if (ctx.framework === "nextjs" || ctx.framework === "unknown") return changeSet;
  const emitsNextRoute = changeSet.changes.some((change) => /(?:^|\/)app\/api\/.+\/route\.ts$/.test(change.path));
  if (!emitsNextRoute) return changeSet;

  return {
    ...changeSet,
    warnings: [
      `This add-on generates Next.js App Router code, but the detected framework is ${ctx.framework}. Review the generated route handlers; they may need to be adapted.`,
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

export async function resolveAddOnChangeSet(
  ctx: ProjectContext,
  addOnName: string,
  options: AddOnOptions
): Promise<ChangeSet> {
  if (addOnName === "next-opennext") {
    if (ctx.framework !== "nextjs") {
      return {
        status: "error",
        title: "next-opennext requires a Next.js project",
        changes: [],
        warnings: [`Detected framework: ${ctx.framework}. The OpenNext adapter only applies to Next.js.`],
        nextActions: ["flarecel doctor --json"]
      };
    }
    return nextOpenNextAddOn(ctx);
  }

  if (addOnName === "r2") {
    const kind = options.positionals[0] ?? "uploads";
    if (kind !== "uploads") return unknownAddOn(`r2 ${kind}`);
    return r2UploadsAddOn(ctx);
  }

  if (addOnName === "rate-limit") return rateLimitAddOn(ctx, options);

  if (addOnName === "db") {
    const db = options.positionals[0] ?? "d1";
    const orm = String(options.flags.orm ?? "drizzle");
    if (db === "d1" && orm === "drizzle") return d1DrizzleAddOn(ctx);
    if (db === "d1" && orm === "prisma") return externalIntegrationAddOn(ctx, d1PrismaSpec(ctx));
    if (["supabase", "neon", "turso", "planetscale", "mongodb"].includes(db)) {
      return externalDbAddOn(ctx, db, options);
    }
    return unknownAddOn(`db ${db} --orm ${orm}`);
  }

  if (addOnName === "kv") {
    const kind = options.positionals[0] ?? "cache";
    if (kind !== "cache") return unknownAddOn(`kv ${kind}`);
    return kvCacheAddOn(ctx);
  }

  if (addOnName === "turnstile") return turnstileAddOn(ctx, options);

  if (addOnName === "cron") {
    const cronName = options.positionals[0] ?? "daily-cleanup";
    return cronAddOn(ctx, cronName, options);
  }

  if (addOnName === "workers-ai") return workersAiAddOn(ctx, options);

  if (addOnName === "vectorize") {
    const indexName = options.positionals[0] ?? "docs-search";
    return vectorizeAddOn(ctx, indexName, options);
  }

  if (addOnName === "ai-gateway") return aiGatewayAddOn(ctx, options);

  if (addOnName === "observability" || addOnName === "monitor") {
    return observabilityAddOn(ctx, options);
  }

  if (addOnName === "durable-object" || addOnName === "do") {
    const objectName = options.positionals[0] ?? "room";
    return durableObjectAddOn(ctx, objectName);
  }

  if (addOnName === "workflow" || addOnName === "workflows") {
    const workflowName = options.positionals[0] ?? "onboarding";
    return workflowAddOn(ctx, workflowName, options);
  }

  if (addOnName === "browser-run" || addOnName === "browser-rendering") {
    return browserRunAddOn(ctx);
  }

  if (addOnName === "queue") {
    const queueName = options.positionals[0] ?? "jobs";
    return queueAddOn(ctx, queueName);
  }

  if (addOnName === "isr") return isrAddOn(ctx);
  if (addOnName === "stripe") return externalIntegrationAddOn(ctx, stripeSpec(ctx));
  if (addOnName === "resend") return externalIntegrationAddOn(ctx, resendSpec(ctx));
  if (addOnName === "cloudflare-images" || addOnName === "images") return externalIntegrationAddOn(ctx, cloudflareImagesSpec(ctx));
  if (addOnName === "hyperdrive") return externalIntegrationAddOn(ctx, hyperdriveSpec(ctx));
  if (addOnName === "email-routing" || addOnName === "email") return externalIntegrationAddOn(ctx, emailRoutingSpec(ctx));
  if (addOnName === "saas-billing") return sasBillingAddOn(ctx);

  if (addOnName === "auth") {
    const provider = options.positionals[0] ?? "";
    if (provider === "better-auth") return betterAuthAddOn(ctx, options);
    return authAddOn(ctx, provider);
  }

  if (addOnName === "backend") {
    return backendAddOn(ctx, options.positionals[0] ?? "");
  }

  if (addOnName === "redis") {
    return redisAddOn(ctx, options.positionals[0] ?? "upstash");
  }

  // user-pluggable add-ons: declarative JSON specs in .flarecel/addons/.
  try {
    const userAddon = findUserAddon(ctx.cwd, addOnName);
    if (userAddon) return externalIntegrationAddOn(ctx, userAddon.spec);
  } catch (error) {
    return {
      status: "error",
      title: `Invalid user add-on`,
      changes: [],
      warnings: [error instanceof UserAddonError ? error.message : String(error)],
      nextActions: ["Fix the add-on JSON in .flarecel/addons/, then re-run."]
    };
  }

  return unknownAddOn(addOnName);
}
