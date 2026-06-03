import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChangeSet, PlannedChange } from "./types.js";

export function renderPatch(changes: PlannedChange[]): string {
  if (changes.length === 0) return "";

  return changes.map((change) => renderChange(change)).join("\n");
}

export async function applyChangeSet(cwd: string, changeSet: ChangeSet): Promise<ChangeSet> {
  for (const change of changeSet.changes) {
    const target = path.join(cwd, change.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, change.after, "utf8");
  }

  return {
    ...changeSet,
    status: changeSet.changes.length > 0 ? "applied" : "empty",
    nextActions: changeSet.nextActions.filter((action) => !action.includes("--apply"))
  };
}

export function dedupeChanges(changes: PlannedChange[]): PlannedChange[] {
  const byPath = new Map<string, PlannedChange>();

  for (const change of changes) {
    byPath.set(change.path, change);
  }

  return [...byPath.values()];
}

function renderChange(change: PlannedChange): string {
  if (change.before === change.after) return "";

  const header = [
    `diff --git a/${change.path} b/${change.path}`,
    change.before === null ? "new file mode 100644" : undefined,
    change.before === null ? "--- /dev/null" : `--- a/${change.path}`,
    `+++ b/${change.path}`,
    "@@"
  ].filter(Boolean).join("\n");

  const beforeLines = change.before === null ? [] : normalizeLines(change.before).map((line) => `-${line}`);
  const afterLines = normalizeLines(change.after).map((line) => `+${line}`);

  return `${header}\n${[...beforeLines, ...afterLines].join("\n")}\n`;
}

function normalizeLines(value: string): string[] {
  const lines = value.replace(/\n$/, "").split("\n");
  return lines.length === 1 && lines[0] === "" ? [] : lines;
}
