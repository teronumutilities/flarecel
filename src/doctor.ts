import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DoctorReport, Issue, ProjectContext, Severity, Status } from "./types.js";

export function runDoctor(ctx: ProjectContext): DoctorReport {
  const issues: Issue[] = [];

  if (!ctx.packageJson) {
    issues.push(issue({
      id: ctx.packageJsonParseError ? "invalid-package-json" : "missing-package-json",
      severity: "blocking",
      title: ctx.packageJsonParseError ? "package.json could not be parsed" : "No package.json found",
      message: ctx.packageJsonParseError
        ? `package.json exists but is not valid JSON: ${ctx.packageJsonParseError}`
        : "Flarecel needs to run inside a JavaScript or TypeScript project.",
      fixable: false
    }));

    return report(ctx, issues);
  }

  if (ctx.framework === "unknown") {
    issues.push(issue({
      id: "unknown-framework",
      severity: "blocking",
      title: "Framework not recognized yet",
      message: "This MVP supports detection for Next.js, Vite, Astro, Remix, SvelteKit, and Hono.",
      fixable: false
    }));
  }

  if (ctx.framework === "nextjs") {
    checkNextProject(ctx, issues);
  } else if (ctx.framework !== "unknown") {
    checkGenericCloudflareProject(ctx, issues);
  }

  checkPackageRisks(ctx, issues);
  checkSourceRisks(ctx, issues);
  checkAuthSecrets(ctx, issues);

  return report(ctx, issues);
}

export function exitCodeForStatus(status: Status): number {
  switch (status) {
    case "ready":
      return 0;
    case "warning":
      return 1;
    case "blocking":
      return 2;
    case "secrets-missing":
      return 3;
    case "unsupported":
      return 4;
  }
}

function checkNextProject(ctx: ProjectContext, issues: Issue[]): void {
  if (!ctx.hasOpenNext) {
    issues.push(issue({
      id: "missing-opennext",
      severity: "blocking",
      title: "OpenNext Cloudflare adapter missing",
      message: "Next.js should deploy to Cloudflare Workers through @opennextjs/cloudflare.",
      fixable: true,
      recipe: "next-opennext",
      recommendedCommand: "flarecel add next-opennext --dry-run --format patch"
    }));
  }

  if (!ctx.wrangler.path) {
    issues.push(issue({
      id: "missing-wrangler-config",
      severity: "blocking",
      title: "Wrangler config missing",
      message: "Cloudflare Workers needs wrangler.jsonc to define the Worker entry, assets, compatibility flags, and bindings.",
      fixable: true,
      recipe: "next-opennext",
      recommendedCommand: "flarecel fix --dry-run --format patch"
    }));
  } else if (ctx.wrangler.format === "toml") {
    issues.push(issue({
      id: "toml-config",
      severity: "warning",
      title: "Wrangler config uses TOML",
      message: "Flarecel can inspect TOML, but this MVP only patches wrangler.jsonc/json safely.",
      file: relative(ctx, ctx.wrangler.path),
      fixable: false
    }));
  } else {
    if (ctx.wrangler.parseError) {
      issues.push(issue({
        id: "invalid-wrangler-jsonc",
        severity: "blocking",
        title: "Wrangler JSONC could not be parsed",
        message: ctx.wrangler.parseError,
        file: relative(ctx, ctx.wrangler.path),
        fixable: false
      }));
    }

    if (!hasCompatibilityFlag(ctx, "nodejs_compat")) {
      issues.push(issue({
        id: "missing-nodejs-compat",
        severity: "high",
        title: "nodejs_compat flag missing",
        message: "OpenNext Cloudflare expects Node.js APIs from the Workers runtime. Add the nodejs_compat compatibility flag.",
        file: relative(ctx, ctx.wrangler.path),
        fixable: true,
        recipe: "next-opennext",
        recommendedCommand: "flarecel fix --dry-run --format patch"
      }));
    }

    if (!hasCompatibilityFlag(ctx, "global_fetch_strictly_public")) {
      issues.push(issue({
        id: "missing-global-fetch-strictly-public",
        severity: "warning",
        title: "global_fetch_strictly_public flag missing",
        message: "OpenNext recommends this flag so app fetches are handled safely in Workers.",
        file: relative(ctx, ctx.wrangler.path),
        fixable: true,
        recipe: "next-opennext",
        recommendedCommand: "flarecel fix --dry-run --format patch"
      }));
    }
  }

  if (ctx.hasNextOnPages) {
    issues.push(issue({
      id: "next-on-pages-installed",
      severity: "high",
      title: "@cloudflare/next-on-pages installed",
      message: "Cloudflare's current Next.js path is OpenNext on Workers. next-on-pages should be removed during migration.",
      fixable: false
    }));
  }

  if (ctx.hasVercelConfig) {
    issues.push(issue({
      id: "vercel-config-present",
      severity: "warning",
      title: "vercel.json detected",
      message: "This can be fine, but Flarecel should verify env vars, rewrites, headers, and functions config before Cloudflare deploy.",
      file: "vercel.json",
      fixable: false
    }));
  }
}

function checkGenericCloudflareProject(ctx: ProjectContext, issues: Issue[]): void {
  if (!ctx.wrangler.path) {
    issues.push(issue({
      id: "missing-wrangler-config",
      severity: "warning",
      title: "Wrangler config missing",
      message: "This project may need wrangler.jsonc before Flarecel can add Cloudflare resources.",
      fixable: true,
      recommendedCommand: "flarecel fix --dry-run --format patch"
    }));
  }
}

function checkPackageRisks(ctx: ProjectContext, issues: Issue[]): void {
  const riskyPackages: Array<{ name: string; severity: Severity; message: string }> = [
    {
      name: "prisma",
      severity: "high",
      message: "Prisma can work on Workers only with a Worker-friendly adapter or external database strategy."
    },
    {
      name: "bcrypt",
      severity: "high",
      message: "bcrypt usually depends on native Node modules. Prefer bcryptjs, Web Crypto, or a Workers-compatible auth recipe."
    },
    {
      name: "sharp",
      severity: "warning",
      message: "sharp is native and can be risky in Workers. Prefer Cloudflare Images or a dedicated image service."
    },
    {
      name: "canvas",
      severity: "high",
      message: "canvas depends on native modules and is unlikely to work in Workers."
    },
    {
      name: "puppeteer",
      severity: "warning",
      message: "Use Cloudflare Browser Rendering instead of bundling a normal Puppeteer runtime."
    },
    {
      name: "playwright",
      severity: "warning",
      message: "Playwright should not run inside a normal Worker bundle. Use a separate browser rendering strategy."
    }
  ];

  for (const risky of riskyPackages) {
    if (ctx.allDependencies[risky.name]) {
      issues.push(issue({
        id: `risky-package-${risky.name}`,
        severity: risky.severity,
        title: `Package risk: ${risky.name}`,
        message: risky.message,
        fixable: false
      }));
    }
  }
}

function checkSourceRisks(ctx: ProjectContext, issues: Issue[]): void {
  for (const risk of ctx.sourceRisks) {
    if (risk.kind === "edge-runtime") {
      issues.push(issue({
        id: "edge-runtime-export",
        severity: "high",
        title: "Edge runtime export detected",
        message: "OpenNext Cloudflare expects the Next.js Node.js runtime; remove export const runtime = \"edge\" before deploying.",
        file: risk.file,
        fixable: false
      }));
    }

    if (risk.kind === "next-on-pages-import") {
      issues.push(issue({
        id: "next-on-pages-import",
        severity: "high",
        title: "next-on-pages import detected",
        message: "Replace next-on-pages imports with @opennextjs/cloudflare equivalents.",
        file: risk.file,
        fixable: false
      }));
    }

    if (risk.kind === "node-api-import") {
      issues.push(issue({
        id: `node-api-import-${risk.value}`,
        severity: risk.value === "fs" ? "warning" : "high",
        title: `Node API import: ${risk.value}`,
        message: `This file imports ${risk.value}. Verify it works with Workers nodejs_compat and does not require unsupported runtime behavior.`,
        file: risk.file,
        fixable: false
      }));
    }
  }
}

function checkAuthSecrets(ctx: ProjectContext, issues: Issue[]): void {
  const routeCandidates = [
    "app/api/auth/[...all]/route.ts",
    "src/app/api/auth/[...all]/route.ts"
  ];
  const usesBetterAuth =
    Boolean(ctx.allDependencies["better-auth"]) ||
    routeCandidates.some((candidate) => existsSync(path.join(ctx.cwd, candidate)));
  if (!usesBetterAuth) return;

  // A declared binding type or a set local/Wrangler secret both satisfy this.
  const envTypes = readTextSync(path.join(ctx.cwd, "cloudflare-env.d.ts"));
  const devVars = readTextSync(path.join(ctx.cwd, ".dev.vars"));
  const declared =
    Boolean(envTypes?.includes("BETTER_AUTH_SECRET")) ||
    Boolean(devVars?.includes("BETTER_AUTH_SECRET"));
  if (declared) return;

  issues.push(issue({
    id: "auth-secret-missing",
    severity: "high",
    title: "Better Auth secret is not configured",
    message: "Better Auth is in use but BETTER_AUTH_SECRET is not declared in cloudflare-env.d.ts or .dev.vars. Set it as a Wrangler secret before deploy.",
    fixable: false,
    recommendedCommand: "wrangler secret put BETTER_AUTH_SECRET"
  }));
}

function readTextSync(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function report(ctx: ProjectContext, issues: Issue[]): DoctorReport {
  const status = statusFromIssues(issues);
  const score = readinessScore(issues);
  const nextActions = buildNextActions(issues, status);

  return {
    status,
    readinessScore: score,
    project: {
      cwd: ctx.cwd,
      name: ctx.packageJson?.name ?? null,
      framework: ctx.framework,
      packageManager: ctx.packageManager,
      cloudflareReady: status === "ready",
      wranglerConfig: ctx.wrangler.path ? relative(ctx, ctx.wrangler.path) : null
    },
    issues,
    nextActions
  };
}

function buildNextActions(issues: Issue[], status: Status): string[] {
  const actions = new Set<string>();
  for (const candidate of issues) {
    if (candidate.recommendedCommand) actions.add(candidate.recommendedCommand);
  }

  if (status !== "ready") {
    actions.add("flarecel verify --json");
  } else {
    actions.add("flarecel deploy --preview --yes");
  }

  return [...actions];
}

function statusFromIssues(issues: Issue[]): Status {
  if (issues.some((candidate) => candidate.id === "unknown-framework")) return "unsupported";
  if (issues.some((candidate) => candidate.severity === "blocking")) return "blocking";
  if (issues.some((candidate) => candidate.id === "auth-secret-missing")) return "secrets-missing";
  if (issues.length > 0) return "warning";
  return "ready";
}

function readinessScore(issues: Issue[]): number {
  let score = 100;

  for (const candidate of issues) {
    if (candidate.severity === "blocking") score -= 35;
    if (candidate.severity === "high") score -= 20;
    if (candidate.severity === "warning") score -= 8;
    if (candidate.severity === "info") score -= 2;
  }

  return Math.max(0, score);
}

function hasCompatibilityFlag(ctx: ProjectContext, flag: string): boolean {
  const config = ctx.wrangler.data;
  if (!config) return Boolean(ctx.wrangler.rawText?.includes(flag));

  const flags = config.compatibility_flags;
  return Array.isArray(flags) && flags.some((value) => value === flag);
}

function issue(input: Issue): Issue {
  return input;
}

function relative(ctx: ProjectContext, filePath: string): string {
  return path.relative(ctx.cwd, filePath);
}

