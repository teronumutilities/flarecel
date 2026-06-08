import { existsSync } from "node:fs";
import path from "node:path";
import type { ChangeSet, ProjectContext } from "./types.js";

export type JsonObject = Record<string, unknown>;

// ----- Next.js path resolution (app/ vs src/app/ layouts) -----

export function nextRoutePath(ctx: ProjectContext, segment: string): string {
  const srcApp = path.join(ctx.cwd, "src", "app");
  const app = path.join(ctx.cwd, "app");

  if (pathExistsSync(srcApp)) return `src/app/api/${segment}/route.ts`;
  if (pathExistsSync(app)) return `app/api/${segment}/route.ts`;
  return `app/api/${segment}/route.ts`;
}

export function nextLibPath(ctx: ProjectContext, fileName: string): string {
  return pathExistsSync(path.join(ctx.cwd, "src", "app"))
    ? `src/lib/${fileName}`
    : `lib/${fileName}`;
}

// files that live at the app root or under src/ (e.g. middleware.ts, auth.ts).
export function nextSrcRootPath(ctx: ProjectContext, fileName: string): string {
  return pathExistsSync(path.join(ctx.cwd, "src", "app")) ? `src/${fileName}` : fileName;
}

export function nextRootFile(ctx: ProjectContext, fileName: string): string {
  return nextSrcRootPath(ctx, fileName);
}

export function nextDbPath(ctx: ProjectContext, fileName: string): string {
  return pathExistsSync(path.join(ctx.cwd, "src", "app"))
    ? `src/db/${fileName}`
    : `db/${fileName}`;
}

export function nextLibPathFromSchema(schemaFile: string): string {
  return schemaFile.startsWith("src/")
    ? "src/lib/auth.ts"
    : "lib/auth.ts";
}

export function relativeImport(fromFile: string, toFile: string): string {
  let relativePath = path.relative(path.dirname(fromFile), toFile.replace(/\.ts$/, ""));
  if (!relativePath.startsWith(".")) relativePath = `./${relativePath}`;
  return relativePath.replace(/\\/g, "/");
}

// ----- Option parsers -----

export function parseLimit(value: string): { limit: number; period: 10 | 60 } {
  const match = value.match(/^(\d+)\/(10s|60s|min|minute)$/);
  if (!match) return { limit: 20, period: 60 };

  return {
    limit: Number(match[1]),
    period: match[2] === "10s" ? 10 : 60
  };
}

export function numericOption(value: string | boolean | undefined, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseVectorMetric(value: string): string {
  return ["cosine", "euclidean", "dot-product"].includes(value) ? value : "cosine";
}

export function parseSampling(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(1, Math.max(0, parsed));
}

// ----- JSON/config mutation helpers -----

export function addUniqueStrings(existing: unknown, values: string[]): string[] {
  const set = new Set(Array.isArray(existing) ? existing.filter((value) => typeof value === "string") as string[] : []);
  for (const value of values) set.add(value);
  return [...set];
}

export function upsertArrayObject(existing: unknown, key: string, value: JsonObject): JsonObject[] {
  const array = Array.isArray(existing) ? existing.filter(isObject) : [];
  const index = array.findIndex((candidate) => candidate[key] === value[key]);

  if (index === -1) return [...array, value];

  const next = [...array];
  next[index] = { ...next[index], ...value };
  return next;
}

export function upsertDurableObjectMigration(existing: unknown, tag: string, className: string): JsonObject[] {
  const migrations = Array.isArray(existing) ? existing.filter(isObject) : [];
  const index = migrations.findIndex((candidate) => candidate.tag === tag);

  if (index === -1) {
    return [
      ...migrations,
      {
        tag,
        new_sqlite_classes: [className]
      }
    ];
  }

  const next = [...migrations];
  const migration = { ...next[index] };
  migration.new_sqlite_classes = addUniqueStrings(migration.new_sqlite_classes, [className]);
  next[index] = migration;
  return next;
}

export function asObject(value: unknown): JsonObject {
  return isObject(value) ? { ...value } : {};
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ----- Name sanitizers -----

export function sanitizeFeatureName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "feature";
}

export function sanitizeQueueName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "jobs";
}

export function pascalCase(value: string): string {
  const result = value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("");

  return result || "Job";
}

export function pathExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

export function unknownAddOn(name: string): ChangeSet {
  return {
    status: "error",
    title: `Unknown add-on: ${name}`,
    changes: [],
    warnings: [`Add-on "${name}" is not implemented yet.`],
    nextActions: ["flarecel plan --json"]
  };
}
