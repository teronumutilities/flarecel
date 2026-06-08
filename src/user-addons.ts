import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectName } from "./project.js";
import type { IntegrationSpec } from "./addon-spec.js";
import { type JsonObject, isObject } from "./addon-utils.js";
import type { ProjectContext } from "./types.js";

const ADDONS_DIR = ".flarecel/addons";
// catalog ships inside the package at dist/../catalog (sibling of dist/).
const CATALOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "catalog");

// declarative, JSON-only add-on. NO functions, NO code: every field is static
// data. Files are plain strings with one safe substitution ({{projectName}}).
// this is the entire trust boundary — a user spec can only describe a change
// set, never execute logic.
export interface UserAddonSpec {
  name: string;
  title: string;
  deps?: string[];
  devDeps?: string[];
  envTypes?: string[];
  envExample?: string[];
  files?: Array<{ path: string; content: string; reason?: string }>;
  wrangler?: JsonObject;
  warnings?: string[];
  nextActions?: string[];
  doc?: string;
}

export interface LoadedUserAddon {
  name: string;
  spec: IntegrationSpec;
  source: "project" | "catalog" | "remote";
}

export class UserAddonError extends Error {}

// load and validate every *.json spec in a directory. Returns [] if absent.
// Throws UserAddonError with a precise message on any malformed spec — we fail
// loud rather than silently skip, so a broken add-on can't hide.
function loadFrom(dir: string, source: LoadedUserAddon["source"]): LoadedUserAddon[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  return entries.map((file) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    } catch (error) {
      throw new UserAddonError(`${file}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const spec = validateUserAddon(raw, file);
    return { name: spec.name, spec: toIntegrationSpec(spec, source), source };
  });
}

// flarecel-shipped catalog add-ons. Work in any project with no setup.
export function loadCatalogAddons(): LoadedUserAddon[] {
  return loadFrom(CATALOG_DIR, "catalog");
}

// project-authored add-ons in .flarecel/addons/.
export function loadUserAddons(cwd: string): LoadedUserAddon[] {
  return loadFrom(path.join(cwd, ADDONS_DIR), "project");
}

// all resolvable add-ons by name: catalog first, then project (project wins on
// name collision so users can override a shipped add-on).
export function findUserAddon(cwd: string, name: string): LoadedUserAddon | null {
  const project = loadUserAddons(cwd).find((a) => a.name === name);
  if (project) return project;
  return loadCatalogAddons().find((a) => a.name === name) ?? null;
}

export function isRemoteAddonRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

const MAX_REMOTE_BYTES = 64 * 1024;

// fetch a declarative add-on JSON from a URL and validate it through the SAME
// no-code pipeline as local specs. https only by default; size-capped; never
// executes anything. Throws UserAddonError on any problem.
export async function fetchRemoteAddon(url: string): Promise<LoadedUserAddon> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserAddonError(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "localhost")) {
    throw new UserAddonError(`Refusing to fetch over ${parsed.protocol} — use https (http allowed only for localhost).`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let text: string;
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow", headers: { accept: "application/json" } });
    if (!res.ok) throw new UserAddonError(`Fetch failed: HTTP ${res.status} from ${url}`);
    text = await res.text();
  } catch (error) {
    if (error instanceof UserAddonError) throw error;
    throw new UserAddonError(`Could not fetch add-on from ${url}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (text.length > MAX_REMOTE_BYTES) {
    throw new UserAddonError(`Remote add-on is too large (> ${MAX_REMOTE_BYTES} bytes); refusing to parse.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new UserAddonError(`Remote add-on is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const spec = validateUserAddon(raw, url);
  return { name: spec.name, spec: toIntegrationSpec(spec, "remote"), source: "remote" };
}

export interface CatalogListEntry {
  name: string;
  title: string;
  source: "builtin" | "catalog" | "project";
}

// comprehensive add-on view: built-ins (passed in to avoid an import cycle) +
// bundled JSON catalog + project add-ons. On name collision, project shadows
// catalog shadows built-in.
export function listCatalog(cwd: string, builtins: Array<{ name: string }> = []): CatalogListEntry[] {
  const byName = new Map<string, CatalogListEntry>();
  for (const b of builtins) byName.set(b.name, { name: b.name, title: b.name, source: "builtin" });
  for (const a of loadCatalogAddons()) byName.set(a.name, { name: a.name, title: a.spec.title, source: "catalog" });
  for (const a of loadUserAddons(cwd)) byName.set(a.name, { name: a.name, title: a.spec.title, source: "project" });
  return [...byName.values()].sort((x, y) => x.name.localeCompare(y.name));
}

function validateUserAddon(raw: unknown, file: string): UserAddonSpec {
  if (!isObject(raw)) throw new UserAddonError(`${file}: top-level value must be a JSON object`);
  const o = raw as Record<string, unknown>;

  const name = requireString(o.name, `${file}: "name"`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new UserAddonError(`${file}: "name" must be lowercase letters, digits, and dashes (got "${name}")`);
  }
  const title = requireString(o.title, `${file}: "title"`);

  const deps = optStringArray(o.deps, `${file}: "deps"`);
  const devDeps = optStringArray(o.devDeps, `${file}: "devDeps"`);
  const envTypes = optStringArray(o.envTypes, `${file}: "envTypes"`);
  const envExample = optStringArray(o.envExample, `${file}: "envExample"`);
  const warnings = optStringArray(o.warnings, `${file}: "warnings"`);
  const nextActions = optStringArray(o.nextActions, `${file}: "nextActions"`);

  // secrets must never be baked into a committed add-on: env examples may name
  // keys but not assign real-looking values.
  for (const line of envExample ?? []) {
    const key = line.split("=")[0]?.trim() ?? "";
    const value = line.split("=").slice(1).join("=").trim();
    const secretLike = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|DSN|CREDENTIAL|PRIVATE)/i.test(key);
    if (secretLike && value && !/(replace|your|example|changeme|placeholder|<.*>|\$\{.*\}|x{3,}|\.{3})/i.test(value)) {
      throw new UserAddonError(`${file}: envExample "${line}" looks like a real secret value; use a placeholder (e.g. ${key}=replace-me)`);
    }
  }

  let files: UserAddonSpec["files"];
  if (o.files !== undefined) {
    if (!Array.isArray(o.files)) throw new UserAddonError(`${file}: "files" must be an array`);
    files = o.files.map((f, i) => {
      if (!isObject(f)) throw new UserAddonError(`${file}: files[${i}] must be an object`);
      const fp = requireString((f as JsonObject).path, `${file}: files[${i}].path`);
      assertSafePath(fp, file, i);
      return {
        path: fp,
        content: requireString((f as JsonObject).content, `${file}: files[${i}].content`),
        reason: typeof (f as JsonObject).reason === "string" ? (f as JsonObject).reason as string : undefined
      };
    });
  }

  let wrangler: JsonObject | undefined;
  if (o.wrangler !== undefined) {
    if (!isObject(o.wrangler)) throw new UserAddonError(`${file}: "wrangler" must be a JSON object of config keys to merge`);
    wrangler = o.wrangler as JsonObject;
  }

  const doc = o.doc === undefined ? undefined : requireString(o.doc, `${file}: "doc"`);

  return { name, title, deps, devDeps, envTypes, envExample, files, wrangler, warnings, nextActions, doc };
}

// block path traversal and absolute paths — a user add-on may only write inside
// the project.
function assertSafePath(p: string, file: string, i: number): void {
  if (path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
    throw new UserAddonError(`${file}: files[${i}].path "${p}" must be a relative path inside the project (no .. or absolute paths)`);
  }
}

function toIntegrationSpec(s: UserAddonSpec, source: LoadedUserAddon["source"]): IntegrationSpec {
  const subst = (ctx: ProjectContext, text: string): string => text.replace(/\{\{projectName\}\}/g, projectName(ctx));
  const wrangler = s.wrangler;
  const provenance = source === "catalog"
    ? `Flarecel catalog add-on "${s.name}" — vetted JSON spec; review the generated change set and pin versions before production.`
    : source === "remote"
    ? `REMOTE ADD-ON "${s.name}" fetched from the internet. NOT authored by you or Flarecel. It is declarative JSON (no code runs), but review every generated file before applying.`
    : `USER ADD-ON "${s.name}" loaded from ${ADDONS_DIR}/. Flarecel did not author this; review its output before applying.`;
  return {
    title: s.title,
    deps: s.deps,
    devDeps: s.devDeps,
    envTypes: s.envTypes,
    envExample: s.envExample,
    files: s.files?.map((f) => ({
      path: () => f.path,
      content: (ctx: ProjectContext) => subst(ctx, f.content),
      reason: f.reason ?? `Add ${s.title} file ${f.path}`
    })),
    wrangler: wrangler ? (config: JsonObject) => mergeWranglerConfig(config, wrangler) : undefined,
    warnings: [provenance, ...(s.warnings ?? [])],
    nextActions: s.nextActions,
    docPath: `docs/flarecel-${s.name}.md`,
    doc: s.doc ?? `# Flarecel ${source === "catalog" ? "catalog" : "user"} add-on: ${s.title}\n\nDeclarative add-on${source === "catalog" ? " shipped with Flarecel" : ` loaded from ${ADDONS_DIR}/${s.name}.json`}.\n`
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new UserAddonError(`${label} is required and must be a non-empty string`);
  return value;
}

function optStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new UserAddonError(`${label} must be an array of strings`);
  }
  return value as string[];
}

function mergeWranglerConfig(target: JsonObject, patch: JsonObject): void {
  for (const [key, value] of Object.entries(patch)) {
    target[key] = mergeWranglerValue(target[key], value);
  }
}

function mergeWranglerValue(existing: unknown, incoming: unknown): unknown {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    if (existing.every((value) => typeof value === "string") && incoming.every((value) => typeof value === "string")) {
      return [...new Set([...existing, ...incoming])];
    }
    return mergeObjectArrays(existing, incoming);
  }

  if (isObject(existing) && isObject(incoming)) {
    const merged: JsonObject = { ...existing };
    mergeWranglerConfig(merged, incoming);
    return merged;
  }

  return incoming;
}

function mergeObjectArrays(existing: unknown[], incoming: unknown[]): unknown[] {
  const merged = [...existing];

  for (const item of incoming) {
    if (!isObject(item)) {
      if (!merged.some((candidate) => stableJson(candidate) === stableJson(item))) merged.push(item);
      continue;
    }

    const key = identityKey(item);
    if (!key) {
      if (!merged.some((candidate) => stableJson(candidate) === stableJson(item))) merged.push(item);
      continue;
    }

    const index = merged.findIndex((candidate) => isObject(candidate) && candidate[key] === item[key]);
    if (index === -1) {
      merged.push(item);
      continue;
    }
    merged[index] = mergeWranglerValue(merged[index], item);
  }

  return merged;
}

function identityKey(value: JsonObject): string | null {
  for (const key of ["binding", "name", "queue", "index_name", "database_name", "bucket_name", "class_name", "tag"]) {
    if (typeof value[key] === "string") return key;
  }
  return null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(isObject(value) ? value : {}).sort());
}
