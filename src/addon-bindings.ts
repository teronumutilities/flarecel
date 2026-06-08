import { projectName } from "./project.js";
import { depVersion } from "./addon-versions.js";
import {
  packageJsonChange, wranglerChange, fileChange, appendLinesChange,
  appendEnvType, appendEnvTypes
} from "./addon-changes.js";
import {
  r2UploadRoute, rateLimitHelper, d1DrizzleSchema, d1DrizzleHelper, drizzleConfig, kvCacheHelper,
  turnstileHelper, turnstileRoute, cronHelper, workersAiHelper, workersAiRoute, vectorizeHelper,
  vectorizeResourceMetadata, aiGatewayHelper, observabilityHelper, durableObjectClass,
  durableObjectRoute, workflowClass, workflowRoute, browserRunHelper, browserRunRoute, queueHelper,
  r2UploadsDoc, rateLimitDoc, d1DrizzleDoc, kvCacheDoc, turnstileDoc, cronDoc, workersAiDoc,
  vectorizeDoc, aiGatewayDoc, observabilityDoc, durableObjectDoc, workflowDoc, browserRunDoc, queueDoc
} from "./addon-templates.js";
import { configureOpenNextMainIfNeeded, customOpenNextWorkerChange } from "./addon-opennext.js";
import {
  type JsonObject,
  nextRoutePath, nextLibPath, nextDbPath,
  parseLimit, numericOption, parseVectorMetric, parseSampling,
  addUniqueStrings, upsertArrayObject, upsertDurableObjectMigration, asObject,
  sanitizeFeatureName, sanitizeQueueName, pascalCase
} from "./addon-utils.js";
import type { ChangeSet, ProjectContext } from "./types.js";
import type { AddOnOptions } from "./addon-spec.js";

export async function r2UploadsAddOn(ctx: ProjectContext): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-r2-uploads.md", r2UploadsDoc(binding, bucket, routePath), "Explain R2 uploads add-on")
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

export async function rateLimitAddOn(ctx: ProjectContext, options: AddOnOptions): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-rate-limit.md", rateLimitDoc(binding, route, parsedLimit), "Explain Rate Limiting add-on")
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

export async function d1DrizzleAddOn(ctx: ProjectContext): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-d1-drizzle.md", d1DrizzleDoc(databaseName, binding, schemaFile), "Explain D1 + Drizzle add-on")
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

export async function kvCacheAddOn(ctx: ProjectContext): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-kv-cache.md", kvCacheDoc(binding, namespaceName), "Explain KV cache add-on")
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

export async function turnstileAddOn(ctx: ProjectContext, options: AddOnOptions): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-turnstile.md", turnstileDoc(formName, routePath), "Explain Turnstile add-on")
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

export async function cronAddOn(ctx: ProjectContext, cronNameInput: string, options: AddOnOptions): Promise<ChangeSet> {
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
    await fileChange(ctx, `docs/flarecel-cron-${cronName}.md`, cronDoc(cronName, schedule), "Explain Cron Trigger add-on")
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

export async function workersAiAddOn(ctx: ProjectContext, options: AddOnOptions): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-workers-ai.md", workersAiDoc(model, routePath), "Explain Workers AI add-on")
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

export async function vectorizeAddOn(ctx: ProjectContext, indexNameInput: string, options: AddOnOptions): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-vectorize.md", vectorizeDoc(indexName, binding, dimensions, metric), "Explain Vectorize add-on")
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

export async function aiGatewayAddOn(ctx: ProjectContext, options: AddOnOptions): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-ai-gateway.md", aiGatewayDoc(provider), "Explain AI Gateway add-on")
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

export async function observabilityAddOn(ctx: ProjectContext, options: AddOnOptions): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-observability.md", observabilityDoc(sampling), "Explain observability add-on")
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

export async function durableObjectAddOn(ctx: ProjectContext, objectNameInput: string): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-durable-object.md", durableObjectDoc(objectName, binding, className, routePath), "Explain Durable Object add-on")
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

export async function workflowAddOn(ctx: ProjectContext, workflowNameInput: string, options: AddOnOptions): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-workflow.md", workflowDoc(workflowName, workflowSlug, binding, className, routePath, schedule), "Explain Workflow add-on")
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

export async function browserRunAddOn(ctx: ProjectContext): Promise<ChangeSet> {
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
    await fileChange(ctx, "docs/flarecel-browser-run.md", browserRunDoc(binding, routePath), "Explain Browser Run add-on")
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

export async function queueAddOn(ctx: ProjectContext, queueNameInput: string): Promise<ChangeSet> {
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
    await fileChange(ctx, `docs/flarecel-queue-${sanitizeQueueName(queueNameInput)}.md`, queueDoc(binding, queueName), "Explain Queue add-on")
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
