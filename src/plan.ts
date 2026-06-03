import type { DoctorReport, PlanReport, PlanStep } from "./types.js";

export function createPlan(report: DoctorReport): PlanReport {
  const steps: PlanStep[] = [];

  if (report.project.framework === "nextjs") {
    steps.push({
      id: "next-opennext",
      title: "Prepare Next.js for OpenNext Cloudflare",
      command: "flarecel add next-opennext --dry-run --format patch",
      reason: "OpenNext is the current adapter path for deploying Next.js to Cloudflare Workers.",
      status: hasIssue(report, "missing-opennext") || hasIssue(report, "missing-wrangler-config") ? "todo" : "done"
    });
  }

  if (hasIssue(report, "missing-nodejs-compat") || hasIssue(report, "missing-global-fetch-strictly-public")) {
    steps.push({
      id: "compatibility-flags",
      title: "Patch Workers compatibility flags",
      command: "flarecel fix --dry-run --format patch",
      reason: "Workers needs explicit compatibility flags for the runtime behavior OpenNext expects.",
      status: "todo"
    });
  }

  if (report.issues.some((issue) => issue.id.startsWith("risky-package-"))) {
    steps.push({
      id: "package-risk-review",
      title: "Review Worker-hostile packages",
      reason: "Some packages may assume a full Node.js server or native modules.",
      status: "manual"
    });
  }

  if (report.issues.some((issue) => issue.id.includes("edge-runtime") || issue.id.includes("next-on-pages"))) {
    steps.push({
      id: "source-risk-review",
      title: "Remove old Edge/Pages migration leftovers",
      reason: "OpenNext Cloudflare uses the Next.js Node.js runtime path, not next-on-pages Edge runtime assumptions.",
      status: "manual"
    });
  }

  steps.push({
    id: "verify",
    title: "Verify Cloudflare readiness",
    command: "flarecel verify --json",
    reason: "The agent should verify after patches instead of stopping at configuration changes.",
    status: report.status === "ready" ? "done" : "todo"
  });

  return {
    status: report.status,
    project: report.project,
    steps,
    nextActions: report.nextActions
  };
}

function hasIssue(report: DoctorReport, id: string): boolean {
  return report.issues.some((issue) => issue.id === id);
}

