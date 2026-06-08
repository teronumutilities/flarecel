import { VERIFIED_ON, depVersion } from "./addon-versions.js";
import {
  packageJsonChange, wranglerChange, fileChange, appendEnvTypes, appendLinesChange
} from "./addon-changes.js";
import type { JsonObject } from "./addon-utils.js";
import type { ChangeSet, PlannedChange, ProjectContext } from "./types.js";

export interface AddOnOptions {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export interface IntegrationFile {
  path: (ctx: ProjectContext) => string;
  content: (ctx: ProjectContext) => string;
  reason: string;
}

export interface IntegrationSpec {
  title: string;
  deps?: string[];
  devDeps?: string[];
  envTypes?: string[];
  envExample?: string[];
  files?: IntegrationFile[];
  wrangler?: (config: JsonObject, ctx: ProjectContext) => void;
  warnings?: string[];
  nextActions?: string[];
  docPath: string;
  doc: string;
}

export async function externalIntegrationAddOn(ctx: ProjectContext, spec: IntegrationSpec): Promise<ChangeSet> {
  const changes: PlannedChange[] = [];

  if (spec.deps?.length || spec.devDeps?.length) {
    changes.push(await packageJsonChange(ctx, `Add ${spec.title} dependencies`, (pkg) => {
      if (spec.deps?.length) {
        pkg.dependencies = pkg.dependencies ?? {};
        for (const dep of spec.deps) pkg.dependencies[dep] = pkg.dependencies[dep] ?? depVersion(dep);
      }
      if (spec.devDeps?.length) {
        pkg.devDependencies = pkg.devDependencies ?? {};
        for (const dep of spec.devDeps) pkg.devDependencies[dep] = pkg.devDependencies[dep] ?? depVersion(dep);
      }
    }));
  }

  if (spec.wrangler) {
    changes.push(await wranglerChange(ctx, `Configure ${spec.title} bindings`, (config) => spec.wrangler!(config, ctx)));
  }

  for (const file of spec.files ?? []) {
    changes.push(await fileChange(ctx, file.path(ctx), file.content(ctx), file.reason));
  }

  if (spec.envTypes?.length) {
    changes.push(await appendEnvTypes(ctx, spec.envTypes, `Add ${spec.title} env/binding types`));
  }

  if (spec.envExample?.length) {
    changes.push(await appendLinesChange(ctx, ".dev.vars.example", spec.envExample, `Document ${spec.title} local env values`));
  }

  changes.push(await fileChange(ctx, spec.docPath, spec.doc, `Explain ${spec.title} add-on`));

  return {
    status: "planned",
    title: `Add ${spec.title}`,
    changes: changes.filter((change) => change.before !== change.after),
    warnings: [
      `EXPERIMENTAL add-on. Verified against provider + Cloudflare docs on ${VERIFIED_ON}; re-check before production.`,
      "Does not run npm install or set remote secrets.",
      ...(spec.warnings ?? [])
    ],
    nextActions: spec.nextActions ?? ["npm install", "flarecel verify --json"]
  };
}

export function integrationDoc(title: string, body: string): string {
  return `# Flarecel: ${title}\n\nExperimental add-on. Verified on ${VERIFIED_ON}.\n\n${body}\n`;
}
