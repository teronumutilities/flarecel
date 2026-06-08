import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyChangeSet } from "./patches.js";
import { detectProject, readFileIfExists } from "./project.js";
import { resolveAddOnChangeSet } from "./addon-dispatch.js";
import type { ChangeSet, PlannedChange, ProjectContext } from "./types.js";

export interface ComposeStep {
  addOn: string;
  positionals?: string[];
  flags?: Record<string, string | boolean>;
}

// compose an explicit list of add-ons into ONE reviewable change set. State is
// threaded through a temp working copy so add-ons that mutate shared files
// (package.json, wrangler.jsonc, cloudflare-env.d.ts) accumulate instead of
// clobbering each other; then we diff back to a single change set. This is the
// one thing a sequence of dry-run `add` calls cannot do.
export async function createComposeChangeSet(ctx: ProjectContext, steps: ComposeStep[]): Promise<ChangeSet> {
  if (steps.length === 0) {
    return {
      status: "error",
      title: "Nothing to compose",
      changes: [],
      warnings: ["compose requires at least one add-on, e.g. `flarecel compose r2 kv observability`."],
      nextActions: ["flarecel catalog list --json"]
    };
  }

  const work = mkdtempSync(path.join(tmpdir(), "flarecel-compose-"));
  const warnings: string[] = [];
  try {
    copyProject(ctx.cwd, work);

    for (const step of steps) {
      const workCtx = await detectProject(work);
      const changeSet = await resolveAddOnChangeSet(workCtx, step.addOn, {
        positionals: [...(step.positionals ?? [])],
        flags: { ...(step.flags ?? {}) }
      });
      if (changeSet.status === "error") {
        return {
          status: "error",
          title: `Compose failed at add-on: ${step.addOn}`,
          changes: [],
          warnings: changeSet.warnings,
          nextActions: ["flarecel doctor --json"]
        };
      }
      for (const warning of changeSet.warnings) {
        if (!warnings.includes(warning)) warnings.push(warning);
      }
      await applyChangeSet(work, changeSet);
    }

    const changes = await diffProject(ctx.cwd, work);
    const names = steps.map((step) => step.addOn).join(", ");
    return {
      status: changes.length > 0 ? "planned" : "empty",
      title: `Compose add-ons: ${names}`,
      changes,
      warnings: [
        "This composes multiple add-ons into one change set. Review all generated files before applying.",
        "It does not run npm install or create remote Cloudflare resources.",
        ...warnings
      ],
      nextActions: [
        "npm install",
        "npm run cf-typegen",
        "flarecel provision --json",
        "flarecel verify --json"
      ]
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const COMPOSE_IGNORE = /^(?:node_modules|\.git|\.next|\.open-next|dist|\.flarecel)$/;

function copyProject(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !COMPOSE_IGNORE.test(path.basename(src))
  });
}

async function diffProject(projectDir: string, work: string): Promise<PlannedChange[]> {
  const changes: PlannedChange[] = [];

  const collect = async (relativeDir: string): Promise<void> => {
    for (const entry of readdirSync(path.join(work, relativeDir), { withFileTypes: true })) {
      if (COMPOSE_IGNORE.test(entry.name)) continue;
      const rel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await collect(rel);
        continue;
      }
      const after = readFileSync(path.join(work, rel), "utf8");
      const original = await readFileIfExists(path.join(projectDir, rel));
      if (original !== after) {
        changes.push({ path: rel, before: original, after, reason: "Composed change" });
      }
    }
  };

  await collect("");
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
