import { createInterface } from "node:readline";
import path from "node:path";
import { listAddOns } from "./addons.js";
import { createCostEstimate } from "./cost.js";
import { fetchVercelUsage } from "./vercel-usage.js";
import { createDeployPlan, executeDeployPlan } from "./deploy.js";
import { diagnoseError } from "./diagnose.js";
import { createEnvReport } from "./env.js";
import { runDoctor } from "./doctor.js";
import { explainIssue, listExplainableIds } from "./explain.js";
import { createComposeChangeSet, type ComposeStep } from "./compose.js";
import { writeManifest } from "./manifest.js";
import { createVercelMigration } from "./migrate.js";
import { applyChangeSet, renderPatch } from "./patches.js";
import { createPlan } from "./plan.js";
import { detectProject } from "./project.js";
import { createProgress } from "./progress.js";
import { createProvisionPlan } from "./provision.js";
import { createFixChangeSet, createAddOnChangeSet } from "./addon-dispatch.js";
import { runVerify } from "./verify.js";
import { vercelAuthStatus } from "./auth-status.js";
import { listCatalog } from "./user-addons.js";

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

const MCP_PROMPTS = [
  { name: "audit-readiness", description: "Guide the agent through a full Cloudflare readiness audit.", text: "Run `flarecel doctor --json`. For each blocking or high issue, run `flarecel explain <id>`. Then run `flarecel fix --dry-run --format patch` to preview fixes. Apply with `fix --apply --yes`, then verify with `flarecel verify --json`." },
  { name: "migrate-from-vercel", description: "Migrate a Vercel Next.js app to Cloudflare Workers.", text: "Run `flarecel migrate vercel --dry-run --json` to see what translates and what is flagged, even if there is no vercel.json. Run `flarecel env --json` and `flarecel secrets plan --json` before deploy. Apply translation with `--apply --yes`. Then run `flarecel doctor --json` to check remaining issues. Use `flarecel add next-opennext --dry-run` for the OpenNext adapter." },
  { name: "plan-saas-stack", description: "Plan a full SaaS stack on Cloudflare.", text: "Compose the add-ons you need into one reviewable change set: `flarecel compose next-opennext + auth better-auth + r2 uploads + queue emails + rate-limit + turnstile + observability --dry-run --json`. Review all files, then re-run with `--apply --yes`. Agents can call the `preview_compose` MCP tool with a structured addOns array instead. Then `flarecel provision --json` to see what Cloudflare resources need creating." },
  { name: "explain-deploy-failure", description: "Diagnose a deploy or runtime error.", text: "Pipe the error into `flarecel diagnose` or pass it as an argument: `flarecel diagnose \"<error text>\" --json`. It maps errors to known issues and suggests fixes. Use `flarecel explain <issue-id>` for plain-language details." }
];

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
    name: "get_progress",
    title: "Get Progress",
    description: "Return the plain-language onboarding/progress map: diagnose, patch, verify, provision, preview, and production gates.",
    inputSchema: cwdSchema()
  },
  {
    name: "preview_patch",
    title: "Preview Patch",
    description: "Generate a dry-run patch for fix or add add-on operations. Does not write files.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        operation: { type: "string", enum: ["fix", "add"], default: "fix" },
        addOn: { type: "string", description: "Add-on name for add operations, such as next-opennext, r2, db, kv, rate-limit, queue, turnstile, cron, workers-ai, vectorize, ai-gateway, observability, durable-object, workflow, browser-run, or auth." },
        recipe: { type: "string", description: "Legacy alias for addOn (kept for older agents)." },
        positionals: { type: "array", items: { type: "string" }, default: [] },
        flags: { type: "object", additionalProperties: true, default: {} }
      }
    }
  },
  {
    name: "preview_compose",
    title: "Preview Compose",
    description: "Compose multiple add-ons into one dry-run patch. Add-ons accumulate into a single reviewable change set (shared files like package.json and wrangler.jsonc are merged, not clobbered).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        addOns: {
          type: "array",
          description: "Ordered add-ons to compose. Each item is an add-on name plus optional positionals/flags.",
          items: {
            type: "object",
            properties: {
              addOn: { type: "string", description: "Add-on name, e.g. next-opennext, r2, db, kv, auth." },
              positionals: { type: "array", items: { type: "string" }, default: [] },
              flags: { type: "object", additionalProperties: true, default: {} }
            },
            required: ["addOn"]
          }
        }
      },
      required: ["addOns"]
    }
  },
  {
    name: "migrate_vercel",
    title: "Migrate Vercel",
    description: "Generate a dry-run migration patch for Vercel config and env key names.",
    inputSchema: cwdSchema()
  },
  {
    name: "audit_env",
    title: "Audit Environment",
    description: "Audit env names from common env files/source usage, classify public/config/secret, and never return values.",
    inputSchema: cwdSchema()
  },
  {
    name: "plan_secrets",
    title: "Plan Secrets",
    description: "Return secret-looking env names and exact wrangler secret put commands. Values are never read or returned.",
    inputSchema: cwdSchema()
  },
  {
    name: "explain_issue",
    title: "Explain Issue",
    description: "Explain a Flarecel doctor issue id in plain language. Omit id to list explainable ids.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      }
    }
  },
  {
    name: "diagnose_error",
    title: "Diagnose Error",
    description: "Map pasted deploy/runtime error text to known Flarecel issue ids and suggested commands.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" }
      },
      required: ["text"]
    }
  },
  {
    name: "apply_patch",
    title: "Apply Patch",
    description: "Apply a Flarecel-generated fix or add-on. Requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        operation: { type: "string", enum: ["fix", "add"], default: "fix" },
        addOn: { type: "string" },
        recipe: { type: "string", description: "Legacy alias for addOn (kept for older agents)." },
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
        plan: { type: "string", enum: ["free", "paid"], description: "Pin the Cloudflare plan. Omit to get an honest UNKNOWN baseline range ($0 Free floor to $5+ Paid) with low confidence instead of a single assumed number." },
        compare: { type: "string", enum: ["vercel"], description: "Add a labeled Vercel cost comparison." },
        "vercel-monthly-usd": { type: "string", description: "Your real Vercel monthly bill, to compare exactly." },
        live: { type: "boolean", description: "With compare:vercel, pull your real bill via the local `vercel usage` CLI (opt-in; spawns a subprocess). Without live or vercel-monthly-usd, no Vercel comparison is shown." },
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
    description: "List available Flarecel add-ons and their current maturity. The tool name is kept for compatibility.",
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
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false }
        },
        serverInfo: {
          name: "flarecel",
          version: "0.1.0-alpha.0"
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

    if (request.method === "resources/list") {
      const resources = [
        { uri: "file://wrangler.jsonc", name: "Wrangler config", mimeType: "application/json" },
        { uri: "file://cloudflare-env.d.ts", name: "CloudflareEnv types", mimeType: "text/typescript" },
        { uri: "file://package.json", name: "package.json", mimeType: "application/json" }
      ];
      writeResult(request.id, { resources });
      return;
    }

    if (request.method === "resources/read") {
      const params = asObject(request.params);
      const uri = typeof params.uri === "string" ? params.uri : "";
      const relativePath = uri.replace("file://", "");
      const cwd = process.cwd();
      try {
        const { readFileSync } = await import("node:fs");
        const content = readFileSync(path.join(cwd, relativePath), "utf8");
        writeResult(request.id, { contents: [{ uri, text: content }] });
      } catch {
        writeError(request.id, -32602, `Cannot read resource: ${uri}`);
      }
      return;
    }

    if (request.method === "prompts/list") {
      writeResult(request.id, { prompts: MCP_PROMPTS.map((p) => ({ name: p.name, description: p.description })) });
      return;
    }

    if (request.method === "prompts/get") {
      const params = asObject(request.params);
      const name = typeof params.name === "string" ? params.name : "";
      const prompt = MCP_PROMPTS.find((p) => p.name === name);
      if (!prompt) { writeError(request.id, -32602, `Unknown prompt: ${name}`); return; }
      writeResult(request.id, { messages: [{ role: "user", content: { type: "text", text: prompt.text } }] });
      return;
    }

    writeError(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    writeError(request.id, -32603, error instanceof Error ? error.message : String(error));
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === "list_recipes") {
    const cwd = path.resolve(typeof args.cwd === "string" ? args.cwd : process.cwd());
    const builtIns = listAddOns();
    let catalog;
    try {
      catalog = listCatalog(cwd, builtIns);
    } catch (error) {
      return toolResult({ message: error instanceof Error ? error.message : String(error) }, true);
    }
    const builtInByName = new Map(builtIns.map((entry) => [entry.name, entry]));
    const addOns = catalog.map((entry) => ({
      ...entry,
      maturity: builtInByName.get(entry.name)?.maturity ?? "experimental",
      writesFiles: builtInByName.get(entry.name)?.writesFiles ?? true
    }));
    return toolResult({
      vocabulary: {
        userFacingName: "add-on",
        legacyName: "recipe",
        note: "Use add-on in UI/docs. The MCP tool remains list_recipes for older agents."
      },
      addOns,
      recipes: addOns
    });
  }

  if (name === "explain_issue") {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) {
      return toolResult({ ids: listExplainableIds() });
    }
    const explanation = explainIssue(id);
    return explanation
      ? toolResult(explanation)
      : toolResult({ message: `No explanation for "${id}".`, ids: listExplainableIds() }, true);
  }

  if (name === "diagnose_error") {
    const text = typeof args.text === "string" ? args.text : "";
    if (!text) return toolResult({ message: "diagnose_error requires text." }, true);
    return toolResult({ matches: diagnoseError(text) });
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

  if (name === "get_progress") {
    return toolResult(createProgress(ctx));
  }

  if (name === "preview_patch") {
    const changeSet = await createChangeSet(ctx, args);
    return toolResult({
      ...changeSet,
      patch: renderPatch(changeSet.changes)
    }, changeSet.status === "error");
  }

  if (name === "preview_compose") {
    const raw = Array.isArray(args.addOns) ? args.addOns : [];
    const steps: ComposeStep[] = raw
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        addOn: typeof item.addOn === "string" ? item.addOn : "",
        positionals: Array.isArray(item.positionals)
          ? item.positionals.filter((value): value is string => typeof value === "string")
          : [],
        flags: normalizeFlags(item.flags)
      }))
      .filter((step) => step.addOn);
    if (steps.length === 0) return toolResult({ message: "preview_compose requires a non-empty addOns array." }, true);
    const changeSet = await createComposeChangeSet(ctx, steps);
    return toolResult({
      ...changeSet,
      patch: renderPatch(changeSet.changes)
    }, changeSet.status === "error");
  }

  if (name === "migrate_vercel") {
    const changeSet = await createVercelMigration(ctx);
    return toolResult({
      ...changeSet,
      patch: renderPatch(changeSet.changes)
    }, changeSet.status === "error");
  }

  if (name === "audit_env") {
    return toolResult(await createEnvReport(ctx));
  }

  if (name === "plan_secrets") {
    return toolResult(await createEnvReport(ctx, { secretsOnly: true }));
  }

  if (name === "apply_patch") {
    if (args.confirm !== true) {
      return toolResult({ status: "blocked", message: "apply_patch requires confirm=true." }, true);
    }

    const changeSet = await createChangeSet(ctx, args);
    if (changeSet.status === "error") return toolResult(changeSet, true);
    const applied = await applyChangeSet(ctx.cwd, changeSet);
    const addOn = typeof args.addOn === "string" ? args.addOn
      : typeof args.recipe === "string" ? args.recipe : "";
    if (args.operation === "add" && addOn && applied.status === "applied") {
      await writeManifest(ctx.cwd, addOn, changeSet);
    }
    return toolResult(applied);
  }

  if (name === "verify_project") {
    return toolResult(runVerify(ctx));
  }

  if (name === "plan_provisioning") {
    return toolResult(createProvisionPlan(ctx));
  }

  if (name === "estimate_cost") {
    const flags = normalizeFlags(args);
    let vercelAuth;
    // opt-in only: agent must pass live:true AND compare:"vercel". This is the
    // only path that spawns the `vercel` CLI; absent the flag, never shells out.
    if (args.live === true && flags.compare === "vercel" && typeof flags["vercel-monthly-usd"] !== "string") {
      vercelAuth = vercelAuthStatus(ctx.cwd, 3000);
      if (vercelAuth.state === "in") {
        const usage = await fetchVercelUsage(ctx.cwd);
        if (usage) flags["vercel-live-usd"] = String(usage.monthlyUsd);
      }
    }
    const report = createCostEstimate(ctx, flags);
    if (vercelAuth) report.vercelAuth = vercelAuth;
    return toolResult(report);
  }

  if (name === "deploy_preview") {
    const plan = createDeployPlan(ctx, { mode: "preview" });
    if (args.confirm !== true) return toolResult(plan);
    return toolResult(await executeDeployPlan(ctx, plan));
  }

  return toolResult({ message: `Unknown tool: ${name}` }, true);
}

async function createChangeSet(ctx: Awaited<ReturnType<typeof detectProject>>, args: Record<string, unknown>) {
  const operation = args.operation === "add" ? "add" : "fix";

  if (operation === "fix") {
    return createFixChangeSet(ctx, runDoctor(ctx));
  }

  // accept `addOn` (current) or `recipe` (legacy alias) for older agents.
  const addOn = typeof args.addOn === "string" ? args.addOn
    : typeof args.recipe === "string" ? args.recipe : "";
  const positionals = Array.isArray(args.positionals)
    ? args.positionals.filter((value): value is string => typeof value === "string")
    : [];

  return createAddOnChangeSet(ctx, addOn, {
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
