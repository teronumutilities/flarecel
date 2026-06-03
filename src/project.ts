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
  "dist",
  "node_modules",
  "coverage",
  "out"
]);

export async function detectProject(cwd: string): Promise<ProjectContext> {
  const packageJsonPath = path.join(cwd, "package.json");
  const packageJsonRaw = await readFileIfExists(packageJsonPath);
  const packageJson = packageJsonRaw ? (JSON.parse(packageJsonRaw) as PackageJson) : null;
  const allDependencies = packageJson ? collectDependencies(packageJson) : {};
  const wrangler = await detectWrangler(cwd);

  return {
    cwd,
    packageJsonPath: packageJsonRaw ? packageJsonPath : null,
    packageJsonRaw,
    packageJson,
    allDependencies,
    packageManager: await detectPackageManager(cwd),
    framework: detectFramework(allDependencies),
    wrangler,
    hasVercelConfig: await exists(path.join(cwd, "vercel.json")),
    hasOpenNext: Boolean(allDependencies["@opennextjs/cloudflare"]),
    hasNextOnPages: Boolean(allDependencies["@cloudflare/next-on-pages"]),
    sourceRisks: await scanSourceRisks(cwd)
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
      return { path: filePath, format, rawText, data: null, parseError: null };
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

function detectFramework(dependencies: Record<string, string>): Framework {
  if (dependencies.next) return "nextjs";
  if (dependencies.astro) return "astro";
  if (dependencies["@remix-run/node"] || dependencies["@remix-run/react"]) return "remix";
  if (dependencies["@sveltejs/kit"]) return "sveltekit";
  if (dependencies.hono) return "hono";
  if (dependencies.vite || dependencies["@vitejs/plugin-react"]) return "vite";
  return "unknown";
}

async function scanSourceRisks(cwd: string): Promise<SourceRisk[]> {
  const files = await collectSourceFiles(cwd);
  const risks: SourceRisk[] = [];
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

