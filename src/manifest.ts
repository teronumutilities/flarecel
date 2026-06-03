import { promises as fs } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ChangeSet, PlannedChange } from "./types.js";

const MANIFEST_DIR = ".flarecel/applied";

export interface Manifest {
  recipe: string;
  timestamp: string;
  changes: PlannedChange[];
}

export async function writeManifest(cwd: string, recipe: string, changeSet: ChangeSet): Promise<void> {
  const dir = path.join(cwd, MANIFEST_DIR);
  await fs.mkdir(dir, { recursive: true });
  const manifest: Manifest = {
    recipe,
    timestamp: new Date().toISOString(),
    changes: changeSet.changes
  };
  const slug = recipe.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export function findManifest(cwd: string, recipe: string): Manifest | null {
  const dir = path.join(cwd, MANIFEST_DIR);
  const slug = recipe.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const file = path.join(dir, `${slug}.json`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

export interface RemoveResult {
  status: "planned" | "applied" | "refused" | "not-found";
  recipe: string;
  changes: PlannedChange[];
  conflicts: Array<{ path: string; expected: string; actual: string }>;
}

export async function createRemoveChangeSet(cwd: string, recipe: string, force: boolean): Promise<RemoveResult> {
  const manifest = findManifest(cwd, recipe);
  if (!manifest) return { status: "not-found", recipe, changes: [], conflicts: [] };

  const conflicts: RemoveResult["conflicts"] = [];
  const changes: PlannedChange[] = [];

  for (const change of manifest.changes) {
    const filePath = path.join(cwd, change.path);
    let current: string | null = null;
    try {
      current = readFileSync(filePath, "utf8");
    } catch { /* file deleted by user — no conflict */ }

    if (current !== null && current !== change.after && !force) {
      conflicts.push({ path: change.path, expected: change.after.slice(0, 200), actual: current.slice(0, 200) });
      continue;
    }

    // Invert: restore before content, or delete if file was created from nothing.
    changes.push({
      path: change.path,
      before: current,
      after: change.before ?? "", // empty string = will be deleted
      reason: `Remove: revert ${change.path} from recipe ${recipe}`
    });
  }

  if (conflicts.length > 0 && !force) {
    return { status: "refused", recipe, changes: [], conflicts };
  }

  return { status: "planned", recipe, changes, conflicts: [] };
}

export async function applyRemove(cwd: string, result: RemoveResult): Promise<RemoveResult> {
  for (const change of result.changes) {
    const target = path.join(cwd, change.path);
    if (change.after === "") {
      await fs.unlink(target).catch(() => {});
    } else {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, change.after, "utf8");
    }
  }
  return { ...result, status: "applied" };
}

export function listManifests(cwd: string): string[] {
  const dir = path.join(cwd, MANIFEST_DIR);
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
  } catch {
    return [];
  }
}
