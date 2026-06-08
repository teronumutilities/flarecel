// map runtime/deploy error text to existing doctor issue IDs + suggested fixes.
// strips ANSI before matching so piped wrangler output works directly.

export interface DiagnoseMatch {
  pattern: string;
  issueId: string | null;
  suggestion: string;
  explanation: string;
}

const RULES: Array<{ re: RegExp; issueId: string | null; suggestion: string; explanation: string }> = [
  { re: /No such module ["']?node:(\w+)["']?/i, issueId: "missing-nodejs-compat", suggestion: "flarecel fix --dry-run", explanation: "The Workers runtime needs the nodejs_compat compatibility flag to provide Node.js built-in modules." },
  { re: /module not found|Cannot find module/i, issueId: "missing-nodejs-compat", suggestion: "flarecel doctor --json", explanation: "A module could not be resolved. Check if it requires nodejs_compat or is not Workers-compatible." },
  { re: /D1_ERROR.*no such table/i, issueId: null, suggestion: "wrangler d1 migrations apply <db-name> --remote", explanation: "The D1 database exists but the table hasn't been created yet. Run migrations." },
  { re: /exceeded.*script size|exceeded.*Worker size/i, issueId: null, suggestion: "flarecel verify --bundle-size", explanation: "The compiled Worker exceeds the size limit. Reduce bundle size or upgrade to a paid plan." },
  { re: /Stripe.*webhook.*signature|webhook signature verification failed/i, issueId: null, suggestion: "flarecel add stripe --dry-run", explanation: "Stripe webhook verification fails on Workers with the synchronous API. Use constructEventAsync + createSubtleCryptoProvider()." },
  { re: /getCloudflareContext is not a function|Cannot read.*getCloudflareContext/i, issueId: "missing-opennext", suggestion: "flarecel add next-opennext --dry-run", explanation: "getCloudflareContext requires @opennextjs/cloudflare. Install the OpenNext adapter." },
  { re: /Worker exceeded CPU time limit/i, issueId: null, suggestion: "Review route handler CPU usage; consider offloading to a Queue.", explanation: "The Worker exceeded its CPU time budget. Move heavy work to a Cloudflare Queue consumer." },
  { re: /exceeded subrequest limit/i, issueId: null, suggestion: "Reduce fetch calls per request or batch them.", explanation: "Workers have a per-request subrequest limit (50 for paid). Reduce or batch outbound fetches." },
  { re: /BETTER_AUTH_SECRET/i, issueId: "auth-secret-missing", suggestion: "wrangler secret put BETTER_AUTH_SECRET", explanation: "Better Auth needs its secret configured as a Wrangler secret." },
  { re: /ReferenceError: process is not defined/i, issueId: "missing-nodejs-compat", suggestion: "flarecel fix --dry-run", explanation: "process is not available without nodejs_compat. Add the compatibility flag." }
];

export function diagnoseError(text: string): DiagnoseMatch[] {
  const clean = stripAnsi(text);
  const matches: DiagnoseMatch[] = [];
  for (const rule of RULES) {
    if (rule.re.test(clean)) {
      matches.push({ pattern: rule.re.source, issueId: rule.issueId, suggestion: rule.suggestion, explanation: rule.explanation });
    }
  }
  return matches;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
