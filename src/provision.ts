import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "./redact.js";
import type { ProjectContext } from "./types.js";

export interface ProvisionAction {
  id: string;
  type: "r2" | "d1" | "kv" | "queue" | "rate-limit" | "vectorize" | "durable-object" | "workflow" | "browser-run" | "manual";
  title: string;
  command: string[];
  reason: string;
  status: "planned" | "skipped" | "succeeded" | "failed";
  stdout?: string;
  stderr?: string;
}

export interface ProvisionReport {
  status: "planned" | "empty" | "applied" | "failed";
  actions: ProvisionAction[];
  warnings: string[];
  nextActions: string[];
}

export function createProvisionPlan(ctx: ProjectContext): ProvisionReport {
  const config = ctx.wrangler.data;
  const resources = readFlarecelResources(ctx);
  const actions: ProvisionAction[] = [];
  const warnings: string[] = [];

  if (!config) {
    return {
      status: "empty",
      actions,
      warnings: ["No parseable wrangler.jsonc config found."],
      nextActions: ["flarecel fix --dry-run --format patch"]
    };
  }

  for (const bucket of objectArray(config.r2_buckets)) {
    const bucketName = stringValue(bucket.bucket_name);
    if (!bucketName) continue;

    actions.push({
      id: `r2:${bucketName}`,
      type: "r2",
      title: `Create R2 bucket ${bucketName}`,
      command: ["wrangler", "r2", "bucket", "create", bucketName],
      reason: "R2 bucket bindings need a matching remote bucket before production deploy.",
      status: "planned"
    });
  }

  for (const database of objectArray(config.d1_databases)) {
    const databaseName = stringValue(database.database_name);
    if (!databaseName) continue;

    const databaseId = stringValue(database.database_id);
    actions.push({
      id: `d1:${databaseName}`,
      type: "d1",
      title: `Create D1 database ${databaseName}`,
      command: ["wrangler", "d1", "create", databaseName],
      reason: databaseId && !databaseId.includes("replace")
        ? "D1 database binding is configured. Skip this if the database already exists."
        : "D1 database needs to be created, then its database_id must be copied into wrangler.jsonc.",
      status: "planned"
    });

    if (!databaseId || databaseId.includes("replace")) {
      warnings.push(`D1 database ${databaseName} has a placeholder database_id. Run the create command, then update wrangler.jsonc.`);
    }
  }

  for (const namespace of objectArray(config.kv_namespaces)) {
    const binding = stringValue(namespace.binding);
    if (!binding) continue;

    const namespaceId = stringValue(namespace.id);
    actions.push({
      id: `kv:${binding}`,
      type: "kv",
      title: `Create KV namespace ${binding}`,
      command: ["wrangler", "kv", "namespace", "create", binding],
      reason: namespaceId && !namespaceId.includes("replace")
        ? "KV namespace binding is configured. Skip this if the namespace already exists."
        : "KV namespace needs to be created, then its id must be copied into wrangler.jsonc.",
      status: "planned"
    });

    if (!namespaceId || namespaceId.includes("replace")) {
      warnings.push(`KV namespace ${binding} has a placeholder id. Run the create command, then update wrangler.jsonc.`);
    }
  }

  const queues = config.queues;
  if (queues && typeof queues === "object" && !Array.isArray(queues)) {
    for (const producer of objectArray((queues as Record<string, unknown>).producers)) {
      const queueName = stringValue(producer.queue);
      if (!queueName) continue;

      actions.push({
        id: `queue:${queueName}`,
        type: "queue",
        title: `Create Queue ${queueName}`,
        command: ["wrangler", "queues", "create", queueName],
        reason: "Queue producer bindings need a matching remote Queue.",
        status: "planned"
      });
    }
  }

  for (const index of objectArray(config.vectorize)) {
    const indexName = stringValue(index.index_name);
    if (!indexName) continue;

    const metadata = resources.vectorize.find((candidate) => candidate.index_name === indexName);
    if (metadata) {
      actions.push({
        id: `vectorize:${indexName}`,
        type: "vectorize",
        title: `Create Vectorize index ${indexName}`,
        command: [
          "wrangler",
          "vectorize",
          "create",
          indexName,
          `--dimensions=${metadata.dimensions}`,
          `--metric=${metadata.metric}`
        ],
        reason: "Vectorize bindings need a matching remote index before production deploy.",
        status: "planned"
      });
    } else {
      actions.push({
        id: `vectorize:${indexName}`,
        type: "vectorize",
        title: `Review Vectorize index ${indexName}`,
        command: [],
        reason: "Vectorize index is bound, but Flarecel does not know dimensions/metric. Create it manually or add .flarecel/resources.json metadata.",
        status: "skipped"
      });
    }
  }

  const durableObjects = config.durable_objects;
  if (durableObjects && typeof durableObjects === "object" && !Array.isArray(durableObjects)) {
    for (const durableObject of objectArray((durableObjects as Record<string, unknown>).bindings)) {
      const name = stringValue(durableObject.name);
      const className = stringValue(durableObject.class_name);
      if (!name) continue;

      actions.push({
        id: `durable-object:${name}`,
        type: "durable-object",
        title: `Deploy Durable Object migration for ${name}`,
        command: [],
        reason: className
          ? `Durable Object class ${className} is created by Wrangler during deploy through the configured migration tag.`
          : "Durable Object binding is present, but class_name must be reviewed before deploy.",
        status: "skipped"
      });
    }
  }

  for (const workflow of objectArray(config.workflows)) {
    const name = stringValue(workflow.name);
    if (!name) continue;

    actions.push({
      id: `workflow:${name}`,
      type: "workflow",
      title: `Deploy Workflow ${name}`,
      command: [],
      reason: "Workflows are bound from Wrangler config and become available after deploy. Use wrangler workflows commands to inspect instances.",
      status: "skipped"
    });
  }

  const browser = config.browser;
  if (browser && typeof browser === "object" && !Array.isArray(browser)) {
    const binding = stringValue((browser as Record<string, unknown>).binding);
    if (binding) {
      actions.push({
        id: `browser-run:${binding}`,
        type: "browser-run",
        title: `Review Browser Run binding ${binding}`,
        command: [],
        reason: "Browser Run is provisioned by binding config, but usage can become billable. Confirm plan, rate limits, and route access before production.",
        status: "skipped"
      });
    }
  }

  for (const limiter of objectArray(config.ratelimits)) {
    const name = stringValue(limiter.name);
    if (!name) continue;

    actions.push({
      id: `rate-limit:${name}`,
      type: "rate-limit",
      title: `Review Rate Limiting namespace ${name}`,
      command: [],
      reason: "Rate Limiting bindings are configured in Wrangler. Confirm namespace_id does not collide with another Worker unless sharing counters is intended.",
      status: "skipped"
    });
  }

  return {
    status: actions.length > 0 ? "planned" : "empty",
    actions,
    warnings,
    nextActions: actions.length > 0
      ? ["flarecel provision --apply --yes", "flarecel verify --json"]
      : ["flarecel add r2 uploads --dry-run --format patch"]
  };
}

export function applyProvisionPlan(ctx: ProjectContext, report: ProvisionReport): ProvisionReport {
  const actions: ProvisionAction[] = [];

  for (const action of report.actions) {
    if (action.command.length === 0) {
      actions.push(action);
      continue;
    }

    const [command, ...args] = action.command;
    const result = spawnSync(command, args, {
      cwd: ctx.cwd,
      encoding: "utf8"
    });

    actions.push({
      ...action,
      status: result.status === 0 ? "succeeded" : "failed",
      stdout: result.stdout ? redactSecrets(result.stdout) : result.stdout,
      stderr: redactSecrets(result.stderr || (result.error ? result.error.message : ""))
    });
  }

  return {
    ...report,
    status: actions.some((action) => action.status === "failed") ? "failed" : "applied",
    actions,
    nextActions: [
      "Update any placeholder database_id values from Wrangler output.",
      "flarecel verify --json"
    ]
  };
}

function objectArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is Record<string, unknown> => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate))
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface FlarecelResources {
  vectorize: Array<{
    index_name: string;
    dimensions: number;
    metric: string;
  }>;
}

function readFlarecelResources(ctx: ProjectContext): FlarecelResources {
  const empty: FlarecelResources = { vectorize: [] };
  const resourcesPath = path.join(ctx.cwd, ".flarecel", "resources.json");

  if (!existsSync(resourcesPath)) return empty;

  try {
    const parsed = JSON.parse(readFileSync(resourcesPath, "utf8")) as {
      resources?: {
        vectorize?: unknown;
      };
    };

    return {
      vectorize: objectArray(parsed.resources?.vectorize)
        .map((candidate) => ({
          index_name: stringValue(candidate.index_name) ?? "",
          dimensions: typeof candidate.dimensions === "number" ? candidate.dimensions : 0,
          metric: stringValue(candidate.metric) ?? ""
        }))
        .filter((candidate) => candidate.index_name && candidate.dimensions > 0 && candidate.metric)
    };
  } catch {
    return empty;
  }
}
