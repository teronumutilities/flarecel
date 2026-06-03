import { createInterface } from "node:readline";
import path from "node:path";
import { createCostEstimate } from "./cost.js";
import { createDeployPlan, executeDeployPlan } from "./deploy.js";
import { runDoctor } from "./doctor.js";
import { applyChangeSet, renderPatch } from "./patches.js";
import { createPlan } from "./plan.js";
import { detectProject } from "./project.js";
import { createProvisionPlan } from "./provision.js";
import { createFixChangeSet, createRecipeChangeSet } from "./recipes.js";
import { runVerify } from "./verify.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface ToolCallParams {
  name?: string;
  arguments?: Record<string, unknown>;
}

const TOOL_DEFINITIONS = [
  {
    name: "detect_project",
    title: "Detect Project",
    description: "Detect framework, package manager, Wrangler config, and Cloudflare-relevant project metadata.",
    inputSchema: cwdSchema()
  },
  {
    name: "run_doctor",
    title: "Run Doctor",
    description: "Run Flarecel's Cloudflare readiness checks and return structured issues and next actions.",
    inputSchema: cwdSchema()
  },
  {
    name: "generate_plan",
    title: "Generate Plan",
    description: "Generate a step-by-step Cloudflare readiness plan for the current project.",
    inputSchema: cwdSchema()
  },
  {
    name: "preview_patch",
    title: "Preview Patch",
    description: "Generate a dry-run patch for fix or add recipe operations. Does not write files.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        operation: { type: "string", enum: ["fix", "add"], default: "fix" },
        recipe: { type: "string", description: "Recipe name for add operations, such as next-opennext, r2, db, kv, rate-limit, queue, turnstile, cron, workers-ai, vectorize, ai-gateway, observability, durable-object, workflow, browser-run, or auth." },
        positionals: { type: "array", items: { type: "string" }, default: [] },
        flags: { type: "object", additionalProperties: true, default: {} }
      }
    }
  },
  {
    name: "apply_patch",
    title: "Apply Patch",
    description: "Apply a Flarecel-generated fix or recipe. Requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        operation: { type: "string", enum: ["fix", "add"], default: "fix" },
        recipe: { type: "string" },
        positionals: { type: "array", items: { type: "string" }, default: [] },
        flags: { type: "object", additionalProperties: true, default: {} },
        confirm: { type: "boolean", description: "Must be true to write files." }
      },
      required: ["confirm"]
    }
  },
  {
    name: "verify_project",
    title: "Verify Project",
    description: "Run post-patch verification checks and return structured status.",
    inputSchema: cwdSchema()
  },
  {
    name: "plan_provisioning",
    title: "Plan Provisioning",
    description: "Read Wrangler config and return the Cloudflare resource commands required for bindings.",
    inputSchema: cwdSchema()
  },
  {
    name: "estimate_cost",
    title: "Estimate Cost",
    description: "Estimate monthly Cloudflare Workers/R2/D1/Queues cost from user-provided usage assumptions.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        plan: { type: "string", enum: ["free", "paid"], default: "paid" },
        requests: { type: "string", description: "Dynamic Worker requests per month." },
        "cpu-ms": { type: "string", description: "Average CPU milliseconds per dynamic request." },
        "r2-storage-gb": { type: "string" },
        "r2-class-a": { type: "string" },
        "r2-class-b": { type: "string" },
        "d1-reads": { type: "string" },
        "d1-writes": { type: "string" },
        "d1-storage-gb": { type: "string" },
        "kv-reads": { type: "string" },
        "kv-writes": { type: "string" },
        "kv-deletes": { type: "string" },
        "kv-lists": { type: "string" },
        "kv-storage-gb": { type: "string" },
        "queue-ops": { type: "string" },
        "workers-ai-neurons": { type: "string" },
        "vectorize-queries": { type: "string" },
        "vectorize-stored-vectors": { type: "string" },
        "vectorize-dimensions": { type: "string" },
        "durable-object-requests": { type: "string" },
        "durable-object-duration-gb-s": { type: "string" },
        "durable-object-storage-gb": { type: "string" },
        "durable-object-rows-read": { type: "string" },
        "durable-object-rows-written": { type: "string" },
        "workflow-requests": { type: "string" },
        "workflow-cpu-ms": { type: "string" },
        "workflow-storage-gb": { type: "string" },
        "browser-run-hours": { type: "string" },
        "browser-run-concurrency": { type: "string" }
      }
    }
  },
  {
    name: "deploy_preview",
    title: "Deploy Preview",
    description: "Plan or execute a preview upload. Execution requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        confirm: { type: "boolean", description: "Must be true to execute the deploy command." }
      }
    }
  },
  {
    name: "list_recipes",
    title: "List Recipes",
    description: "List available Flarecel recipes and their current maturity.",
    inputSchema: { type: "object", properties: {} }
  }
];

export async function startMcpServer(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      });
      continue;
    }

    await handleRequest(request);
  }
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  if (request.method === "notifications/initialized") return;

  try {
    if (request.method === "initialize") {
      writeResult(request.id, {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: "flarecel",
          version: "0.0.0"
        }
      });
      return;
    }

    if (request.method === "tools/list") {
      writeResult(request.id, { tools: TOOL_DEFINITIONS });
      return;
    }

    if (request.method === "tools/call") {
      const params = asObject(request.params) as ToolCallParams;
      const result = await callTool(params.name ?? "", asObject(params.arguments));
      writeResult(request.id, result);
      return;
    }

    writeError(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    writeError(request.id, -32603, error instanceof Error ? error.message : String(error));
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "list_recipes") {
    return toolResult({
      recipes: [
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
        { name: "auth better-auth --db d1 --orm drizzle", maturity: "mvp", writesFiles: true }
      ]
    });
  }

  const cwd = path.resolve(typeof args.cwd === "string" ? args.cwd : process.cwd());
  const ctx = await detectProject(cwd);

  if (name === "detect_project") {
    return toolResult({
      cwd: ctx.cwd,
      framework: ctx.framework,
      packageManager: ctx.packageManager,
      hasOpenNext: ctx.hasOpenNext,
      wranglerConfig: ctx.wrangler.path,
      sourceRisks: ctx.sourceRisks
    });
  }

  if (name === "run_doctor") {
    return toolResult(runDoctor(ctx));
  }

  if (name === "generate_plan") {
    return toolResult(createPlan(runDoctor(ctx)));
  }

  if (name === "preview_patch") {
    const changeSet = await createChangeSet(ctx, args);
    return toolResult({
      ...changeSet,
      patch: renderPatch(changeSet.changes)
    }, changeSet.status === "error");
  }

  if (name === "apply_patch") {
    if (args.confirm !== true) {
      return toolResult({ status: "blocked", message: "apply_patch requires confirm=true." }, true);
    }

    const changeSet = await createChangeSet(ctx, args);
    if (changeSet.status === "error") return toolResult(changeSet, true);
    return toolResult(await applyChangeSet(ctx.cwd, changeSet));
  }

  if (name === "verify_project") {
    return toolResult(runVerify(ctx));
  }

  if (name === "plan_provisioning") {
    return toolResult(createProvisionPlan(ctx));
  }

  if (name === "estimate_cost") {
    return toolResult(createCostEstimate(ctx, normalizeFlags(args)));
  }

  if (name === "deploy_preview") {
    const plan = createDeployPlan(ctx, { mode: "preview" });
    if (args.confirm !== true) return toolResult(plan);
    return toolResult(executeDeployPlan(ctx, plan));
  }

  return toolResult({ message: `Unknown tool: ${name}` }, true);
}

async function createChangeSet(ctx: Awaited<ReturnType<typeof detectProject>>, args: Record<string, unknown>) {
  const operation = args.operation === "add" ? "add" : "fix";

  if (operation === "fix") {
    return createFixChangeSet(ctx, runDoctor(ctx));
  }

  const recipe = typeof args.recipe === "string" ? args.recipe : "";
  const positionals = Array.isArray(args.positionals)
    ? args.positionals.filter((value): value is string => typeof value === "string")
    : [];

  return createRecipeChangeSet(ctx, recipe, {
    positionals,
    flags: normalizeFlags(args.flags)
  });
}

function toolResult(structuredContent: unknown, isError = false): unknown {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent,
    isError
  };
}

function cwdSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      cwd: {
        type: "string",
        description: "Project working directory. Defaults to the MCP server process cwd."
      }
    }
  };
}

function normalizeFlags(value: unknown): Record<string, string | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const flags: Record<string, string | boolean> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate === "string" || typeof candidate === "boolean") flags[key] = candidate;
  }
  return flags;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function writeResult(id: JsonRpcRequest["id"], result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id: JsonRpcRequest["id"], code: number, message: string): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
