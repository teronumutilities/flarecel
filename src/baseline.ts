import { promises as fs } from "node:fs";
import path from "node:path";
import type { DoctorReport, Issue } from "./types.js";

const BASELINE_PATH = ".flarecel/baseline.json";

interface Baseline {
  timestamp: string;
  issues: Array<{ id: string; severity: string; title: string }>;
}

export interface DiffResult {
  baseline: Baseline;
  current: Array<{ id: string; severity: string; title: string }>;
  new: Array<{ id: string; severity: string; title: string }>;
  resolved: Array<{ id: string; severity: string; title: string }>;
}

export async function saveBaseline(cwd: string, report: DoctorReport): Promise<string> {
  const baseline: Baseline = {
    timestamp: new Date().toISOString(),
    issues: report.issues.map((i) => ({ id: i.id, severity: i.severity, title: i.title }))
  };
  const target = path.join(cwd, BASELINE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  return target;
}

export async function diffBaseline(cwd: string, report: DoctorReport): Promise<DiffResult | null> {
  const baselinePath = path.join(cwd, BASELINE_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(baselinePath, "utf8");
  } catch {
    return null;
  }

  const baseline = JSON.parse(raw) as Baseline;
  const current = report.issues.map((i) => ({ id: i.id, severity: i.severity, title: i.title }));
  const baselineIds = new Set(baseline.issues.map((i) => i.id));
  const currentIds = new Set(current.map((i) => i.id));

  return {
    baseline,
    current,
    new: current.filter((i) => !baselineIds.has(i.id)),
    resolved: baseline.issues.filter((i) => !currentIds.has(i.id))
  };
}
