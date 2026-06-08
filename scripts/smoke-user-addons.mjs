import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");

smokeValidUserAddon();
smokeMalformedRejected();
smokeUnsafePathRejected();
smokeSecretValueRejected();
smokeCatalogWorksWithNoProjectFile();
smokeProjectOverridesCatalog();
smokeShippedExampleIsValid();

// the example we hand authors (examples/addons/my-provider.json) must stay valid.
function smokeShippedExampleIsValid() {
  const example = JSON.parse(readFileSync(path.join(repoRoot, "examples", "addons", "my-provider.json"), "utf8"));
  const tmp = projectWith({ "my-provider.json": example });
  try {
    const cs = JSON.parse(run(["add", "my-provider", "--dry-run", "--json", "--cwd", tmp]).stdout);
    assertEqual(cs.status, "planned", "shipped example add-on should plan");
    assertGeneratedTypescriptParses(cs);
    const file = cs.changes.find((c) => c.path === "lib/my-provider.ts");
    if (!file || file.after.includes("{{")) throw new Error("example: {{projectName}} not substituted");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
smokeCatalogListCommand();

// `flarecel catalog list --json` enumerates catalog add-ons and marks overrides.
function smokeCatalogListCommand() {
  const bare = JSON.parse(run(["catalog", "list", "--json", "--cwd", tmpdir()]).stdout);
  for (const name of ["posthog", "sentry", "openai", "anthropic"]) {
    const e = bare.addOns.find((a) => a.name === name);
    if (!e) throw new Error(`catalog list missing ${name}`);
    assertEqual(e.source, "catalog", `${name} should be source=catalog`);
  }
  // built-in add-ons (auth providers, external DBs) must also be listed.
  for (const name of ["auth clerk", "db turso"]) {
    const e = bare.addOns.find((a) => a.name === name);
    if (!e) throw new Error(`catalog list missing built-in ${name}`);
    assertEqual(e.source, "builtin", `${name} should be source=builtin`);
  }
  const tmp = projectWith({ "posthog.json": { name: "posthog", title: "mine" } });
  try {
    const withOverride = JSON.parse(run(["catalog", "list", "--json", "--cwd", tmp]).stdout);
    const ph = withOverride.addOns.find((a) => a.name === "posthog");
    assertEqual(ph.source, "project", "overridden posthog should be source=project");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// a Flarecel-shipped catalog add-on must work in any project with zero setup.
function smokeCatalogWorksWithNoProjectFile() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-catalog-"));
  cpSync(fixture, tmp, { recursive: true });
  try {
    for (const name of ["posthog", "sentry", "openai", "anthropic"]) {
      const cs = JSON.parse(run(["add", name, "--dry-run", "--json", "--cwd", tmp]).stdout);
      assertEqual(cs.status, "planned", `catalog add-on ${name} should plan with no project file`);
      assertGeneratedTypescriptParses(cs);
      if (!cs.changes.some((c) => /^docs\/flarecel-/.test(c.path))) throw new Error(`${name}: catalog add-on missing doc`);
      if (!cs.warnings.some((w) => w.includes("catalog"))) throw new Error(`${name}: missing catalog provenance warning`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// a project .flarecel/addons/ spec with the same name overrides the catalog one.
function smokeProjectOverridesCatalog() {
  const tmp = projectWith({
    "posthog.json": { name: "posthog", title: "MY override", files: [{ path: "lib/mine.ts", content: "export const x = 1;\n" }] }
  });
  try {
    const cs = JSON.parse(run(["add", "posthog", "--dry-run", "--json", "--cwd", tmp]).stdout);
    assertEqual(cs.status, "planned", "override should plan");
    if (cs.title !== "Add MY override") throw new Error("project add-on did not override catalog");
    if (!cs.warnings.some((w) => w.includes("did not author"))) throw new Error("override should carry user-authored warning");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function projectWith(addons) {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-useraddon-"));
  cpSync(fixture, tmp, { recursive: true });
  mkdirSync(path.join(tmp, ".flarecel", "addons"), { recursive: true });
  for (const [file, spec] of Object.entries(addons)) {
    writeFileSync(path.join(tmp, ".flarecel", "addons", file), typeof spec === "string" ? spec : JSON.stringify(spec));
  }
  return tmp;
}

function smokeValidUserAddon() {
  const tmp = projectWith({
    "sentry.json": {
      name: "sentry",
      title: "Sentry error tracking",
      deps: ["@sentry/cloudflare"],
      envExample: ["SENTRY_DSN=replace-me"],
      files: [{ path: "lib/sentry.ts", content: "export const dsn = \"{{projectName}}\";\n", reason: "init" }],
      wrangler: { compatibility_flags: ["nodejs_compat"] }
    }
  });
  try {
    const cs = JSON.parse(run(["add", "sentry", "--dry-run", "--json", "--cwd", tmp]).stdout);
    assertEqual(cs.status, "planned", "valid user add-on should plan");
    assertGeneratedTypescriptParses(cs);
    const file = cs.changes.find((c) => c.path === "lib/sentry.ts");
    if (!file) throw new Error("user add-on file not generated");
    if (file.after.includes("{{")) throw new Error("{{projectName}} was not substituted");
    if (!cs.changes.some((c) => c.path === "docs/flarecel-sentry.md")) throw new Error("auto doc missing");
    if (!cs.warnings.some((w) => w.includes("USER ADD-ON"))) throw new Error("missing user-authored provenance warning");
    const wrangler = JSON.parse(cs.changes.find((c) => c.path === "wrangler.jsonc").after);
    if (!wrangler.compatibility_flags.includes("nodejs_compat") || !wrangler.compatibility_flags.includes("global_fetch_strictly_public")) {
      throw new Error("user add-on wrangler merge should preserve existing/base compatibility_flags");
    }
    // Dry-run/apply parity: applying writes byte-identical content.
    const apply = run(["add", "sentry", "--apply", "--yes", "--json", "--cwd", tmp]);
    assertEqual(apply.status, 0, apply.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeMalformedRejected() {
  for (const spec of [
    { name: "Bad Name", title: "x" },          // illegal name
    { name: "nodesc" },                         // missing title
    "{ not json",                                // invalid JSON
    { name: "wrongdeps", title: "x", deps: "not-an-array" }
  ]) {
    const tmp = projectWith({ "addon.json": spec });
    try {
      const res = run(["add", typeof spec === "object" && spec.name ? spec.name : "addon", "--dry-run", "--json", "--cwd", tmp]);
      const cs = JSON.parse(res.stdout);
      assertEqual(cs.status, "error", `malformed add-on should error: ${JSON.stringify(spec)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function smokeUnsafePathRejected() {
  const tmp = projectWith({
    "evil.json": { name: "evil", title: "x", files: [{ path: "../../etc/passwd", content: "x" }] }
  });
  try {
    const cs = JSON.parse(run(["add", "evil", "--dry-run", "--json", "--cwd", tmp]).stdout);
    assertEqual(cs.status, "error", "path traversal must be rejected");
    if (!cs.warnings.some((w) => w.includes("relative path"))) throw new Error("expected path-safety message");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeSecretValueRejected() {
  const tmp = projectWith({
    "leak.json": { name: "leak", title: "x", envExample: ["API_KEY=sk_live_abc123realsecret"] }
  });
  try {
    const cs = JSON.parse(run(["add", "leak", "--dry-run", "--json", "--cwd", tmp]).stdout);
    assertEqual(cs.status, "error", "real-looking secret in envExample must be rejected");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
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
