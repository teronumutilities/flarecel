# Flarecel

Vercel vibes. Cloudflare bills.

Flarecel is an agent-friendly Cloudflare Workers deployment assistant. The first milestone is intentionally narrow: help a coding agent diagnose, patch, and verify a Next.js app for Cloudflare Workers through OpenNext.

It is not a hosting platform and it is not affiliated with Cloudflare or Vercel.

## "Isn't Cloudflare building their own CLI?"

Yes. Cloudflare is rebuilding Wrangler into [`cf`](https://www.theregister.com/2026/04/13/cloudflare_expanding_wrangler_cli_functionality/) — one agent-first CLI for their whole API surface — and agents can now [provision accounts and deploy in one shot](https://blog.cloudflare.com/agents-stripe-projects/). So part of what Flarecel does (provisioning, deploys) will get absorbed by the platform. We expect it, and Flarecel happily calls Wrangler/`cf` underneath rather than competing with it.

But here's the thing they aren't building: **`cf` deploys greenfield apps. It does not fix the broken ones.**

Cloudflare's flow assumes an agent is building something *new*. Flarecel exists for the messy reality — an existing Next.js app that was written for Vercel and now has to run on Workers:

- Worker-hostile packages and Node-only imports that quietly break at the edge.
- `vercel.json` redirects, headers, crons, and `@vercel/*` coupling that don't port.
- ISR, middleware, `maxDuration`, `next/image` assumptions baked in everywhere.
- The honest cost question: *what does leaving Vercel actually cost me?*

That's the part nobody at the platform vendor is going to build for you — because "here's how to migrate off the competitor" isn't their job. It's ours.

**They handle the happy path. We handle the broken Vercel migration.** Don't sumi.

## Quick Start

```bash
npx flarecel doctor --json
npx flarecel progress --json
npx flarecel cloudflare --json
npx flarecel plan --json
npx flarecel env --json
npx flarecel secrets plan --json
npx flarecel fix --dry-run --format patch
npx flarecel fix --apply --yes
npx flarecel verify --json
npx flarecel provision --json
```

## MVP Commands

```bash
flarecel doctor
flarecel progress
flarecel cloudflare
flarecel env --json
flarecel secrets plan --json
flarecel onboard
flarecel doctor --fix
flarecel plan
flarecel fix --dry-run
flarecel compose next-opennext + auth better-auth + r2 uploads + observability --dry-run
flarecel add next-opennext --dry-run --format patch
flarecel add r2 uploads --dry-run --format patch
flarecel add db d1 --orm drizzle --dry-run
flarecel add kv cache --dry-run
flarecel add rate-limit --route /api/generate --limit 20/min --dry-run
flarecel add queue emails --dry-run
flarecel add turnstile --form signup --dry-run
flarecel add cron daily-cleanup --schedule "0 0 * * *" --dry-run
flarecel add workers-ai --dry-run
flarecel add vectorize docs-search --dimensions 768 --metric cosine --dry-run
flarecel add ai-gateway --provider openai --dry-run
flarecel add observability --sampling 1 --dry-run
flarecel add durable-object room --dry-run
flarecel add workflow onboarding --schedule "0 9 * * *" --dry-run
flarecel add browser-run --dry-run
flarecel add auth better-auth --db d1 --orm drizzle --dry-run
flarecel verify
flarecel provision --json
flarecel cost --requests 1000000 --cpu-ms 7 --json
flarecel deploy --preview --yes
flarecel ci --dry-run
flarecel open
flarecel menu
flarecel mcp
```

## Agent Contract

Every core command supports machine-readable output:

```bash
flarecel doctor --json
flarecel plan --json
flarecel env --json
flarecel secrets plan --json
flarecel verify --json
```

File-changing commands default to dry-run behavior. To write files, use:

```bash
flarecel fix --apply --yes
```

The product loop is:

```txt
detect -> explain -> patch -> provision -> verify -> deploy
```

Each concept maps to a real command, which is the exact sequence the CLI prints on startup and in `flarecel help --all`:

```txt
doctor -> plan -> fix --dry-run -> fix --apply --yes -> provision -> verify -> deploy --preview -> deploy --production
```

| Concept | Command |
|---|---|
| detect | `flarecel doctor` |
| explain | `flarecel plan` (or `flarecel explain <issue-id>`) |
| patch | `flarecel fix --dry-run` then `flarecel fix --apply --yes` |
| provision | `flarecel provision` |
| verify | `flarecel verify` |
| deploy | `flarecel deploy --preview --yes` then `flarecel deploy --production --yes` |

The read-only `flarecel cloudflare` account-connection check is a precondition for provisioning and deploys, not a patch step.

## Naming

- **Add-on**: the user-facing name for a single feature installed with `flarecel add`, such as R2, D1, KV, auth, queues, Turnstile, or Vectorize.
- **Compose**: combine several add-ons into one reviewable change set with `flarecel compose <add-ons>` (e.g. `compose next-opennext + auth better-auth + r2`). Shared files like `package.json` and `wrangler.jsonc` are merged, not clobbered.
- **Recipe**: the internal/legacy word kept only for the compatibility MCP tool `list_recipes` and the legacy `recipe` arg alias. Docs, UI, and new code say add-on.

## Custom Add-ons

Flarecel ships a **catalog** of vetted add-ons that work in any project with no setup — run `flarecel add posthog`, `add sentry`, `add openai`, or `add anthropic` and they just work. The catalog is bundled with the package; no network fetch. Run `flarecel catalog list` (add `--json` for agents) to see everything available, including your project overrides.

You can also drop your own add-ons in `.flarecel/addons/*.json` and run them with `flarecel add <name>` — no repo changes, no code execution. A project add-on with the same name **overrides** a catalog one. Each file is a declarative spec (static data only):

```json
{
  "name": "sentry",
  "title": "Sentry error tracking",
  "deps": ["@sentry/cloudflare"],
  "envExample": ["SENTRY_DSN=replace-me"],
  "files": [{ "path": "lib/sentry.ts", "content": "export const app = \"{{projectName}}\";\n" }],
  "wrangler": { "compatibility_flags": ["nodejs_compat"] }
}
```

Safety boundary: specs are pure JSON — never executable JS. Flarecel validates strictly (lowercase-dash names, typed fields), blocks path traversal and absolute paths, and rejects real-looking secret values in `envExample` (use placeholders). The only templating is `{{projectName}}`. Generated output is labeled as user-authored ("Flarecel did not author this") and still runs through the normal dry-run/verify pipeline, so review it like any other change set.

For a complete, copy-paste starting point covering every field, see [`examples/addons/my-provider.json`](examples/addons/my-provider.json) and its [field reference](examples/addons/README.md).

## Compose

AI can already scaffold files, so Flarecel does not ship branded starter stacks that compete with `create-next-app`, T3, or template repos.

Instead, `flarecel compose <add-ons>` combines any add-ons you name into one reviewable change set:

- Pick the add-ons the app actually needs (the agent knows the codebase better than a frozen preset).
- Shared files (`package.json`, `wrangler.jsonc`, `cloudflare-env.d.ts`) are merged, not clobbered — the one thing a sequence of `add` calls cannot preview as a single diff.
- Keep generated files explainable and removable.
- Stay small enough that a human can review the diff before `--apply --yes`.

Example: `flarecel compose next-opennext + auth better-auth + r2 uploads + queue emails + rate-limit + observability --dry-run`.

## Quality Rails

This repo is allowed to start from taste and instinct, but changes should not stay vibes-only.

Run this before trusting generated add-on work:

```bash
npm test
```

The smoke suite builds the CLI, checks JSON/MCP output, parses generated TypeScript add-ons, verifies Better Auth + D1 checks, and confirms provisioning plans emit exact Wrangler commands where Cloudflare has an explicit creation command.

Optional live Cloudflare usage check:

```bash
FLARECEL_RUN_CLOUDFLARE_LIVE_TEST=1 npm run test:cloudflare-live
```

That test reuses `wrangler login` / `CLOUDFLARE_API_TOKEN`, calls Cloudflare Analytics for `cost --cloudflare-live`, and fails if output leaks the token.

## Current Scope

Implemented now:

- Project/framework detection.
- Next.js/OpenNext readiness checks.
- Wrangler config checks.
- Risk checks for common Worker-hostile packages and source imports.
- Agent-readable `doctor`, `plan`, and `verify` output.
- Plain-language `progress` / `onboard` output that explains doctor, add-ons, compose, provisioning, preview deploys, and production gates.
- Dry-run patch generation.
- Apply-safe fixes with `--apply --yes`.
- MVP add-ons for OpenNext, R2 uploads, D1 + Drizzle, KV cache, Rate Limiting, Queues, Turnstile, Cron Triggers, Workers AI, Vectorize, AI Gateway, Observability, Durable Objects, Workflows, and Browser Run.
- MVP Better Auth + D1 + Drizzle add-on.
- Experimental third-party add-ons (verified against provider + Cloudflare docs, 2026-06-04): `auth clerk`, `auth supabase`, `auth authjs`, `auth cloudflare-access`, `db d1 --orm prisma`, `db supabase`, `db neon`, `db turso`, `db planetscale`, `db mongodb`, `backend convex`, `redis upstash`. Each generates Workers-safe client code and is labeled experimental in its generated doc.
- `flarecel compose <add-ons>` composes any add-ons you name into one reviewable change set, merging shared files instead of clobbering them.
- `doctor --fix` to chain doctor -> fix -> verify in one call.
- Startup shows a separate Auth section, and `flarecel auth` reports Cloudflare/Vercel CLI status plus the exact setup commands. `flarecel auth cloudflare` runs the Wrangler login flow; `flarecel auth vercel` runs the Vercel login flow. Cloudflare auth is core; Vercel auth stays optional for migration/live-bill helpers.
- `cloudflare` is a read-only account connection check. It compares local `wrangler.jsonc` needs against real Cloudflare resources through Wrangler: R2, D1, KV, Queues, and detected secrets. It also names local-only coverage for newer bindings like Vectorize, Durable Objects, Workflows, Browser Run, Rate Limiting, Hyperdrive, and AI Gateway instead of silently pretending they were verified. Unused products show as `not used`, not failures.
- `env` and `secrets plan` audit env names from common env files and source usage. They classify public/config/secret names, emit exact `wrangler secret put <NAME>` setup commands for secrets, and never print values.
- `verify` checks Wrangler config and, when project dependencies are installed, runs local `wrangler whoami` to confirm Cloudflare auth. Fix with `wrangler login` locally or `CLOUDFLARE_API_TOKEN` in CI.
- `migrate vercel` to translate `vercel.json` (redirects, headers, crons) and env key names into Cloudflare equivalents, flagging what does not port. It also scans Vercel-shaped coupling even when `vercel.json` is missing: middleware/proxy, ISR/revalidation, `maxDuration`, `next/image`, Vercel env names, and `@vercel/*` packages.
- `explain <issue-id>` for plain-language explanations of doctor findings.
- `cost --cloudflare-live` reads real Cloudflare Analytics usage for Workers, R2, D1, and KV when you opt in with an existing `wrangler login` session or `CLOUDFLARE_API_TOKEN`. If live usage cannot be read, Flarecel exits with an error instead of falling back to assumptions. It never stores or prints the token.
- `cost` is honest about the Cloudflare plan. If you do not pass `--plan free`, `--plan paid`, or `--cloudflare-live`, the plan is reported as `unknown` (with `planConfidence: "low"` and `estimateIsRange: true`) and you get a `$0–$5/mo` baseline range instead of a confident Workers Paid assumption: Workers Free may be `$0/mo` for testing and low traffic, while Workers Paid starts at `$5/mo` before usage. Pass `--plan paid` for the conservative `$5`-baseline estimate, `--plan free` for an explicit free-tier estimate, or `--cloudflare-live` to price real account usage (which pins the conservative Paid floor at high confidence). Agents can read `plan`, `planAssumed`, `planConfidence`, `estimateIsRange`, `recommendedDisplay`, and `costBasis` to avoid mistaking a range for a quote.
- `cost --compare vercel` (experimental) is hard-railed: Flarecel estimates Cloudflare cost, but only shows a Vercel comparison when you pass `--vercel-monthly-usd` or opt into `--vercel-live` with an already-authenticated `vercel usage` CLI. No token is stored, and Flarecel does not invent Vercel bills. Cost output is freshness-stamped (`pricingVerifiedOn`), shows an honest low/high range, flags spike-prone bindings (`billShockRisks`), and grounds the estimate in the app's detected route count.
- Experimental `add isr` (OpenNext R2 incremental cache), `add stripe` (Workers-safe webhook), and `add resend` add-ons.
- Opt-in `verify --runtime` / `npm run verify:runtime` that boots the built worker in workerd (miniflare).
- Pinned add-on dependency versions (caret ranges) instead of `latest`, with `npm run update-versions` to refresh safely and `npm run verify:providers` to type-check provider add-ons against the real installed packages.
- Provision planning from Wrangler bindings.
- Cost estimation and gated preview/production deploy planning.
- `flarecel ci` generates a GitHub Actions workflow that deploys to Cloudflare on push (push to `main` + manual `workflow_dispatch`). Dry-run by default, written with `--apply --yes`, package-manager aware, and uses the project's own `deploy` script for Next.js/OpenNext or `cloudflare/wrangler-action` otherwise. It expects a `CLOUDFLARE_API_TOKEN` repo secret and never reads or writes that token.
- Worker versions listing and gated production rollback (`versions`, `rollback --yes`).
- Stdio MCP server with tool discovery, prompts/resources, core tool calls, structured progress, compose previews, Vercel migration previews, env/secrets audits, issue explanations, and error diagnosis. MCP `apply_patch` records add-on manifests so `why` and `remove` still work after agents apply changes.
- Lightweight `flarecel open` local report generation.
- Interactive `flarecel menu`: a scrollable, collapsible command menu with explanations that update as you move (arrow keys to move, left/right to collapse/expand groups, Enter to run). TTY-only; falls back to static help when piped or non-interactive.

Still future:

- Rich Cloudflare resource provisioning UX.
- Domains, logs, and analytics. These are post-launch operations, not v1 blockers: domains help production cutover, logs help debugging deployed Workers, and analytics help cost/perf review later.
- Full visual local UI.

## Field notes — 2026-06-10 end-to-end run

A real build done entirely through Flarecel: a plain Worker site with a
D1-backed guestbook, Turnstile, secrets, a custom domain, and a cross-account
migration. What held up, and where the seams showed.

**Held up well**

- `doctor` / `verify --json`: readiness 100, framework auto-detect, structured
  checks — an agent parsed and acted on the output with zero text-scraping.
- Error → next-action mapping: `deploy --preview` against a not-yet-created
  Worker failed with the exact fix ("bootstrap once with `deploy --production
  --yes`"). Saved a debugging loop — this is the strongest part of the UX.
- Honest cost: surfaced the `$5` paid floor + range instead of faking "free."
- Dry-run-by-default on `add` produced a full, reviewable patch plan.

**Seams (concrete, prioritized)**

1. **Provisioning loop isn't closed** (→ "Rich Cloudflare resource provisioning
   UX"). `add db d1` scaffolds the binding but hands off to manual `wrangler d1
   create` + pasting the `database_id` back into `wrangler.jsonc`. Running the
   create and writing the id back (with confirmation) would remove the only
   reason this run dropped to raw wrangler for storage.
2. **Secrets are plan-only.** `secrets plan` emits the right `wrangler secret
   put` commands but doesn't set them; setting `ADMIN_KEY` / `TURNSTILE_SECRET`
   was raw wrangler. A gated `secrets set` would finish the loop that `env` /
   `secrets plan` start.
3. **Error pass-through degrades off the happy path** (→ "Domains"). A
   custom-domain trigger failure surfaced only as "some triggers failed"; the
   actionable cause (apex already had an externally-managed DNS record, CF API
   code `100117`) was buried in wrangler logs and needed a raw API call to find.
   Flarecel already excels at error→next-action where it has a model — extend
   that to common trigger/DNS conflicts ("delete the conflicting apex record,
   then redeploy").
4. **No multi-account model.** A cross-account migration (switch `account_id`,
   recreate D1, rebind domain) was all manual edits + raw API. A target-account
   concept / `--account` flag would make migration — and "you're on the wrong
   account" — a first-class, guard-railed flow.
5. **D1 add-on is ORM-opinionated.** `add db d1` assumes Drizzle + a migrations
   toolchain; for a single-table app that's overkill, so this run bypassed it
   with native D1. A `--orm none` / raw-D1 variant keeps lean cases inside the
   tool.

**Net:** the diagnose → explain → safe-patch → gated-deploy spine is strong and
the guardrails are tasteful. The fall-throughs are all infra plumbing (D1
create, secrets, domains, accounts) — exactly the "Still future" provisioning
items above, now with concrete failure modes to design against.
