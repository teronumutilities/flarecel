import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChangeSet } from "./types.js";

const HASH_PATH = ".flarecel/hashes.json";

// Deterministic hash of a recipe's output: sorted paths + after-content + recipe key.
export function computeChangeSetHash(recipeKey: string, changeSet: ChangeSet): string {
  const h = createHash("sha256");
  h.update(recipeKey);
  for (const change of [...changeSet.changes].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(change.path);
    h.update(change.after);
  }
  return h.digest("hex");
}

export async function loadHashes(cwd: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(path.join(cwd, HASH_PATH), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function saveHash(cwd: string, recipeKey: string, hash: string): Promise<void> {
  const hashes = await loadHashes(cwd);
  hashes[recipeKey] = hash;
  const target = path.join(cwd, HASH_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(hashes, null, 2) + "\n", "utf8");
}

export async function isUnchanged(cwd: string, recipeKey: string, changeSet: ChangeSet): Promise<boolean> {
  const hashes = await loadHashes(cwd);
  const current = computeChangeSetHash(recipeKey, changeSet);
  return hashes[recipeKey] === current;
}
