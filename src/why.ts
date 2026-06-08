import { listManifests, findManifest } from "./manifest.js";

export interface WhyResult {
  path: string;
  sources: Array<{ addOn: string; timestamp: string; reason: string }>;
}

export function whyFile(cwd: string, filePath: string): WhyResult {
  const sources: WhyResult["sources"] = [];
  for (const slug of listManifests(cwd)) {
    const manifest = findManifest(cwd, slug);
    if (!manifest) continue;
    for (const change of manifest.changes) {
      if (change.path === filePath) {
        sources.push({ addOn: manifest.addOn, timestamp: manifest.timestamp, reason: change.reason });
      }
    }
  }
  return { path: filePath, sources };
}
