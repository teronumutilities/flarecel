# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Flarecel is a single-binary TypeScript CLI (`dist/cli.js`) that helps coding agents diagnose, patch, and deploy Next.js/OpenNext apps to Cloudflare Workers. It is **not** a hosting platform — it inspects a target project (passed via `--cwd`) and emits JSON, dry-run patches, or executes Wrangler commands. There is no runtime server beyond the optional stdio MCP server.

The product loop, baked into `cli.ts`, README, and AGENTS.md:

```
doctor -> plan -> fix --dry-run -> fix --apply --yes -> provision -> verify -> deploy --preview -> deploy --production
```

## Commands

- `npm run build` — `tsc` to `dist/`. Required before any `node dist/cli.js …` invocation.
- `npm test` — runs every `smoke:*` script in sequence. Each smoke builds first, then exercises a CLI surface (MCP, add-ons, compose, providers, env-migrate, agent-loop, openai-batch, menu, cloudflare, user-addons, rollback, remote-addons, deploy-cost, redact, byebye, exec timeout, auth). This is the only test gate — there is no separate unit test runner.
- `npm run typecheck` — `tsc --noEmit`.
- Run a single smoke: `npm run smoke:<name>` (e.g. `npm run smoke:auth`). Each script under `scripts/` is a standalone `.mjs` that shells out to `node dist/cli.js` and asserts JSON shape.
- `npm run verify:providers` — type-checks generated provider add-on output against the real installed packages.
- `npm run update-versions` — refreshes pinned add-on dep versions in `src/addon-versions.ts`.
- `npm run verify:runtime` / `flarecel verify --runtime` — opt-in workerd boot of the built worker. Not part of `npm test`.
- `FLARECEL_RUN_CLOUDFLARE_LIVE_TEST=1 npm run test:cloudflare-live` — live Cloudflare Analytics integration test; requires `wrangler login` or `CLOUDFLARE_API_TOKEN`.

Fixtures live in `fixtures/{next-basic,next-saas,next-toml}/` — smokes target these via `--cwd fixtures/<name>`.

## Architecture

**Entry point.** `src/cli.ts` is a single `main()` that dispatches on `args.command`. Every command branch follows the same shape: detect project → build a report/change-set → emit JSON or pretty-print → set `process.exitCode`. Exit codes are part of the public agent contract (see AGENTS.md):

```
0 ready · 1 warnings · 2 blocking · 3 auth/secrets missing · 4 unsupported/unknown · 5 confirmation required
```

**Project detection.** `src/project.ts` → `detectProject(cwd)` returns a `ProjectContext` (see `src/types.ts`) capturing framework, package manager, wrangler config, source risks, route counts. Almost every other module takes `ProjectContext` as input — it is the universal handle on the target project.

**Change sets.** File-mutating commands (`fix`, `add`, `compose`, `migrate vercel`) never write directly. They build a `ChangeSet` (`types.ts`) of `PlannedChange[]` and route through `src/patches.ts` (`applyChangeSet`, `renderPatch`). Apply only happens with both `--apply` and `--yes`. After apply, `src/manifest.ts` records the change set under `.flarecel/applied/<slug>.json` so `flarecel why <file>` and `flarecel remove <addon>` can reverse it.

**Add-on system.** This is the bulk of the codebase. The dispatcher (`src/addon-dispatch.ts`) maps an add-on name → a function that produces a `ChangeSet`. Implementations are split by shape:

- `addon-bindings.ts` — first-party Cloudflare bindings (R2, D1+Drizzle, KV, Queues, Turnstile, Cron, Workers AI, Vectorize, AI Gateway, Observability, Durable Objects, Workflows, Browser Run, rate-limit).
- `addon-providers.ts` — third-party providers (Clerk, Supabase, Auth.js, Cloudflare Access, Prisma, Neon, Turso, PlanetScale, Mongo, Convex, Upstash, Stripe, Resend, Cloudflare Images, Hyperdrive, Email Routing).
- `addon-stacks.ts` — multi-piece stacks (Better Auth, SaaS billing).
- `addon-opennext.ts` — Next.js → OpenNext adapter and ISR.
- `addon-templates.ts` — the file-content templates these emit (largest file in the repo).
- `addon-spec.ts` / `addon-utils.ts` / `addon-changes.ts` — shared change-set plumbing.
- `addon-versions.ts` — pinned caret-range versions for generated `package.json` deps.
- `addons.ts` — public catalog list (`ADD_ONS`) with maturity flags (`mvp` vs `experimental`).

**User add-ons.** `src/user-addons.ts` loads two extra sources: the bundled JSON catalog in `catalog/*.json` (Anthropic, OpenAI, PostHog, Sentry) and project overrides in `.flarecel/addons/*.json`. Both are pure-JSON declarative specs — never executable. Validation rejects path traversal, absolute paths, and real-looking secret values; only `{{projectName}}` is templated. Project files override catalog files of the same name. `flarecel add <https-url>` fetches a remote spec, runs the same validation, and refuses to write without `--apply --yes --trust`.

**Compose.** `src/compose.ts` runs multiple add-ons over the same project and merges shared files (`package.json`, `wrangler.jsonc`, `cloudflare-env.d.ts`) instead of clobbering. CLI `compose` accepts `+`-separated tokens; agents using MCP should call `preview_compose` with a structured `addOns` array for per-add-on flag fidelity.

**Cloudflare surface.** Read-only checks live in `src/cloudflare.ts` (`createCloudflareConnectionReport` — compares `wrangler.jsonc` bindings vs real account resources via Wrangler) and `src/cloudflare-usage.ts` (live Analytics for `cost --cloudflare-live`). `src/provision.ts` plans Wrangler resource-creation commands. `src/deploy.ts` and `src/rollback.ts` plan and gate `wrangler deploy` / `wrangler rollback`. All shell-outs go through `src/exec.ts` `runCommand` (async spawn, captures output, default 120s timeout, never rejects).

**MCP server.** `flarecel mcp` (no `--json`) starts a stdio JSON-RPC server in `src/mcp.ts` exposing tool calls (`run_doctor`, `preview_patch`, `preview_compose`, `apply_patch`, `plan_provisioning`, `estimate_cost`, `migrate_vercel`, `audit_env`, `plan_secrets`, `explain_issue`, `diagnose_error`, etc.). `apply_patch` writes the same manifests as the CLI so `why`/`remove` keep working after agent-driven applies. The `list_recipes` tool name is legacy — it returns add-ons.

**Output.** `src/output.ts` owns all pretty-printing; `src/ui.ts` owns ANSI/spinner/banner. `src/redact.ts` scrubs secrets. Color is disabled automatically when stdout is piped, when `--no-color`/`--json`/`--format patch` is set, or when `NO_COLOR` is in the env — never emit ANSI in machine-readable paths.

## Agent contract (binding)

These rules are enforced by code and tests; do not weaken them when editing:

- Every core command has a `--json` mode. JSON, `--format patch`, and `--no-color` paths must stay color-free and never print secret values.
- File-changing commands default to dry-run. Writes require `--apply --yes` (exit 5 otherwise).
- Production deploy and rollback require explicit `--yes` (exit 5 otherwise). `cloudflare` is read-only and is a precondition for provision/deploy, not a patch step.
- `cost` reports `plan: "unknown"` with `planConfidence: "low"` and a `$0–$5/mo` range unless `--plan free|paid` or `--cloudflare-live` is passed. Do not change the default to assume Workers Paid.
- Add-on output that originates from user/remote specs must be labeled "Flarecel did not author this" (see `addon-spec.ts`).

## Conventions

- ESM only (`"type": "module"`, `module: NodeNext`). Imports inside `src/` use `.js` suffixes (TS NodeNext requirement). Node ≥ 20.
- No runtime deps. Everything in `src/` runs on the Node stdlib + spawned `wrangler`/`vercel` CLIs.
- TypeScript `strict: true`. The codebase prefers narrow inline types in `types.ts` plus per-module interfaces over a deep type hierarchy.
- New add-ons: add an entry to `ADD_ONS` in `addons.ts`, wire dispatch in `addon-dispatch.ts`, put templates in `addon-templates.ts`, pin deps in `addon-versions.ts`, add a smoke under `scripts/smoke-*.mjs` and chain it into the `test` script in `package.json`.
- New commands: branch in `cli.ts`, add a printer in `output.ts`, expose via `mcp.ts` if it is agent-relevant, document the `--json` shape in AGENTS.md.
