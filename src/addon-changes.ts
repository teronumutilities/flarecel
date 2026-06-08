import path from "node:path";
import { readFileIfExists, projectName } from "./project.js";
import { type JsonObject, today, addUniqueStrings, upsertArrayObject } from "./addon-utils.js";
import type { PackageJson, PlannedChange, ProjectContext } from "./types.js";

// shared change-builder primitives. Every add-on composes its change set from
// these; they handle app/ vs src/ layout, JSONC vs TOML wrangler, idempotent
// appends, and "before === after means no-op" so dry-run/apply stay in parity.

export async function packageJsonChange(
  ctx: ProjectContext,
  reason: string,
  mutate: (pkg: PackageJson) => void
): Promise<PlannedChange> {
  const before = ctx.packageJsonRaw;
  const pkg = before ? (JSON.parse(before) as PackageJson) : ({ scripts: {} } as PackageJson);
  mutate(pkg);

  return {
    path: "package.json",
    before,
    after: `${JSON.stringify(pkg, null, 2)}\n`,
    reason
  };
}

export async function wranglerChange(
  ctx: ProjectContext,
  reason: string,
  mutate: (config: JsonObject) => void
): Promise<PlannedChange> {
  if (ctx.wrangler.format === "toml") {
    const generated = baseWrangler(ctx);
    mutate(generated);

    return {
      path: "wrangler.jsonc",
      before: null,
      after: JSON.stringify(generated, null, 2) + "\n",
      reason: `${reason}. Existing TOML was not modified; this JSONC file is generated for review.`
    };
  }

  const before = ctx.wrangler.rawText;
  const config = ctx.wrangler.data
    ? structuredClone(ctx.wrangler.data)
    : baseWrangler(ctx);

  mutate(config);

  return {
    path: ctx.wrangler.path ? path.basename(ctx.wrangler.path) : "wrangler.jsonc",
    before,
    after: `${JSON.stringify(config, null, 2)}\n`,
    reason
  };
}

export async function fileChange(ctx: ProjectContext, relativePath: string, content: string, reason: string): Promise<PlannedChange> {
  const before = await readFileIfExists(path.join(ctx.cwd, relativePath));
  return {
    path: relativePath,
    before,
    after: content.endsWith("\n") ? content : `${content}\n`,
    reason
  };
}

export async function appendLineChange(ctx: ProjectContext, relativePath: string, line: string, reason: string): Promise<PlannedChange> {
  return appendLinesChange(ctx, relativePath, [line], reason);
}

export async function appendLinesChange(ctx: ProjectContext, relativePath: string, linesToAppend: string[], reason: string): Promise<PlannedChange> {
  const before = await readFileIfExists(path.join(ctx.cwd, relativePath));
  const lines = before ? before.split(/\r?\n/) : [];
  const missing = linesToAppend.filter((line) => !lines.includes(line));

  if (missing.length === 0) {
    return {
      path: relativePath,
      before,
      after: before ?? "",
      reason
    };
  }

  const after = `${before ? before.replace(/\n?$/, "\n") : ""}${missing.join("\n")}\n`;
  return {
    path: relativePath,
    before,
    after,
    reason
  };
}

export async function appendEnvType(ctx: ProjectContext, declaration: string, reason: string): Promise<PlannedChange> {
  return appendEnvTypes(ctx, [declaration], reason);
}

export async function appendEnvTypes(ctx: ProjectContext, declarations: string[], reason: string): Promise<PlannedChange> {
  const relativePath = "cloudflare-env.d.ts";
  const before = await readFileIfExists(path.join(ctx.cwd, relativePath));
  const header = "/// <reference types=\"@cloudflare/workers-types\" />\n\ninterface CloudflareEnv {\n";
  const footer = "}\n";
  const missing = declarations.filter((declaration) => !before?.includes(declaration));

  if (!before) {
    return {
      path: relativePath,
      before,
      after: `${header}${declarations.map((declaration) => `  ${declaration}`).join("\n")}\n${footer}`,
      reason
    };
  }

  if (missing.length === 0) {
    return {
      path: relativePath,
      before,
      after: before,
      reason
    };
  }

  const after = before.includes("interface CloudflareEnv")
    ? before.replace(/interface CloudflareEnv\s*\{\n/, (match) => `${match}${missing.map((declaration) => `  ${declaration}`).join("\n")}\n`)
    : `${before.replace(/\n?$/, "\n")}\n${header}${missing.map((declaration) => `  ${declaration}`).join("\n")}\n${footer}`;

  return {
    path: relativePath,
    before,
    after,
    reason
  };
}

export async function ensureHeadersChange(ctx: ProjectContext): Promise<PlannedChange> {
  const relativePath = "public/_headers";
  const before = await readFileIfExists(path.join(ctx.cwd, relativePath));
  const block = "/_next/static/*\n  Cache-Control: public,max-age=31536000,immutable";

  if (before?.includes("/_next/static/*")) {
    return {
      path: relativePath,
      before,
      after: before,
      reason: "Ensure static asset caching headers"
    };
  }

  return {
    path: relativePath,
    before,
    after: `${before ? `${before.replace(/\n?$/, "\n")}\n` : ""}${block}\n`,
    reason: "Ensure static asset caching headers"
  };
}

export function baseWrangler(ctx: ProjectContext): JsonObject {
  const config: JsonObject = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: projectName(ctx),
    main: ctx.framework === "nextjs" ? ".open-next/worker.js" : "src/index.ts",
    compatibility_date: today(),
    compatibility_flags: ctx.framework === "nextjs"
      ? ["nodejs_compat", "global_fetch_strictly_public"]
      : []
  };

  if (ctx.framework === "nextjs") {
    config.assets = {
      directory: ".open-next/assets",
      binding: "ASSETS"
    };
    config.services = [
      {
        binding: "WORKER_SELF_REFERENCE",
        service: projectName(ctx)
      }
    ];
  }

  return config;
}
