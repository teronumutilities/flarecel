import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Framework,
  PackageJson,
  PackageManager,
  ProjectContext,
  SourceRisk,
  WranglerInfo
} from "./types.js";

const WRANGLER_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".open-next",
  ".vercel",
  ".wrangler",
  "dist",
  "build",
  "node_modules",
  "coverage",
  "out",
  "fixtures",
  "fixture",
  "scripts",
  "script",
  "test",
  "tests",
  "__tests__",
  "__mocks__"
]);

export async function detectProject(cwd: string): Promise<ProjectContext> {
  const packageJsonPath = path.join(cwd, "package.json");
  const packageJsonRaw = await readFileIfExists(packageJsonPath);
  let packageJson: PackageJson | null = null;
  let packageJsonParseError: string | null = null;
  if (packageJsonRaw !== null) {
    try {
      packageJson = JSON.parse(packageJsonRaw) as PackageJson;
    } catch (error) {
      packageJsonParseError = error instanceof Error ? error.message : String(error);
    }
  }
  const allDependencies = packageJson ? collectDependencies(packageJson) : {};
  const wrangler = await detectWrangler(cwd);
  const sourceFiles = await collectSourceFiles(cwd);
  const routeFiles = sourceFiles.filter((f) => /(^|\/)(page|route)\.(t|j)sx?$/.test(f));
  const apiRouteCount = routeFiles.filter((f) => /(^|\/)route\.(t|j)sx?$/.test(f) || f.includes("/api/")).length;
  const framework = await detectFramework(cwd, allDependencies, packageJson, wrangler);

  return {
    cwd,
    packageJsonPath: packageJsonRaw ? packageJsonPath : null,
    packageJsonRaw,
    packageJson,
    packageJsonParseError,
    allDependencies,
    packageManager: await detectPackageManager(cwd),
    framework,
    wrangler,
    hasVercelConfig: await exists(path.join(cwd, "vercel.json")),
    hasOpenNext: Boolean(allDependencies["@opennextjs/cloudflare"]),
    hasNextOnPages: Boolean(allDependencies["@cloudflare/next-on-pages"]),
    sourceRisks: await scanSourceRisks(cwd),
    routeCount: routeFiles.length,
    apiRouteCount
  };
}

export async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export function collectDependencies(packageJson: PackageJson): Record<string, string> {
  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
    ...packageJson.optionalDependencies
  };
}

export function projectName(ctx: ProjectContext): string {
  const rawName = ctx.packageJson?.name ?? path.basename(ctx.cwd);
  return sanitizeName(rawName.replace(/^@[^/]+\//, ""));
}

export function sanitizeName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "my-app";
}

export function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

async function detectWrangler(cwd: string): Promise<WranglerInfo> {
  for (const fileName of WRANGLER_FILES) {
    const filePath = path.join(cwd, fileName);
    const rawText = await readFileIfExists(filePath);
    if (rawText === null) continue;

    const format = fileName.endsWith(".toml") ? "toml" : "jsonc";
    if (format === "toml") {
      try {
        return { path: filePath, format, rawText, data: parseWranglerToml(rawText), parseError: null };
      } catch (error) {
        return {
          path: filePath,
          format,
          rawText,
          data: null,
          parseError: error instanceof Error ? error.message : String(error)
        };
      }
    }

    try {
      return {
        path: filePath,
        format,
        rawText,
        data: JSON.parse(stripJsonComments(rawText)) as Record<string, unknown>,
        parseError: null
      };
    } catch (error) {
      return {
        path: filePath,
        format,
        rawText,
        data: null,
        parseError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return { path: null, format: "none", rawText: null, data: null, parseError: null };
}

async function detectPackageManager(cwd: string): Promise<PackageManager> {
  if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (await exists(path.join(cwd, "bun.lockb")) || await exists(path.join(cwd, "bun.lock"))) return "bun";
  if (await exists(path.join(cwd, "package-lock.json"))) return "npm";
  return "unknown";
}

async function detectFramework(
  cwd: string,
  dependencies: Record<string, string>,
  packageJson: PackageJson | null,
  wrangler: WranglerInfo
): Promise<Framework> {
  if (dependencies.next) return "nextjs";
  if (dependencies.astro) return "astro";
  if (dependencies["@remix-run/node"] || dependencies["@remix-run/react"]) return "remix";
  if (dependencies["@sveltejs/kit"]) return "sveltekit";
  if (dependencies.hono) return "hono";
  if (dependencies["@tanstack/react-start"] || dependencies["@tanstack/start"]) return "tanstack-start";
  if (dependencies.vite || dependencies["@vitejs/plugin-react"]) return "vite";
  if (wrangler.path) {
    const scripts = Object.values(packageJson?.scripts ?? {}).join("\n");
    if (scripts.includes("wrangler pages") || await exists(path.join(cwd, "functions"))) return "cloudflare-pages";
    if (scripts.includes("wrangler") || dependencies["@cloudflare/workers-types"] || wrangler.data?.main) return "cloudflare-workers";
  }
  return "unknown";
}

function parseWranglerToml(input: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  parseInlineTableArrays(input, data);

  let currentObject: Record<string, unknown> = data;
  let currentArrayTable: Record<string, unknown> | null = null;

  for (const rawLine of input.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const arraySection = line.match(/^\[\[([^\]]+)\]\]$/);
    if (arraySection) {
      currentArrayTable = {};
      currentObject = currentArrayTable;
      const parts = arraySection[1].split(".").map((part) => part.trim()).filter(Boolean);
      const key = parts.pop();
      if (!key) continue;
      const parent = ensureTomlObject(data, parts);
      const existing = parent[key];
      if (!Array.isArray(existing)) parent[key] = [];
      (parent[key] as Record<string, unknown>[]).push(currentArrayTable);
      continue;
    }

    const objectSection = line.match(/^\[([^\]]+)\]$/);
    if (objectSection) {
      currentArrayTable = null;
      currentObject = ensureTomlObject(data, objectSection[1].split(".").map((part) => part.trim()).filter(Boolean));
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    const [, rawKey, rawValue] = assignment;

    // inline array-of-table assignments are handled as a whole before the
    // line pass. Avoid overwriting them with a partial first line.
    if (/^\[\s*(?:\{|$)/.test(rawValue.trim())) continue;

    const target = rawKey.includes(".")
      ? ensureTomlObject(currentArrayTable ?? data, rawKey.split(".").slice(0, -1))
      : currentObject;
    const key = rawKey.includes(".") ? rawKey.split(".").at(-1) : rawKey;
    if (!key) continue;
    target[key] = parseTomlValue(rawValue);
  }

  return data;
}

function parseInlineTableArrays(input: string, data: Record<string, unknown>): void {
  const keys = [
    "r2_buckets",
    "d1_databases",
    "kv_namespaces",
    "vectorize",
    "workflows",
    "ratelimits",
    "hyperdrive"
  ];

  for (const key of keys) {
    const pattern = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*(?=\\n\\s*[A-Za-z_][A-Za-z0-9_.-]*\\s*=|\\n\\s*\\[|$)`, "m");
    const match = input.match(pattern);
    if (!match) continue;
    const entries = [...match[1].matchAll(/\{([^}]*)\}/g)]
      .map((entry) => parseTomlInlineTable(entry[1]))
      .filter((entry) => Object.keys(entry).length > 0);
    if (entries.length > 0) data[key] = entries;
  }
}

function parseTomlInlineTable(input: string): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const part of splitTomlList(input)) {
    const assignment = part.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
    if (!assignment) continue;
    record[assignment[1]] = parseTomlValue(assignment[2]);
  }
  return record;
}

function parseTomlValue(input: string): unknown {
  const value = input.trim().replace(/,\s*$/, "");
  const string = value.match(/^"((?:[^"\\]|\\.)*)"$/) ?? value.match(/^'([^']*)'$/);
  if (string) return string[1].replace(/\\"/g, "\"");
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitTomlList(value.slice(1, -1)).map(parseTomlValue);
  }
  return value;
}

function splitTomlList(input: string): string[] {
  const values: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (const char of input) {
    if (quote) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      if (current.trim()) values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

function stripTomlComment(input: string): string {
  let quote: "\"" | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return input.slice(0, index);
  }
  return input;
}

function ensureTomlObject(root: Record<string, unknown>, parts: string[]): Record<string, unknown> {
  let current = root;
  for (const part of parts) {
    const existing = current[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  return current;
}

async function scanSourceRisks(cwd: string): Promise<SourceRisk[]> {
  const files = await collectSourceFiles(cwd);
  const risks: SourceRisk[] = [];
  let flaggedNextImage = false;
  const nodeApiPatterns = [
    "child_process",
    "cluster",
    "worker_threads",
    "fs",
    "net",
    "tls"
  ];

  for (const file of files) {
    const content = await readFileIfExists(path.join(cwd, file));
    if (!content) continue;

    if (/export\s+const\s+runtime\s*=\s*["']edge["']/.test(content)) {
      risks.push({ file, kind: "edge-runtime", value: "export const runtime = \"edge\"" });
    }

    if (content.includes("@cloudflare/next-on-pages")) {
      risks.push({ file, kind: "next-on-pages-import", value: "@cloudflare/next-on-pages" });
    }

    if (!flaggedNextImage && /from\s+["']next\/image["']/.test(content)) {
      risks.push({ file, kind: "next-image-import", value: "next/image" });
      flaggedNextImage = true;
    }

    for (const api of nodeApiPatterns) {
      const importPattern = new RegExp(`(?:from\\s+["'](?:node:)?${api}(?:/[^"']*)?["']|require\\(["'](?:node:)?${api}(?:/[^"']*)?["']\\))`);
      if (importPattern.test(content)) {
        risks.push({ file, kind: "node-api-import", value: api });
      }
    }
  }

  return risks;
}

async function collectSourceFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(relativeDir: string): Promise<void> {
    const absoluteDir = path.join(cwd, relativeDir);
    let entries;
    try {
      entries = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const relativePath = path.join(relativeDir, entry.name);

      if (entry.isDirectory()) {
        await walk(relativePath);
        continue;
      }

      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(relativePath);
      }
    }
  }

  await walk("");
  return files.slice(0, 1000);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
