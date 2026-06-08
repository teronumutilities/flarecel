import type { ProjectContext } from "./types.js";
import type { LoginStatus } from "./auth-status.js";

export interface CostSource {
  name: string;
  url: string;
}

export interface CostLineItem {
  id: string;
  label: string;
  usage: number;
  unit: string;
  included: number | "unlimited";
  rateUsd: number;
  billable: number;
  estimatedUsd: number;
  formula: string;
}

export interface CostReport {
  status: "estimate";
  plan: "free" | "paid" | "unknown";
  planAssumed: boolean;
  planConfidence: "low" | "medium" | "high";
  estimateIsRange: boolean;
  usageSource: "assumed" | "cloudflare-live";
  usageWindowDays?: number;
  currency: "USD";
  recommendedDisplay: string;
  recommendedEstimateKind: "single" | "range";
  costBasis: "explicit-free" | "explicit-paid" | "live-paid" | "unknown-plan-range";
  project: {
    name: string | null;
    framework: string;
  };
  assumptions: Record<string, number | string>;
  detectedBindings: string[];
  lineItems: CostLineItem[];
  estimatedMonthlyUsd: number;
  estimatedMonthlyUsdLow: number;
  estimatedMonthlyUsdHigh: number;
  pricingVerifiedOn: string;
  billShockRisks: string[];
  vercelComparison?: VercelComparison;
  vercelAuth?: LoginStatus;
  warnings: string[];
  sources: CostSource[];
  nextActions: string[];
}

export interface VercelComparison {
  disclaimer: string;
  vercelMonthlyUsd: number;
  cloudflareMonthlyUsd: number;
  monthlyDeltaUsd: number;
  savingsPct: number;
  source: "user-provided" | "vercel-cli";
  assumptions: Record<string, number | string>;
}

const PRICING_VERIFIED_ON = "2026-06-04";

const SOURCES: CostSource[] = [
  {
    name: "Cloudflare Workers pricing",
    url: "https://developers.cloudflare.com/workers/platform/pricing/"
  },
  {
    name: "Cloudflare R2 pricing",
    url: "https://developers.cloudflare.com/r2/pricing/"
  },
  {
    name: "Cloudflare D1 pricing",
    url: "https://developers.cloudflare.com/d1/platform/pricing/"
  },
  {
    name: "Cloudflare Workers KV pricing",
    url: "https://developers.cloudflare.com/kv/platform/pricing/"
  },
  {
    name: "Cloudflare Workers AI pricing",
    url: "https://developers.cloudflare.com/workers-ai/platform/pricing/"
  },
  {
    name: "Cloudflare Vectorize pricing",
    url: "https://developers.cloudflare.com/vectorize/platform/pricing/"
  },
  {
    name: "Cloudflare Durable Objects pricing",
    url: "https://developers.cloudflare.com/durable-objects/platform/pricing/"
  },
  {
    name: "Cloudflare Workflows pricing",
    url: "https://developers.cloudflare.com/workflows/reference/pricing/"
  },
  {
    name: "Cloudflare Browser Run pricing",
    url: "https://developers.cloudflare.com/browser-run/pricing/"
  }
];

export interface LiveUsage {
  requests: number;
  avgCpuMs: number;
  windowDays: number;
}

export function createCostEstimate(
  ctx: ProjectContext,
  flags: Record<string, string | boolean> = {},
  liveUsage?: LiveUsage
): CostReport {
  const planFlag = stringFlag(flags, "plan");
  const explicitPlan = planFlag === "free" || planFlag === "paid";
  // planAssumed stays true whenever the user did not explicitly pass --plan,
  // including the live path where we assume the conservative paid floor.
  const planAssumed = !explicitPlan;
  const usageSource = liveUsage ? "cloudflare-live" : "assumed";

  // plan resolution. We refuse to confidently assume Workers Paid when we have
  // no signal: explicit --plan wins; --cloudflare-live (real usage) takes the
  // conservative paid floor; otherwise the plan is honestly UNKNOWN.
  let plan: "free" | "paid" | "unknown";
  let planConfidence: "low" | "medium" | "high";
  if (planFlag === "free") {
    plan = "free";
    planConfidence = liveUsage ? "high" : "medium";
  } else if (planFlag === "paid") {
    plan = "paid";
    planConfidence = liveUsage ? "high" : "medium";
  } else if (liveUsage) {
    plan = "paid";
    planConfidence = "high";
  } else {
    plan = "unknown";
    planConfidence = "low";
  }
  // live Workers usage (real requests + CPU from your account) overrides the
  // assumed defaults. Other bindings still use flags until their live meters
  // are wired, so they stay clearly assumed.
  const dynamicRequests = liveUsage ? Math.round(liveUsage.requests) : numberFlag(flags, "requests", 1_000_000);
  const staticRequests = numberFlag(flags, "static-requests", 0);
  const avgCpuMs = liveUsage ? liveUsage.avgCpuMs : numberFlag(flags, "cpu-ms", 7);
  const r2StorageGb = numberFlag(flags, "r2-storage-gb", 0);
  const r2ClassA = numberFlag(flags, "r2-class-a", 0);
  const r2ClassB = numberFlag(flags, "r2-class-b", 0);
  const d1Reads = numberFlag(flags, "d1-reads", 0);
  const d1Writes = numberFlag(flags, "d1-writes", 0);
  const d1StorageGb = numberFlag(flags, "d1-storage-gb", 0);
  const kvReads = numberFlag(flags, "kv-reads", 0);
  const kvWrites = numberFlag(flags, "kv-writes", 0);
  const kvDeletes = numberFlag(flags, "kv-deletes", 0);
  const kvLists = numberFlag(flags, "kv-lists", 0);
  const kvStorageGb = numberFlag(flags, "kv-storage-gb", 0);
  const queueOps = numberFlag(flags, "queue-ops", 0);
  const workersAiNeurons = numberFlag(flags, "workers-ai-neurons", 0);
  const vectorizeQueries = numberFlag(flags, "vectorize-queries", 0);
  const vectorizeStoredVectors = numberFlag(flags, "vectorize-stored-vectors", 0);
  const vectorizeDimensions = numberFlag(flags, "vectorize-dimensions", 768);
  const durableObjectRequests = numberFlag(flags, "durable-object-requests", 0);
  const durableObjectDurationGbSeconds = numberFlag(flags, "durable-object-duration-gb-s", 0);
  const durableObjectStorageGb = numberFlag(flags, "durable-object-storage-gb", 0);
  const durableObjectRowsRead = numberFlag(flags, "durable-object-rows-read", 0);
  const durableObjectRowsWritten = numberFlag(flags, "durable-object-rows-written", 0);
  const workflowRequests = numberFlag(flags, "workflow-requests", 0);
  const workflowCpuMs = numberFlag(flags, "workflow-cpu-ms", 0);
  const workflowStorageGb = numberFlag(flags, "workflow-storage-gb", 0);
  const browserRunHours = numberFlag(flags, "browser-run-hours", 0);
  const browserRunConcurrency = numberFlag(flags, "browser-run-concurrency", 0);

  const lineItems: CostLineItem[] = [];
  const warnings = [
    "This is an estimate for planning, not a billing guarantee.",
    "Cloudflare pricing changes over time. Re-check source URLs before making business decisions."
  ];
  if (liveUsage) {
    warnings.push(`Workers, R2, D1, and KV usage are your REAL numbers from the last ${liveUsage.windowDays} days (Cloudflare GraphQL Analytics), priced with published rates. Bindings with no recorded usage show zero. Other products not yet wired stay assumptions.`);
  }
  const detectedBindings = detectBillableBindings(ctx);

  // Workers platform charges. The $5 Paid subscription is only a real line item
  // when we know (or assume via --cloudflare-live) the Paid plan. For an UNKNOWN
  // plan we keep request/CPU OVERAGE math (so heavy usage still shows) but fold
  // the $5 floor into the range high instead of asserting it as a fact. Free
  // bills no overage — it caps — so it gets neither.
  if (plan === "paid") {
    lineItems.push(fixed("workers-paid-subscription", "Workers Paid minimum monthly charge", 5));
  }
  if (plan === "paid" || plan === "unknown") {
    lineItems.push(metered(
      "workers-requests",
      "Dynamic Worker requests",
      dynamicRequests,
      "requests/month",
      10_000_000,
      0.30,
      1_000_000
    ));
    lineItems.push(metered(
      "workers-cpu",
      "Worker CPU time",
      dynamicRequests * avgCpuMs,
      "CPU ms/month",
      30_000_000,
      0.02,
      1_000_000
    ));
  }
  if (plan === "unknown") {
    warnings.push("Plan is UNKNOWN \u2014 Flarecel did not detect or assume a Cloudflare plan. Workers Free may be $0/mo for testing and low traffic; Workers Paid starts at $5/mo before usage. The figure below is a baseline range, not a single guaranteed number. Pass --plan free or --plan paid to pin it, or --cloudflare-live to price real account usage.");
  }
  if (plan === "free" || plan === "unknown") {
    if (dynamicRequests > 3_000_000) {
      warnings.push("Workers Free has a 100,000 requests/day limit. Monthly totals above roughly 3,000,000 may fail instead of billing overage.");
    }
    if (avgCpuMs > 10) {
      warnings.push("Workers Free allows 10 ms CPU time per invocation. Higher CPU usage may need the Paid plan.");
    }
  }

  lineItems.push(metered("r2-storage", "R2 Standard storage", r2StorageGb, "GB-month", 10, 0.015, 1));
  lineItems.push(metered("r2-class-a", "R2 Class A operations", r2ClassA, "operations/month", 1_000_000, 4.50, 1_000_000));
  lineItems.push(metered("r2-class-b", "R2 Class B operations", r2ClassB, "operations/month", 10_000_000, 0.36, 1_000_000));
  lineItems.push(metered("d1-reads", "D1 rows read", d1Reads, "rows/month", 25_000_000_000, 0.001, 1_000_000));
  lineItems.push(metered("d1-writes", "D1 rows written", d1Writes, "rows/month", 50_000_000, 1.00, 1_000_000));
  lineItems.push(metered("d1-storage", "D1 storage", d1StorageGb, "GB-month", 5, 0.75, 1));
  lineItems.push(metered("kv-reads", "KV read operations", kvReads, "operations/month", 10_000_000, 0.50, 1_000_000));
  lineItems.push(metered("kv-writes", "KV write operations", kvWrites, "operations/month", 1_000_000, 5.00, 1_000_000));
  lineItems.push(metered("kv-deletes", "KV delete operations", kvDeletes, "operations/month", 1_000_000, 5.00, 1_000_000));
  lineItems.push(metered("kv-lists", "KV list operations", kvLists, "operations/month", 1_000_000, 5.00, 1_000_000));
  lineItems.push(metered("kv-storage", "KV stored data", kvStorageGb, "GB-month", 1, 0.50, 1));
  lineItems.push(metered("queues-ops", "Queues operations", queueOps, "operations/month", 1_000_000, 0.40, 1_000_000));
  lineItems.push(metered("workers-ai-neurons", "Workers AI neurons", workersAiNeurons, "neurons/month", 300_000, 0.011, 1_000));
  lineItems.push(...vectorizeLineItems(vectorizeQueries, vectorizeStoredVectors, vectorizeDimensions));
  lineItems.push(metered("durable-object-requests", "Durable Object requests", durableObjectRequests, "requests/month", 1_000_000, 0.15, 1_000_000));
  lineItems.push(metered("durable-object-duration", "Durable Object duration", durableObjectDurationGbSeconds, "GB-s/month", 400_000, 12.50, 1_000_000));
  lineItems.push(metered("durable-object-storage", "Durable Object SQLite storage", durableObjectStorageGb, "GB-month", 5, 0.20, 1));
  lineItems.push(metered("durable-object-rows-read", "Durable Object SQLite rows read", durableObjectRowsRead, "rows/month", 25_000_000_000, 0.001, 1_000_000));
  lineItems.push(metered("durable-object-rows-written", "Durable Object SQLite rows written", durableObjectRowsWritten, "rows/month", 50_000_000, 1.00, 1_000_000));
  lineItems.push(metered("workflow-requests", "Workflow requests", workflowRequests, "requests/month", 10_000_000, 0.30, 1_000_000));
  lineItems.push(metered("workflow-cpu", "Workflow CPU time", workflowCpuMs, "CPU ms/month", 30_000_000, 0.02, 1_000_000));
  lineItems.push(metered("workflow-storage", "Workflow state storage", workflowStorageGb, "GB-month", 1, 0.20, 1));
  lineItems.push(metered("browser-run-hours", "Browser Run browser time", browserRunHours, "hours/month", 10, 0.09, 1));
  lineItems.push(metered("browser-run-concurrency", "Browser Run averaged concurrency", browserRunConcurrency, "concurrent browsers/month", 10, 2.00, 1));

  if (staticRequests > 0) {
    lineItems.push({
      id: "static-assets",
      label: "Static asset requests",
      usage: staticRequests,
      unit: "requests/month",
      included: "unlimited",
      rateUsd: 0,
      billable: 0,
      estimatedUsd: 0,
      formula: "Static asset requests are treated as free/unlimited in Workers pricing docs."
    });
  }

  if (detectedBindings.includes("r2") && r2StorageGb + r2ClassA + r2ClassB === 0) {
    warnings.push("R2 binding detected. Pass --r2-storage-gb, --r2-class-a, and --r2-class-b for a more useful estimate.");
  }
  if (detectedBindings.includes("d1") && d1Reads + d1Writes + d1StorageGb === 0) {
    warnings.push("D1 binding detected. Pass --d1-reads, --d1-writes, and --d1-storage-gb for a more useful estimate.");
  }
  if (detectedBindings.includes("kv") && kvReads + kvWrites + kvDeletes + kvLists + kvStorageGb === 0) {
    warnings.push("KV binding detected. Pass --kv-reads, --kv-writes, --kv-deletes, --kv-lists, and --kv-storage-gb for a more useful estimate.");
  }
  if (detectedBindings.includes("queues") && queueOps === 0) {
    warnings.push("Queue binding detected. Pass --queue-ops for a more useful estimate.");
  }
  if (detectedBindings.includes("workers-ai") && workersAiNeurons === 0) {
    warnings.push("Workers AI binding detected. Pass --workers-ai-neurons for a more useful estimate.");
  }
  if (detectedBindings.includes("vectorize") && vectorizeQueries + vectorizeStoredVectors === 0) {
    warnings.push("Vectorize binding detected. Pass --vectorize-queries, --vectorize-stored-vectors, and --vectorize-dimensions for a more useful estimate.");
  }
  if (detectedBindings.includes("durable-objects") && durableObjectRequests + durableObjectDurationGbSeconds + durableObjectStorageGb + durableObjectRowsRead + durableObjectRowsWritten === 0) {
    warnings.push("Durable Object binding detected. Pass --durable-object-requests, --durable-object-duration-gb-s, --durable-object-storage-gb, --durable-object-rows-read, and --durable-object-rows-written for a more useful estimate.");
  }
  if (detectedBindings.includes("workflows") && workflowRequests + workflowCpuMs + workflowStorageGb === 0) {
    warnings.push("Workflow binding detected. Pass --workflow-requests, --workflow-cpu-ms, and --workflow-storage-gb for a more useful estimate.");
  }
  if (detectedBindings.includes("browser-run") && browserRunHours + browserRunConcurrency === 0) {
    warnings.push("Browser Run binding detected. Pass --browser-run-hours and --browser-run-concurrency for a more useful estimate.");
  }

  const compare = stringFlag(flags, "compare");

  // money model. The $5 base fee is only a real line item on the Paid plan;
  // everything else is usage/overage. Splitting them lets the range model
  // "Free might be $0" vs "Paid floor + overage" honestly instead of asserting
  // a single confident number.
  const lineItemsTotalUsd = roundUsd(lineItems.reduce((total, item) => total + item.estimatedUsd, 0));
  const baseFeeUsd = lineItems
    .filter((item) => item.id === "workers-paid-subscription")
    .reduce((total, item) => total + item.estimatedUsd, 0);
  const variableUsd = roundUsd(lineItemsTotalUsd - baseFeeUsd);

  let estimatedMonthlyUsd: number;
  let estimatedMonthlyUsdLow: number;
  let estimatedMonthlyUsdHigh: number;
  if (plan === "paid") {
    // conservative explicit estimate: $5 floor + usage. Unchanged from before.
    estimatedMonthlyUsd = roundUsd(baseFeeUsd + variableUsd);
    estimatedMonthlyUsdLow = roundUsd(baseFeeUsd + variableUsd * 0.5);
    estimatedMonthlyUsdHigh = roundUsd(baseFeeUsd + variableUsd * 2);
  } else if (plan === "free") {
    // free tier has no base fee. Overage-prone usage is shown as the high end.
    estimatedMonthlyUsd = roundUsd(variableUsd);
    estimatedMonthlyUsdLow = 0;
    estimatedMonthlyUsdHigh = roundUsd(variableUsd * 2);
  } else {
    // unknown plan: honest baseline range. Low assumes Free ($0 may be enough);
    // high assumes the Paid $5 floor plus headroom on usage. The headline leads
    // with the $5 floor so we never under-promise, but estimateIsRange flags
    // that this is a range, not a guaranteed single number.
    estimatedMonthlyUsd = roundUsd(5 + variableUsd);
    estimatedMonthlyUsdLow = 0;
    estimatedMonthlyUsdHigh = roundUsd(5 + variableUsd * 2);
  }
  const estimateIsRange = estimatedMonthlyUsdHigh !== estimatedMonthlyUsdLow;
  const recommendedEstimateKind: CostReport["recommendedEstimateKind"] = plan === "unknown" ? "range" : "single";
  const recommendedDisplay = plan === "unknown"
    ? `${usd(estimatedMonthlyUsdLow)} - ${usd(estimatedMonthlyUsdHigh)}/mo`
    : `${usd(estimatedMonthlyUsd)}/mo`;
  const costBasis: CostReport["costBasis"] = plan === "unknown"
    ? "unknown-plan-range"
    : plan === "free"
      ? "explicit-free"
      : liveUsage
        ? "live-paid"
        : "explicit-paid";
  // Vercel comparison weighs against the honest headline estimate.
  const cloudflareMonthlyUsd = estimatedMonthlyUsd;

  const billShockRisks = detectBillShockRisks(detectedBindings);
  for (const risk of billShockRisks) warnings.push(risk);

  // ground the estimate in the app's actual shape when the user is on defaults.
  const usingDefaultTraffic = typeof flags["requests"] !== "string";
  if (usingDefaultTraffic && ctx.routeCount > 0) {
    warnings.push(`Detected ${ctx.routeCount} route(s) (${ctx.apiRouteCount} dynamic/API). Traffic is assumed, not measured \u2014 pass --requests to match your real volume.`);
  }
  let vercelComparison: VercelComparison | undefined;
  if (compare === "vercel") {
    vercelComparison = buildVercelComparison(flags, cloudflareMonthlyUsd);
    if (vercelComparison) {
      warnings.push(vercelComparison.disclaimer);
    } else {
      warnings.push("Vercel comparison skipped: pass --vercel-monthly-usd with your real bill, or use --vercel-live with an authenticated Vercel CLI. Flarecel does not invent Vercel bills.");
    }
  }

  return {
    status: "estimate",
    plan,
    planAssumed,
    planConfidence,
    estimateIsRange,
    usageSource,
    usageWindowDays: liveUsage?.windowDays,
    currency: "USD",
    recommendedDisplay,
    recommendedEstimateKind,
    costBasis,
    project: {
      name: ctx.packageJson?.name ?? null,
      framework: ctx.framework
    },
    assumptions: {
      "requests/month": dynamicRequests,
      "static-requests/month": staticRequests,
      "avg-cpu-ms/request": avgCpuMs,
      "r2-storage-gb": r2StorageGb,
      "r2-class-a-operations/month": r2ClassA,
      "r2-class-b-operations/month": r2ClassB,
      "d1-rows-read/month": d1Reads,
      "d1-rows-written/month": d1Writes,
      "d1-storage-gb": d1StorageGb,
      "kv-reads/month": kvReads,
      "kv-writes/month": kvWrites,
      "kv-deletes/month": kvDeletes,
      "kv-lists/month": kvLists,
      "kv-storage-gb": kvStorageGb,
      "queue-operations/month": queueOps,
      "workers-ai-neurons/month": workersAiNeurons,
      "vectorize-queries/month": vectorizeQueries,
      "vectorize-stored-vectors": vectorizeStoredVectors,
      "vectorize-dimensions": vectorizeDimensions,
      "durable-object-requests/month": durableObjectRequests,
      "durable-object-duration-gb-s/month": durableObjectDurationGbSeconds,
      "durable-object-storage-gb": durableObjectStorageGb,
      "durable-object-rows-read/month": durableObjectRowsRead,
      "durable-object-rows-written/month": durableObjectRowsWritten,
      "workflow-requests/month": workflowRequests,
      "workflow-cpu-ms/month": workflowCpuMs,
      "workflow-storage-gb": workflowStorageGb,
      "browser-run-hours/month": browserRunHours,
      "browser-run-avg-concurrency": browserRunConcurrency,
      "detected-routes": ctx.routeCount,
      "detected-api-routes": ctx.apiRouteCount
    },
    detectedBindings,
    lineItems: lineItems.filter((item) => item.usage > 0 || item.estimatedUsd > 0 || item.id === "workers-paid-subscription"),
    estimatedMonthlyUsd,
    estimatedMonthlyUsdLow,
    estimatedMonthlyUsdHigh,
    pricingVerifiedOn: PRICING_VERIFIED_ON,
    billShockRisks,
    vercelComparison,
    warnings,
    sources: SOURCES,
    nextActions: costNextActions(compare === "vercel" && !vercelComparison)
  };
}

const VERCEL_DISCLAIMER =
  "EXPERIMENTAL comparison, not a quote. Cloudflare bills depend on real usage, regions, and plan changes. Use each provider's own calculator before making decisions.";

function buildVercelComparison(
  flags: Record<string, string | boolean>,
  cloudflareMonthlyUsd: number
): VercelComparison | undefined {
  const withDelta = (vercelMonthlyUsd: number, source: VercelComparison["source"], assumptions: Record<string, number | string>): VercelComparison => {
    const monthlyDeltaUsd = roundUsd(vercelMonthlyUsd - cloudflareMonthlyUsd);
    const savingsPct = vercelMonthlyUsd > 0 ? Math.round((monthlyDeltaUsd / vercelMonthlyUsd) * 100) : 0;
    return { disclaimer: VERCEL_DISCLAIMER, vercelMonthlyUsd: roundUsd(vercelMonthlyUsd), cloudflareMonthlyUsd, monthlyDeltaUsd, savingsPct, source, assumptions };
  };

  const override = numberFlag(flags, "vercel-monthly-usd", -1);
  if (override >= 0) {
    return withDelta(override, "user-provided", { "vercel-monthly-usd": roundUsd(override) });
  }

  const live = numberFlag(flags, "vercel-live-usd", -1);
  if (live >= 0) {
    return withDelta(live, "vercel-cli", { "vercel-monthly-usd": roundUsd(live), source: "vercel usage --format json" });
  }

  return undefined;
}

function costNextActions(needsVercelBill: boolean): string[] {
  const actions = [
    "Adjust usage flags for your expected traffic.",
    "Run flarecel deploy --preview --yes before production."
  ];
  if (needsVercelBill) {
    actions.unshift("For Vercel comparison, pass --vercel-monthly-usd <amount> or --vercel-live.");
  }
  return actions;
}

function fixed(id: string, label: string, estimatedUsd: number): CostLineItem {
  return {
    id,
    label,
    usage: 1,
    unit: "month",
    included: 0,
    rateUsd: estimatedUsd,
    billable: 1,
    estimatedUsd,
    formula: `$${estimatedUsd.toFixed(2)} monthly minimum`
  };
}

function metered(
  id: string,
  label: string,
  usage: number,
  unit: string,
  included: number,
  rateUsd: number,
  rateUnit: number
): CostLineItem {
  const billable = Math.max(0, usage - included);
  const estimatedUsd = roundUsd((billable / rateUnit) * rateUsd);

  return {
    id,
    label,
    usage,
    unit,
    included,
    rateUsd,
    billable,
    estimatedUsd,
    formula: `max(0, ${usage} - ${included}) / ${rateUnit} * $${rateUsd}`
  };
}

function vectorizeLineItems(queries: number, storedVectors: number, dimensions: number): CostLineItem[] {
  const queriedDimensions = (queries + storedVectors) * dimensions;
  const storedDimensions = storedVectors * dimensions;

  return [
    metered(
      "vectorize-queried-dimensions",
      "Vectorize queried dimensions",
      queriedDimensions,
      "dimensions/month",
      50_000_000,
      0.01,
      1_000_000
    ),
    metered(
      "vectorize-stored-dimensions",
      "Vectorize stored dimensions",
      storedDimensions,
      "dimensions",
      10_000_000,
      0.05,
      100_000_000
    )
  ];
}

// bindings whose cost scales with traffic/load and can spike unexpectedly.
const SPIKE_PRONE: Record<string, string> = {
  "workers-ai": "Workers AI bills per neuron \u2014 a viral spike or prompt-heavy traffic can multiply this fast.",
  "durable-objects": "Durable Objects bill for duration + requests; long-lived or chatty objects can climb quickly.",
  vectorize: "Vectorize bills per queried dimension; large indexes or high query volume scale steeply.",
  "browser-run": "Browser Run bills per browser-hour; unbounded headless automation can run up cost.",
  workflows: "Workflows bill per request + CPU; retries and long runs add up.",
  queues: "Queues bill per operation; a backlog or retry storm can inflate operation counts."
};

function detectBillShockRisks(detectedBindings: string[]): string[] {
  return detectedBindings.filter((b) => SPIKE_PRONE[b]).map((b) => `BILL-SHOCK RISK: ${SPIKE_PRONE[b]}`);
}

function detectBillableBindings(ctx: ProjectContext): string[] {
  const config = ctx.wrangler.data;
  if (!config) return [];

  const bindings = new Set<string>();
  if (Array.isArray(config.r2_buckets) && config.r2_buckets.length > 0) bindings.add("r2");
  if (Array.isArray(config.d1_databases) && config.d1_databases.length > 0) bindings.add("d1");
  if (Array.isArray(config.kv_namespaces) && config.kv_namespaces.length > 0) bindings.add("kv");
  if (config.ai && typeof config.ai === "object" && !Array.isArray(config.ai)) bindings.add("workers-ai");
  if (Array.isArray(config.vectorize) && config.vectorize.length > 0) bindings.add("vectorize");
  if (Array.isArray(config.workflows) && config.workflows.length > 0) bindings.add("workflows");
  if (config.browser && typeof config.browser === "object" && !Array.isArray(config.browser)) bindings.add("browser-run");
  const durableObjects = config.durable_objects;
  if (
    durableObjects &&
    typeof durableObjects === "object" &&
    !Array.isArray(durableObjects) &&
    Array.isArray((durableObjects as Record<string, unknown>).bindings)
  ) {
    bindings.add("durable-objects");
  }
  if (Array.isArray(config.ratelimits) && config.ratelimits.length > 0) bindings.add("rate-limits");

  const queues = config.queues;
  if (queues && typeof queues === "object" && !Array.isArray(queues)) {
    const queueConfig = queues as Record<string, unknown>;
    if (Array.isArray(queueConfig.producers) || Array.isArray(queueConfig.consumers)) bindings.add("queues");
  }

  return [...bindings];
}

function numberFlag(flags: Record<string, string | boolean>, name: string, fallback: number): number {
  const raw = flags[name];
  if (typeof raw !== "string") return fallback;

  const parsed = Number(raw.replace(/_/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | null {
  const raw = flags[name];
  return typeof raw === "string" ? raw.toLowerCase() : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}
