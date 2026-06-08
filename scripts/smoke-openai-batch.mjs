import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");

// [args, load-bearing substring that MUST appear in some generated file]
const cases = [
  [["add", "cloudflare-images"], "/cdn-cgi/image"],
  [["add", "hyperdrive"], "HYPERDRIVE"],
  [["add", "email-routing"], "ExportedHandler"],
  [["add", "saas-billing"], "constructEventAsync"]
];

smokeNewRecipes();
smokeRelativeImportsResolve();
smokeDiscoverability();
smokeMcpNewTools();
smokeProgressAndMcpManifests();

function smokeNewRecipes() {
  for (const [args, mustContain] of cases) {
    const result = run([...args, "--dry-run", "--json", "--cwd", fixture]);
    assertEqual(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    const cs = JSON.parse(result.stdout);
    assertEqual(cs.status, "planned", `${args.join(" ")} should be planned`);
    assertNoDuplicatePaths(cs, args.join(" "));
    assertGeneratedTypescriptParses(cs);
    const blob = (cs.changes ?? []).map((c) => c.after).join("\n");
    if (!blob.includes(mustContain)) throw new Error(`${args.join(" ")}: expected output to contain "${mustContain}"`);
  }
}

// the teeth: every generated relative import must resolve to a file that the
// same changeset creates (or one that already exists in the project). This is
// the check that would have caught the saas-billing webhook import being one
// directory level off.
function smokeRelativeImportsResolve() {
  for (const [args] of cases) {
    const cs = JSON.parse(run([...args, "--dry-run", "--json", "--cwd", fixture]).stdout);
    const created = new Set((cs.changes ?? []).map((c) => c.path));

    for (const change of cs.changes ?? []) {
      if (!/\.(t|j)sx?$/.test(change.path)) continue;
      for (const spec of relativeImports(change.after)) {
        const fromDir = path.posix.dirname(change.path);
        const base = path.posix.normalize(path.posix.join(fromDir, spec)).replace(/\.js$/, "");
        if (!resolvesTo(base, created)) {
          throw new Error(`${args.join(" ")}: ${change.path} imports "${spec}" which resolves to "${base}.*" — no such generated file`);
        }
      }
    }
  }
}

function smokeDiscoverability() {
  // the list_recipes MCP tool name is kept as a compat alias; it returns add-ons.
  const mcpOut = mcpListRecipes();
  for (const name of ["cloudflare-images", "hyperdrive", "email-routing", "saas-billing"]) {
    if (!mcpOut.includes(name)) throw new Error(`MCP list_recipes missing add-on: ${name}`);
  }
  // help --all must surface the full command/add-on reference; default help stays compact.
  const helpAll = run(["help", "--all", "--no-color"]).stdout;
  for (const name of ["db d1 --orm drizzle", "cloudflare-images", "hyperdrive", "email-routing", "saas-billing"]) {
    if (!helpAll.includes(name)) throw new Error(`help --all missing add-on: ${name}`);
  }
  for (const cmd of ["diagnose", "why", "remove", "--baseline", "--diff"]) {
    if (!helpAll.includes(cmd)) throw new Error(`help --all missing command surface: ${cmd}`);
  }
  const help = run(["help", "--no-color"]).stdout;
  if (!help.includes("Start here") || !help.includes("flarecel menu") || help.includes("--baseline")) {
    throw new Error("default help should stay compact and route users to menu/help --all");
  }

  const tools = mcpToolsList();
  for (const name of ["get_progress", "preview_compose", "migrate_vercel", "explain_issue", "diagnose_error"]) {
    if (!tools.includes(name)) throw new Error(`MCP tools/list missing tool: ${name}`);
  }
  for (const removed of ["preview_kit", "list_kits"]) {
    if (tools.includes(removed)) throw new Error(`MCP tools/list should no longer expose ${removed}`);
  }

  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-mcp-catalog-"));
  try {
    cpSync(fixture, tmp, { recursive: true });
    mkdirSync(path.join(tmp, ".flarecel", "addons"), { recursive: true });
    writeFileSync(path.join(tmp, ".flarecel", "addons", "local-tool.json"), JSON.stringify({
      name: "local-tool",
      title: "Local Tool"
    }));
    const listed = mcpTool("list_recipes", { cwd: tmp });
    if (!listed.addOns?.some((addon) => addon.name === "local-tool" && addon.source === "project")) {
      throw new Error("MCP list_recipes should include project add-ons");
    }
    if (!listed.addOns?.some((addon) => addon.name === "posthog" && addon.source === "catalog")) {
      throw new Error("MCP list_recipes should include bundled catalog add-ons");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeMcpNewTools() {
  const composed = mcpTool("preview_compose", {
    cwd: fixture,
    addOns: [
      { addOn: "ai-gateway" },
      { addOn: "workers-ai" },
      { addOn: "vectorize", positionals: ["docs-search"] },
      { addOn: "observability" }
    ]
  });
  assertEqual(composed.status, "planned", "MCP preview_compose should return a planned changeset");
  if (!composed.patch?.includes("flarecel-vectorize")) throw new Error("MCP preview_compose should include composed patch content");
  const wranglerChanges = (composed.changes ?? []).filter((c) => c.path === "wrangler.jsonc").length;
  if (wranglerChanges !== 1) throw new Error("MCP preview_compose should merge wrangler.jsonc into one change");

  // preview_patch accepts the current `addOn` arg and the legacy `recipe` alias.
  const viaAddOn = mcpTool("preview_patch", { cwd: fixture, operation: "add", addOn: "kv", positionals: ["cache"] });
  assertEqual(viaAddOn.status, "planned", "preview_patch should accept the addOn arg");
  const viaLegacy = mcpTool("preview_patch", { cwd: fixture, operation: "add", recipe: "kv", positionals: ["cache"] });
  assertEqual(viaLegacy.status, "planned", "preview_patch should still accept the legacy recipe alias");

  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-mcp-migrate-"));
  try {
    mkdirSync(path.join(tmp, "app"), { recursive: true });
    writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "m", dependencies: { next: "^15" } }));
    writeFileSync(path.join(tmp, "vercel.json"), JSON.stringify({
      redirects: [{ source: "/old", destination: "/new", permanent: true }],
      headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
      crons: [{ path: "/api/cleanup", schedule: "0 0 * * *" }]
    }));
    const migration = mcpTool("migrate_vercel", { cwd: tmp });
    assertEqual(migration.status, "planned", "MCP migrate_vercel should return a planned changeset");
    if (!migration.patch?.includes("wrangler.jsonc")) throw new Error("MCP migrate_vercel should include a patch");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const explanation = mcpTool("explain_issue", { id: "missing-opennext" });
  if (!explanation.what || !explanation.why || !explanation.change) {
    throw new Error("MCP explain_issue should return the explanation beats");
  }

  const diagnose = mcpTool("diagnose_error", { text: "No such module 'node:crypto'" });
  if (!diagnose.matches?.some((match) => match.issueId === "missing-nodejs-compat")) {
    throw new Error("MCP diagnose_error should map known errors to issue ids");
  }
}

function smokeProgressAndMcpManifests() {
  const progress = run(["progress", "--json", "--cwd", fixture]);
  assertEqual(progress.status, 0, `progress should exit cleanly: ${progress.stderr}`);
  const progressReport = JSON.parse(progress.stdout);
  if (progressReport.cloudflareAuth?.service !== "cloudflare") {
    throw new Error("progress JSON should expose Cloudflare auth status");
  }
  if (progressReport.vocabulary) {
    throw new Error("progress JSON should not include the old vocabulary block");
  }
  if (!progressReport.stages?.some((stage) => stage.id === "preview" && stage.explanation.includes("Cloudflare"))) {
    throw new Error("progress should explain Cloudflare preview");
  }

  const mcpProgress = mcpTool("get_progress", { cwd: fixture });
  if (mcpProgress.cloudflareAuth?.service !== "cloudflare") {
    throw new Error("MCP get_progress should expose Cloudflare auth status");
  }
  if (!mcpProgress.stages?.some((stage) => stage.id === "provision")) {
    throw new Error("MCP get_progress should expose the structured progress map");
  }

  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-mcp-apply-"));
  try {
    cpSync(fixture, tmp, { recursive: true });
    const applied = mcpTool("apply_patch", { cwd: tmp, operation: "add", addOn: "kv", positionals: ["cache"], confirm: true });
    assertEqual(applied.status, "applied", "MCP apply_patch should apply add add-ons");
    if (!existsSync(path.join(tmp, ".flarecel", "applied", "kv.json"))) {
      throw new Error("MCP apply_patch should write add-on manifest for why/remove provenance");
    }
    const why = run(["why", "src/cloudflare/kv-cache.ts", "--json", "--cwd", tmp]);
    assertEqual(why.status, 0, why.stderr);
    const whyReport = JSON.parse(why.stdout);
    if (!whyReport.sources?.some((source) => source.addOn === "kv")) {
      throw new Error("why should find the manifest written by MCP apply_patch");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// only local relative specifiers (./ or ../); bare package imports are out of scope here.
function relativeImports(source) {
  const specs = [];
  const re = /(?:import|export)[^"']*?from\s*["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

function resolvesTo(base, created) {
  for (const ext of ["ts", "tsx", "js", "jsx"]) {
    if (created.has(`${base}.${ext}`)) return true;
  }
  // pre-existing project files we don't generate (e.g. db schema already there).
  for (const ext of ["ts", "tsx", "js", "jsx"]) {
    try { readFileSync(path.join(fixture, `${base}.${ext}`)); return true; } catch { /* keep trying */ }
  }
  return false;
}

function mcpListRecipes() {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s", version: "0" } } });
  const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_recipes", arguments: {} } });
  const res = spawnSync(process.execPath, [cli, "mcp"], { cwd: repoRoot, encoding: "utf8", input: `${init}\n${call}\n` });
  return res.stdout;
}

function mcpToolsList() {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s", version: "0" } } });
  const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const res = spawnSync(process.execPath, [cli, "mcp"], { cwd: repoRoot, encoding: "utf8", input: `${init}\n${call}\n` });
  assertEqual(res.status, 0, `MCP tools/list exited nonzero: ${res.stderr}`);
  return res.stdout;
}

function mcpTool(name, args = {}) {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "s", version: "0" } } });
  const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const res = spawnSync(process.execPath, [cli, "mcp"], { cwd: repoRoot, encoding: "utf8", input: `${init}\n${call}\n` });
  assertEqual(res.status, 0, `MCP ${name} exited nonzero: ${res.stderr}`);
  const response = res.stdout
    .trim()
    .split(/\n/)
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 2);
  if (!response?.result) throw new Error(`MCP ${name} returned no tool result`);
  if (response.result.isError) throw new Error(`MCP ${name} returned an error: ${response.result.content?.[0]?.text}`);
  return response.result.structuredContent;
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
}

function assertNoDuplicatePaths(cs, label) {
  const seen = new Set();
  for (const c of cs.changes ?? []) {
    if (seen.has(c.path)) throw new Error(`${label}: duplicate generated path ${c.path}`);
    seen.add(c.path);
  }
}

function assertGeneratedTypescriptParses(cs) {
  for (const change of cs.changes ?? []) {
    if (!/\.(d\.ts|ts|tsx)$/.test(change.path)) continue;
    const sf = ts.createSourceFile(change.path, change.after, ts.ScriptTarget.ES2022, true, change.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if (sf.parseDiagnostics.length > 0) {
      throw new Error(sf.parseDiagnostics.map((d) => `${change.path}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`).join("\n"));
    }
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected}, got ${actual}`);
}
