// Plain-language explanations of doctor issue ids, for non-technical builders.
// Four beats each: what it is, why your app needs it, what Flarecel changes,
// is it safe / how to undo. `verifiedBy` points to the verify check that
// confirms the fix landed, where one exists.
export interface Explanation {
  id: string;
  what: string;
  why: string;
  change: string;
  safety: string;
  verifiedBy?: string;
}

const EXPLANATIONS: Record<string, Explanation> = {
  "missing-opennext": {
    id: "missing-opennext",
    what: "Your Next.js app needs an adapter to run on Cloudflare instead of Vercel.",
    why: "Cloudflare runs apps differently; the OpenNext adapter is what makes Next.js work there.",
    change: "Flarecel adds the @opennextjs/cloudflare package and the build/deploy scripts.",
    safety: "Safe — it adds files and dependencies. Undo by reverting the change or removing the package.",
    verifiedBy: "opennext-installed"
  },
  "missing-wrangler-config": {
    id: "missing-wrangler-config",
    what: "Cloudflare needs a settings file (wrangler.jsonc) describing your app.",
    why: "It tells Cloudflare your app's name, entry point, and which services it connects to.",
    change: "Flarecel creates wrangler.jsonc with sensible defaults.",
    safety: "Safe — it's a new config file you can edit or delete.",
    verifiedBy: "wrangler-config"
  },
  "missing-nodejs-compat": {
    id: "missing-nodejs-compat",
    what: "A setting that tells Cloudflare your app needs Node.js-style features.",
    why: "Next.js on Cloudflare expects these features; without the flag, parts of your app can break.",
    change: "Flarecel adds the nodejs_compat compatibility flag to wrangler.jsonc.",
    safety: "Safe — it only enables runtime features. Remove the flag to undo.",
    verifiedBy: "wrangler-config"
  },
  "missing-global-fetch-strictly-public": {
    id: "missing-global-fetch-strictly-public",
    what: "A setting that makes your app's network requests behave safely on Cloudflare.",
    why: "OpenNext recommends it so internal requests are handled correctly.",
    change: "Flarecel adds the global_fetch_strictly_public flag to wrangler.jsonc.",
    safety: "Safe — remove the flag to undo."
  },
  "toml-config": {
    id: "toml-config",
    what: "Your Cloudflare config uses the older TOML format.",
    why: "Flarecel reads TOML but only edits the newer JSONC format safely.",
    change: "Flarecel leaves your TOML alone and may generate a JSONC version for review.",
    safety: "Safe — nothing is deleted. Pick one format before deploying."
  },
  "invalid-wrangler-jsonc": {
    id: "invalid-wrangler-jsonc",
    what: "Your Cloudflare settings file has a syntax error and can't be read.",
    why: "If Flarecel can't read it, it can't safely add services to it.",
    change: "Flarecel does not edit it; you fix the JSON error first.",
    safety: "No change made until the file is valid."
  },
  "next-on-pages-installed": {
    id: "next-on-pages-installed",
    what: "An older Cloudflare adapter (next-on-pages) is installed.",
    why: "The current path is OpenNext on Workers; the old one can conflict.",
    change: "Flarecel flags it; remove next-on-pages during migration.",
    safety: "Review before removing in case other code references it."
  },
  "next-on-pages-import": {
    id: "next-on-pages-import",
    what: "Your code imports from the older next-on-pages adapter.",
    why: "Those imports won't work under OpenNext.",
    change: "Flarecel flags the files; replace with @opennextjs/cloudflare equivalents.",
    safety: "Manual edit — review each import."
  },
  "edge-runtime-export": {
    id: "edge-runtime-export",
    what: "A page is set to use Vercel's 'edge' runtime.",
    why: "OpenNext on Cloudflare expects the normal Node.js runtime instead.",
    change: "Flarecel flags it; remove `export const runtime = \"edge\"` from the file.",
    safety: "Manual edit — verify the route still behaves as expected."
  },
  "next-image-on-workers": {
    id: "next-image-on-workers",
    what: "Your app uses next/image, which optimizes images differently on Cloudflare.",
    why: "Cloudflare's Worker doesn't sit in front of files the way Vercel does, so default image optimization may not work the same.",
    change: "Flarecel flags it; use Cloudflare Images, a custom loader, or unoptimized images.",
    safety: "Informational — images still load; only optimization differs."
  },
  "vercel-config-present": {
    id: "vercel-config-present",
    what: "A vercel.json file was found.",
    why: "Its rewrites, headers, and crons may need translating to Cloudflare.",
    change: "Run `flarecel migrate vercel` to translate what ports cleanly and flag what doesn't.",
    safety: "Safe — migration is dry-run first."
  },
  "auth-secret-missing": {
    id: "auth-secret-missing",
    what: "Your auth library is set up but its secret key isn't configured for Cloudflare.",
    why: "Without the secret, sign-in will fail in production.",
    change: "Flarecel flags it; set it with `wrangler secret put BETTER_AUTH_SECRET`.",
    safety: "Safe — you're adding a secret, not changing code.",
    verifiedBy: "better-auth-secret-type"
  },
  "unknown-framework": {
    id: "unknown-framework",
    what: "Flarecel couldn't recognize your web framework.",
    why: "It tailors checks and fixes per framework (Next.js, Astro, etc.).",
    change: "No change; confirm the project uses a supported framework.",
    safety: "No change made."
  },
  "missing-package-json": {
    id: "missing-package-json",
    what: "No package.json was found in this folder.",
    why: "Flarecel needs to run inside a JavaScript/TypeScript project.",
    change: "No change; run Flarecel from your project root.",
    safety: "No change made."
  },
  "invalid-package-json": {
    id: "invalid-package-json",
    what: "Your package.json has a syntax error.",
    why: "Flarecel can't read your dependencies until it's valid JSON.",
    change: "No change; fix the JSON error first.",
    safety: "No change made."
  }
};

export function explainIssue(id: string): Explanation | null {
  if (EXPLANATIONS[id]) return EXPLANATIONS[id];
  if (id.startsWith("risky-package-")) {
    const name = id.slice("risky-package-".length);
    return {
      id,
      what: `The package "${name}" may not work on Cloudflare Workers.`,
      why: "Some packages assume a full server or native code that Workers doesn't provide.",
      change: "Flarecel flags it; consider a Workers-friendly alternative.",
      safety: "Review before removing; it may be used elsewhere."
    };
  }
  if (id.startsWith("node-api-import-")) {
    const api = id.slice("node-api-import-".length);
    return {
      id,
      what: `Your code uses the Node.js "${api}" feature.`,
      why: "Workers supports many Node features via a compatibility flag, but some behave differently.",
      change: "Flarecel flags the files; verify they work with nodejs_compat.",
      safety: "Informational — review the flagged files."
    };
  }
  return null;
}

export function listExplainableIds(): string[] {
  return Object.keys(EXPLANATIONS);
}
