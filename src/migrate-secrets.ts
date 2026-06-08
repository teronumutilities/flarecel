import { runCommand } from "./exec.js";
import type { ChangeSet, ProjectContext } from "./types.js";

// translate a Vercel project's environment variable NAMES into a Cloudflare
// `wrangler secret put` checklist. Uses `vercel env ls` (which only exposes
// names — sensitive values are never retrievable) and reuses the existing
// `vercel login`. It never reads, prints, or stores a single secret VALUE.
export async function createSecretsMigration(ctx: ProjectContext): Promise<ChangeSet> {
  const result = await runCommand("vercel", ["env", "ls", "production"], ctx.cwd, { timeoutMs: 30_000 });
  if (result.code !== 0) {
    return {
      status: "error",
      title: "Could not list Vercel environment variables",
      changes: [],
      warnings: [
        "Run requires the `vercel` CLI installed and logged in (vercel login), with the project linked (vercel link).",
        "No secret values are ever read — this only lists variable names."
      ],
      nextActions: ["npm i -g vercel", "vercel login", "vercel link", "flarecel migrate secrets"]
    };
  }

  const names = parseEnvNames(result.stdout);
  if (names.length === 0) {
    return {
      status: "empty",
      title: "No Vercel environment variables found",
      changes: [],
      warnings: ["Nothing to migrate, or the project is not linked (vercel link)."],
      nextActions: ["flarecel doctor --json"]
    };
  }

  const checklist = names.map((n) => `wrangler secret put ${n}`);
  return {
    status: "planned",
    title: `Secrets migration checklist (${names.length} variable name${names.length === 1 ? "" : "s"})`,
    changes: [],
    warnings: [
      "VALUES ARE NOT MIGRATED. Flarecel only reads variable names; Vercel does not expose sensitive values, and Flarecel never stores secrets.",
      "Run each command below and paste the value yourself. Set non-secret config as plain vars in wrangler.jsonc instead."
    ],
    nextActions: [...checklist, "flarecel verify --json"]
  };
}

// parse variable NAMES from `vercel env ls` table output. We only ever take the
// first column (the name); we deliberately ignore everything else.
function parseEnvNames(stdout: string): string[] {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // skip header/decoration lines; match a leading env-var-style token.
    const match = trimmed.match(/^([A-Z][A-Z0-9_]{1,})\b/);
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}
