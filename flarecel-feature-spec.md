# Flarecel Feature Spec

Working name: **Flarecel**

Tagline:

> Vercel vibes. Cloudflare bills.

Status: concept spec plus working CLI MVP scaffold, June 3, 2026

Disclaimer:

> Flarecel is an independent open-source project and is not affiliated with Cloudflare or Vercel.

---

## 1. What Flarecel Is

Flarecel is an open-source tool that helps builders move from "I want to create" to "my app is running on Cloudflare Workers" without getting stuck in platform configuration.

It is not a hosting company. It is not a full Vercel clone. It is a **Cloudflare app accelerator**.

Flarecel should help users:

- Understand whether their app is a good Cloudflare fit.
- Fix common Cloudflare Workers compatibility issues.
- Add Cloudflare-native app features like R2, D1, Queues, Rate Limits, Turnstile, Durable Objects, Workflows, Vectorize, Workers AI, and AI Gateway.
- Connect popular app services like Better Auth, Clerk, Supabase, Prisma, Drizzle, Convex, Neon, Turso, Upstash, Stripe, Resend, and more.
- Give coding agents deterministic commands, JSON output, dry-run patches, and safe deployment flows.

The core idea:

> Flarecel installs Cloudflare-native superpowers into modern web apps.

After more discussion, the identity should stay simple:

> Flarecel gives coding agents Cloudflare judgment.

It should not become "Flarecel Studio" or a hosted platform. The CLI is the product. The optional visual view exists only to make the CLI understandable for non-technical builders.

---

## 2. The Problem

Cloudflare Workers is powerful and economical, but it can feel painful compared to Vercel.

Common pain points:

- Next.js deployment requires understanding OpenNext, Wrangler, compatibility flags, Workers runtime behavior, and build output.
- Cloudflare bindings are powerful but not obvious to non-technical builders.
- R2, D1, KV, Queues, Durable Objects, Workflows, Hyperdrive, Vectorize, and Workers AI each have their own setup rituals.
- Auth and database integrations can break because Cloudflare Workers is not a normal Node.js server.
- Environment variables, secrets, preview/prod config, generated types, and local dev behavior are easy to get wrong.
- Debugging production errors is hard if logs, tracing, and request IDs are not set up early.
- Coding agents can make unsafe guesses unless tools give them structured output and safe patches.

Vercel hides much of this. Cloudflare gives more platform power, but the builder has to learn more.

Flarecel should reduce that gap.

---

## 3. Who It Is For

### Non-Technical Builders

People who use AI coding tools and want to ship apps without becoming Cloudflare experts.

They should be able to run one command, see what their app needs in plain language, and approve safe changes.

### Agentic Builders

People using Codex, Cursor, Claude Code, or other coding agents.

Agents should be able to run Flarecel commands, read JSON results, apply patches, verify fixes, and avoid unsafe deploys.

### Developers

Developers who like Cloudflare but want less setup pain.

They should be able to use Flarecel as a CLI:

```bash
npx flarecel doctor
npx flarecel add auth better-auth --db d1 --orm drizzle
npx flarecel add r2 uploads
npx flarecel deploy --preview
```

---

## 4. Product Shape

Flarecel should have two faces.

### 4.1 CLI First

Example commands:

```bash
npx flarecel doctor
npx flarecel plan
npx flarecel add r2 uploads
npx flarecel add auth better-auth --db d1 --orm drizzle
npx flarecel add rate-limit --route /api/generate
npx flarecel fix --dry-run
npx flarecel deploy --preview
```

The CLI should support:

- Human-readable output.
- JSON output with `--json`.
- Patch output with `--format patch`.
- Dry-run mode.
- Non-interactive mode with `--yes`.
- Clear exit codes.

The CLI is the main product. Everything else exists to make the CLI easier to understand or easier for agents to operate.

### 4.2 Optional `flarecel open`

Example command:

```bash
npx flarecel open
```

This opens an optional local view:

```txt
Flarecel

Project: my-saas-app
Status: Needs 3 fixes

Issues:
[ ] Cloudflare config missing
[ ] R2 upload bucket not configured
[ ] Better Auth is not connected to D1

Recommended Stack:
Auth: Better Auth
Database: D1 + Drizzle
Storage: R2
Protection: Rate Limit + Turnstile
Background Jobs: Queues

[Explain This] [Apply Fixes] [Preview Deploy]
```

This is not a separate "Studio" product. It is just a friendlier way to inspect what the CLI already knows.

The local view should translate technical concepts:

Technical:

> Add `r2_buckets` binding to `wrangler.jsonc`.

Human version:

> Your app needs somewhere to store uploaded files. On Cloudflare, this is called R2. Flarecel will create a storage bucket and connect it to your app.

---

## 5. Programming Language And Tech Stack

Recommended stack:

- Language: **TypeScript**
- Package platform: **npm**
- CLI runtime: **Node.js**
- Dashboard: **React + Vite**
- Cloudflare deployment helper: **Wrangler**
- Next.js portability layer: **OpenNext Cloudflare**
- Agent integration: **MCP server**
- File edits: structured patches

Why TypeScript:

- Cloudflare Workers tooling is mostly JS/TS.
- Next.js apps are usually JS/TS.
- npm CLI tools are naturally JS/TS.
- Coding agents understand TypeScript well.
- OpenNext, Wrangler, and most app integrations live in this ecosystem.

---

## 6. What Makes Flarecel Different

### Wrangler

Wrangler is Cloudflare's official power tool.

Flarecel should not replace Wrangler. It should make Wrangler easier to use by generating config, explaining errors, creating bindings, and orchestrating common app patterns.

### OpenNext

OpenNext Cloudflare transforms Next.js apps so they can run on Cloudflare Workers.

Flarecel should not replace OpenNext. It should sit above OpenNext and handle app-level setup:

- Auth
- Databases
- Storage
- Rate limits
- Queues
- Workflows
- AI
- Observability
- Env vars and secrets
- Agent-readable verification

Reference: https://opennext.js.org/cloudflare

### Diverce

Diverce focuses on migrating Vercel Next.js projects to Cloudflare.

Flarecel should be broader:

- CLI-first
- Agent-friendly
- Recipe-based
- Cloudflare-native feature installer
- Works for new apps and existing apps
- Has an optional local view for non-technical builders

### Not Just Crosscheck

Flarecel should not be only a checklist or linter.

The product loop is:

```txt
detect -> explain -> patch -> provision -> verify -> deploy
```

That means Flarecel should:

- Detect Cloudflare problems.
- Explain them in human language.
- Generate exact patches.
- Create or connect Cloudflare resources when approved.
- Verify the app in the closest possible Workers runtime.
- Deploy previews safely.

The serious value is not "your config is wrong." The serious value is "here is the safe fix, here is what it changes, here is the proof it works."

---

## 7. Core Commands

The banger DevEX should be:

```txt
Idea -> Plan -> Patch -> Provision -> Preview -> Verify -> Deploy -> Monitor
```

Flarecel should make Cloudflare feel less like a collection of separate services and more like a coherent app layer that agents can operate safely.

### 7.1 Doctor

```bash
flarecel doctor
flarecel doctor --json
```

Purpose:

Check whether a project is ready for Cloudflare Workers.

Checks:

- Framework detection: Next.js, Vite, Astro, Remix, SvelteKit, Hono, TanStack Start.
- Package manager detection: npm, pnpm, yarn, bun.
- Existing Cloudflare config.
- Existing Vercel config.
- OpenNext setup.
- `nodejs_compat` compatibility flag.
- Worker size risk.
- Unsupported Node APIs.
- Native dependency risk.
- Env var and secret issues.
- Local dev mismatch.
- Missing binding types.
- Build scripts.
- Preview/prod environment drift.

Example output:

```txt
Flarecel Doctor

Project: Next.js
Cloudflare readiness: 72/100

Blocking:
- Missing OpenNext Cloudflare adapter
- Missing wrangler.jsonc

Warnings:
- Uses Prisma. D1 requires @prisma/adapter-d1 and SQLite provider.
- Auth middleware may call the database too early.

Suggested:
- Add R2 for uploads
- Add Queue for Stripe webhook processing
- Add Rate Limit for /api/generate
```

### 7.2 Plan

```bash
flarecel plan
flarecel plan --json
```

Purpose:

Show the recommended Cloudflare migration or setup path.

Example:

```txt
Recommended plan:

1. Install @opennextjs/cloudflare
2. Create wrangler.jsonc
3. Enable nodejs_compat
4. Add D1 binding
5. Add Better Auth with Drizzle
6. Add R2 uploads
7. Add Rate Limit to /api/*
8. Generate Cloudflare binding types
9. Deploy preview
```

### 7.3 Add

```bash
flarecel add <recipe>
```

Purpose:

Install a Cloudflare-native or third-party integration recipe.

Examples:

```bash
flarecel add r2 uploads
flarecel add db d1 --orm drizzle
flarecel add auth better-auth --db d1 --orm drizzle
flarecel add rate-limit --route /api/generate --limit 20/min
flarecel add queue emails
flarecel add turnstile --form signup
flarecel add ai-gateway
```

### 7.4 Fix

```bash
flarecel fix --dry-run
flarecel fix --dry-run --format patch
flarecel fix --apply
```

Purpose:

Apply safe, known fixes.

Important:

Default should be dry-run. Users and agents should see exactly what changes before applying.

### 7.5 Verify

```bash
flarecel verify
```

Purpose:

Run build checks, type checks, generated type checks, local preview checks, and integration-specific checks.

### 7.6 Deploy

```bash
flarecel deploy --preview
flarecel deploy --production --yes
```

Purpose:

Wrap the correct deploy command for the project.

Rules:

- Preview deploy by default.
- Production deploy requires explicit `--production --yes`.
- Never print secrets.
- Show cost warnings before production.

### 7.7 Cost

```bash
flarecel cost
flarecel cost --compare vercel
```

Purpose:

Estimate Cloudflare costs based on expected usage:

- Worker requests
- CPU time
- R2 storage and operations
- D1 reads/writes/storage
- KV operations
- Queue operations
- Durable Object usage
- Workers AI usage
- Vectorize usage
- Logs and observability

This should be framed as an estimate, not a billing guarantee.

### 7.8 Open

```bash
flarecel open
```

Purpose:

Launch the optional local view for non-technical users.

### 7.9 MCP

```bash
flarecel mcp
```

Purpose:

Expose Flarecel as an agent tool.

MCP tools:

- `detect_project`
- `run_doctor`
- `generate_plan`
- `list_recipes`
- `preview_patch`
- `apply_patch`
- `verify_project`
- `estimate_cost`
- `deploy_preview`

---

## 8. Agent-Friendly Design

Agents need structured, deterministic behavior.

This is not a side feature. This is the center of the product.

Flarecel should help agents avoid guessing Cloudflare configuration. The agent should ask Flarecel what is wrong, request a patch, apply it, verify it, and only then deploy.

Ideal agent flow:

```bash
flarecel doctor --json
flarecel plan --json
flarecel fix --dry-run --format patch
flarecel fix --apply
flarecel verify --json
flarecel deploy --preview --yes
```

Every major command should support:

```bash
--json
--dry-run
--format patch
--yes
--no-color
```

### JSON Output Example

```json
{
  "status": "warning",
  "projectType": "nextjs",
  "readinessScore": 72,
  "issues": [
    {
      "id": "missing-opennext",
      "severity": "blocking",
      "message": "Next.js on Cloudflare Workers requires the OpenNext Cloudflare adapter.",
      "fixable": true,
      "recipe": "next-opennext"
    },
    {
      "id": "missing-nodejs-compat",
      "severity": "high",
      "file": "wrangler.jsonc",
      "message": "This project likely needs the nodejs_compat compatibility flag.",
      "fixable": true
    }
  ]
}
```

### Exit Codes

Suggested exit codes:

```txt
0 = ready
1 = warnings
2 = blocking issue
3 = auth/secrets missing
4 = unsupported project
5 = user confirmation required
```

### Agent Rules

Ship an `AGENTS.md`:

```md
# Using Flarecel As An Agent

Prefer:
- `flarecel doctor --json`
- `flarecel plan --json`
- `flarecel fix --dry-run --format patch`
- `flarecel verify`

Never parse human output if JSON is available.
Never deploy production without explicit user approval.
Never print secrets.
```

Core agent promise:

> Do not make the coding agent invent Cloudflare setup from vibes. Let Flarecel produce the plan, patch, and verification result.

---

## 9. Recipe System

Flarecel should be recipe-based.

Each recipe should define:

- `detect`: determine whether the recipe applies.
- `plan`: explain what would happen.
- `patch`: generate file changes.
- `apply`: apply changes.
- `verify`: confirm the integration works.
- `explain`: explain in human language.
- `agentOutput`: emit structured JSON.

Suggested folder structure:

```txt
recipes/
  next-opennext/
  r2-uploads/
  d1-drizzle/
  d1-prisma/
  better-auth-d1-drizzle/
  clerk/
  supabase/
  convex/
  rate-limit/
  turnstile/
  queue/
  cron/
  durable-object/
  workflow/
  vectorize/
  ai-gateway/
  observability/
```

---

## 10. Core Cloudflare Recipes

### 10.1 Next.js + OpenNext

Command:

```bash
flarecel add next-opennext
```

Generates or fixes:

- `@opennextjs/cloudflare`
- Wrangler config
- compatibility date
- `nodejs_compat`
- build scripts
- preview scripts
- static assets config
- OpenNext cache settings
- optional R2 cache binding

References:

- https://opennext.js.org/cloudflare
- https://opennext.js.org/cloudflare/cli
- https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/

### 10.2 R2 Uploads

Command:

```bash
flarecel add r2 uploads
```

Use cases:

- User avatars
- Product images
- PDFs
- Generated assets
- Private files
- Public media

Generates:

- R2 bucket binding
- upload route
- download route
- optional signed upload flow
- optional signed download flow
- file key helper
- MIME validation
- max file size guard
- dashboard explanation

Human explanation:

> R2 is Cloudflare's file storage. Use it when your app needs uploads, images, documents, exports, or generated files.

### 10.3 D1 + Drizzle

Command:

```bash
flarecel add db d1 --orm drizzle
```

Use cases:

- Small to medium app database
- SaaS starter
- Auth tables
- Product catalogs
- User settings

Generates:

- D1 binding
- Drizzle setup
- migration scripts
- typed DB helper
- local dev setup
- generated binding types

### 10.4 D1 + Prisma

Command:

```bash
flarecel add db d1 --orm prisma
```

Generates:

- D1 binding
- Prisma SQLite provider setup
- `@prisma/adapter-d1`
- migration workflow
- warnings about Preview support and D1 limitations

Reference:

- https://docs.prisma.io/docs/v6/orm/overview/databases/cloudflare-d1

### 10.5 KV Cache

Command:

```bash
flarecel add kv cache
```

Use cases:

- Config cache
- Feature flags
- Public page cache
- Low-write, high-read key-value data

Warnings:

- KV is eventually consistent.
- Not for strict counters or transactions.

### 10.6 Rate Limits

Command:

```bash
flarecel add rate-limit --route /api/generate --key user --limit 20/min
```

Use cases:

- AI API protection
- Login protection
- Signup protection
- Public API throttling
- Form spam reduction

Generates:

- Rate Limiting binding
- route helper
- user/IP key strategy
- 429 response
- optional Analytics Engine event

Important explanation:

> Cloudflare rate limits are fast and useful for abuse protection, but counters are per Cloudflare location and eventually consistent. They are not exact billing meters.

Reference:

- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

### 10.7 Turnstile

Command:

```bash
flarecel add turnstile --form signup
```

Use cases:

- Signup forms
- Waitlists
- Contact forms
- Login protection
- Checkout protection

Generates:

- Turnstile verification helper
- form integration
- secret setup instructions
- dashboard explanation

Reference:

- https://developers.cloudflare.com/workers/examples/turnstile-html-rewriter/

### 10.8 Queues

Command:

```bash
flarecel add queue emails
flarecel add queue webhooks
flarecel add queue image-processing
```

Use cases:

- Background emails
- Stripe webhooks
- Retry jobs
- AI jobs
- Image processing
- Analytics fanout

Generates:

- Queue producer binding
- Queue consumer Worker
- retry config
- dead-letter strategy
- local dev notes

Reference:

- https://developers.cloudflare.com/queues/configuration/

### 10.9 Cron Triggers

Command:

```bash
flarecel add cron daily-cleanup --schedule "0 0 * * *"
```

Use cases:

- Daily cleanup
- Digest emails
- Sync jobs
- Billing checks
- Cache warmups

Generates:

- scheduled handler
- Wrangler cron trigger config
- verification command

### 10.10 Durable Objects

Command:

```bash
flarecel add durable-object chat-room
flarecel add realtime presence
```

Use cases:

- Chat rooms
- Multiplayer
- Collaborative editing
- Presence
- WebSocket rooms
- Per-user stateful agents

Generates:

- Durable Object class
- binding
- migration config
- WebSocket example
- typed stubs

Reference:

- https://developers.cloudflare.com/durable-objects/

### 10.11 Workflows

Command:

```bash
flarecel add workflow onboarding
flarecel add workflow ai-research-job
```

Use cases:

- Multi-step onboarding
- Long-running jobs
- Retryable business processes
- AI research flows
- Billing workflows

Generates:

- Workflow entrypoint
- trigger route
- status route
- retry pattern
- dashboard explanation

Reference:

- https://www.cloudflare.com/developer-platform/products/workflows/

### 10.12 Vectorize

Command:

```bash
flarecel add vectorize docs-search
```

Use cases:

- Semantic search
- RAG
- Recommendations
- Similarity search
- Memory for AI apps

Generates:

- Vectorize binding
- index setup
- embedding helper
- query helper
- optional Workers AI embedding model
- optional R2 document storage

Reference:

- https://developers.cloudflare.com/vectorize/

### 10.13 Workers AI

Command:

```bash
flarecel add workers-ai
```

Use cases:

- Embeddings
- LLM calls
- Text generation
- Classification
- Speech-to-text
- Image generation

Generates:

- AI binding
- model helper
- rate limit recommendation
- cost warning
- optional AI Gateway route

Reference:

- https://www.cloudflare.com/developer-platform/products/workers-ai/

### 10.14 AI Gateway

Command:

```bash
flarecel add ai-gateway
```

Use cases:

- OpenAI-compatible routing
- Model observability
- Retries
- Caching
- Cost tracking
- Multi-provider AI apps

Generates:

- provider config
- base URL helper
- logging metadata
- rate limit recommendation

Reference:

- https://ai.cloudflare.com/gateway

### 10.15 Browser Rendering

Command:

```bash
flarecel add browser-rendering
```

Use cases:

- Screenshots
- PDF rendering
- Crawling
- Agent browsing
- Web scraping with a real browser

Generates:

- Browser binding
- Puppeteer setup
- screenshot route
- guardrails and rate limits

Reference:

- https://developers.cloudflare.com/browser-rendering/platform/puppeteer/

---

## 11. Auth Recipes

### 11.1 Better Auth

Command:

```bash
flarecel add auth better-auth --db d1 --orm drizzle
```

This should be a flagship recipe.

Why:

- Better Auth is self-hosted.
- It is TypeScript-native.
- It supports multiple database adapters.
- It fits builders who want to avoid expensive hosted auth.
- It can become a Cloudflare-native auth stack when paired with D1, Drizzle, Turnstile, and Queues.

Generates:

- Better Auth install
- auth config
- route handler
- D1 + Drizzle schema
- migration commands
- social provider secret setup
- Turnstile option
- email provider option
- safe session middleware/proxy guidance
- Worker env binding access pattern

Important checks:

- Does auth config need access to Worker `env`?
- Is middleware/proxy making database calls in a risky runtime?
- Are secrets stored as Wrangler secrets?
- Are preview domains configured for OAuth callbacks?
- Are cookies configured correctly for production domains?

References:

- https://better-auth.com/docs/concepts/database
- https://www.better-auth.com/docs/integrations/next

### 11.2 Clerk

Command:

```bash
flarecel add auth clerk
```

Generates:

- env var checklist
- Wrangler secret setup
- Next.js provider check
- middleware/proxy check
- preview URL warning
- dynamic rendering warning

Reference:

- https://clerk.com/docs/nextjs/overview

### 11.3 Supabase Auth

Command:

```bash
flarecel add auth supabase
```

Generates:

- Supabase client setup
- server client helper
- env var setup
- callback URL checklist
- Cloudflare secret setup

Reference:

- https://supabase.com/docs/guides/integrations/cloudflare-workers

### 11.4 Auth.js

Command:

```bash
flarecel add auth authjs
```

Generates:

- compatibility checks
- database adapter guidance
- env secret setup
- route handler
- warning if selected adapter is not Worker-friendly

### 11.5 Cloudflare Access

Command:

```bash
flarecel add auth cloudflare-access
```

Use cases:

- Admin dashboards
- Internal tools
- Team-only apps
- Private staging environments

Generates:

- Access explanation
- route protection checklist
- identity header verification helper

---

## 12. Database And External Backend Recipes

### 12.1 Supabase

Command:

```bash
flarecel add db supabase --mode http
flarecel add db supabase --mode hyperdrive
```

Modes:

- `http`: use `@supabase/supabase-js`, good for PostgREST-style access.
- `hyperdrive`: use direct Postgres via Hyperdrive, good for SQL drivers and ORMs.

References:

- https://supabase.com/docs/guides/integrations/cloudflare-workers
- https://developers.cloudflare.com/workers/databases/third-party-integrations/supabase/

### 12.2 Neon

Command:

```bash
flarecel add db neon --mode serverless
flarecel add db neon --mode hyperdrive
```

Use cases:

- Postgres apps
- Prisma/Drizzle apps
- SaaS apps needing traditional SQL

### 12.3 Turso

Command:

```bash
flarecel add db turso
```

Use cases:

- SQLite-compatible distributed DB
- Drizzle apps
- Small global apps

### 12.4 PlanetScale

Command:

```bash
flarecel add db planetscale
```

Use cases:

- MySQL apps
- Existing PlanetScale users

### 12.5 MongoDB

Command:

```bash
flarecel add db mongodb
```

Use cases:

- Existing MongoDB apps
- Atlas Data API style access

Warning:

- Native drivers may not always behave like normal Node in Workers. Flarecel should detect and suggest Worker-friendly connection modes.

### 12.6 Convex

Command:

```bash
flarecel add backend convex
```

Treat Convex as an external backend platform, not just a database.

Use cases:

- Realtime data
- Server functions
- Collaborative apps
- Apps already using Convex

Flarecel should:

- Detect Convex usage.
- Check env vars.
- Check Next.js integration.
- Warn when Cloudflare features are redundant.
- Offer Better Auth + Convex compatibility guidance.

### 12.7 Upstash Redis

Command:

```bash
flarecel add redis upstash
```

Use cases:

- Redis-style cache
- Rate limits
- Session-ish state
- Queues outside Cloudflare

Warning:

- Prefer Cloudflare-native rate limiting or KV where appropriate.

---

## 13. App Kits

App kits are bundles of recipes.

This is where Flarecel becomes exciting for builders who want to create first and understand the details later.

### 13.1 SaaS Kit

Command:

```bash
flarecel kit saas
```

Includes:

- Better Auth
- D1 + Drizzle
- R2 uploads
- Queues for email/webhooks
- Rate limits
- Turnstile
- Stripe webhook queue
- Observability
- Preview deploy setup

### 13.2 AI App Kit

Command:

```bash
flarecel kit ai-app
```

Includes:

- AI Gateway
- Workers AI or external OpenAI-compatible provider
- Vectorize
- R2 document storage
- Queues for ingestion
- Rate limits
- Cost estimator
- request logging

### 13.3 Realtime Kit

Command:

```bash
flarecel kit realtime
```

Includes:

- Durable Objects
- WebSockets
- Presence
- Chat room example
- Optional R2/KV persistence

### 13.4 Creator App Kit

Command:

```bash
flarecel kit creator
```

Includes:

- Auth
- R2 media uploads
- Image routes
- Turnstile
- Rate limits
- Optional Stripe
- Optional AI generation queue

### 13.5 Internal Tool Kit

Command:

```bash
flarecel kit internal-tool
```

Includes:

- Cloudflare Access
- D1 or external Postgres
- audit logs
- admin route protection
- preview deploy setup

---

## 14. Observability

Command:

```bash
flarecel add observability
```

Generates:

- request ID helper
- structured logging
- error wrapper
- route timing
- 429 counter logs
- queue failure logs
- AI cost metadata
- optional Analytics Engine binding

Human explanation:

> Observability helps you understand what happened when your app breaks in production.

---

## 15. Security And Safety

Flarecel must feel safe.

Rules:

- Default file changes to dry-run.
- Never print secrets.
- Never commit secrets to files.
- Production deploy requires `--production --yes`.
- Show cost-impact warnings before expensive features.
- Label experimental recipes clearly.
- Validate OAuth callback domains.
- Validate cookie production config.
- Warn when database calls happen in risky middleware/proxy contexts.
- Warn when rate limits are being used for exact billing.
- Warn when Durable Object alarms or loops could create high usage.

---

## 16. Non-Technical UX Principles

The dashboard should use plain language.

Replace:

> Binding

With:

> A connection between your app and a Cloudflare resource.

Replace:

> D1

With:

> Cloudflare's SQL database.

Replace:

> R2

With:

> Cloudflare's file storage.

Replace:

> Queue

With:

> A background job line for work that should not block the user.

Replace:

> Durable Object

With:

> A tiny stateful worker for realtime rooms, chat, presence, or coordination.

Replace:

> Worker compatibility flag

With:

> A setting that tells Cloudflare which runtime features your app needs.

Every recipe should include:

- What this does.
- Why your app might need it.
- What files will change.
- What Cloudflare resources will be created.
- What could cost money.
- How to undo it.

---

## 17. MVP

The first useful version should not try to support everything.

The MVP should prove that Flarecel is more than a crosschecker.

It must demonstrate:

- Diagnose a real Cloudflare problem.
- Generate a real patch.
- Add at least one useful Cloudflare feature.
- Verify the app after changes.
- Emit JSON that agents can trust.

Current scaffold status:

- CLI commands exist for `doctor`, `plan`, `fix`, `add`, `verify`, `provision`, `cost`, `deploy`, `open`, and `mcp`.
- File-changing commands support dry-run review and explicit `--apply --yes`.
- The smoke suite builds the CLI, validates MCP output, parses generated TypeScript recipe files, and checks key verifier/provisioning behavior.
- Deploy is gated behind verification and explicit confirmation.
- Cost output is estimate-only and includes Cloudflare source links for review.

### MVP Commands

```bash
flarecel doctor
flarecel plan
flarecel add next-opennext
flarecel add r2 uploads
flarecel add db d1 --orm drizzle
flarecel add kv cache
flarecel add rate-limit
flarecel add queue
flarecel add turnstile --form signup
flarecel add cron daily-cleanup --schedule "0 0 * * *"
flarecel add workers-ai
flarecel add vectorize docs-search --dimensions 768 --metric cosine
flarecel add ai-gateway --provider openai
flarecel add observability --sampling 1
flarecel add durable-object room
flarecel add workflow onboarding --schedule "0 9 * * *"
flarecel add browser-run
flarecel add auth better-auth --db d1 --orm drizzle
flarecel fix --dry-run
flarecel verify
flarecel provision --json
flarecel cost --json
flarecel deploy --preview --yes
```

### MVP Recipes

1. Next.js + OpenNext
2. R2 uploads
3. D1 + Drizzle
4. Better Auth + D1 + Drizzle
5. Rate limits
6. Queues
7. KV cache
8. Turnstile
9. Cron Triggers
10. Workers AI
11. Vectorize
12. AI Gateway
13. Observability
14. Durable Objects
15. Workflows
16. Browser Run
17. Env/secrets/types

### MVP `flarecel open`

Screens:

- Project overview
- Readiness score
- Issues
- Recommended recipes
- Apply preview
- Explain this
- Preview deploy

Keep this lightweight. The CLI is still the product.

---

## 18. v1 Roadmap

### v0.1

- CLI scaffold
- `doctor`
- `plan`
- Next.js detection
- Wrangler config detection
- JSON output
- dry-run patch output

### v0.2

- Next.js + OpenNext recipe
- R2 upload recipe
- D1 + Drizzle recipe
- `verify`

### v0.3

- Better Auth + D1 + Drizzle recipe
- Rate limit recipe
- Queue recipe
- generated TypeScript binding checks

### v0.4

- Visual dashboard
- human explanations
- recipe marketplace structure

### v0.5

- MCP server
- agent docs
- fixture repo test suite
- snapshot tests for patches

### v1.0

- stable CLI
- stable recipe API
- SaaS kit
- AI app kit
- production deploy guardrails
- cost estimator

---

## 19. Testing Strategy

Flarecel can start vibecoded, but its outputs must become reliable.

Use:

- Fixture repos
- Snapshot tests for generated patches
- Integration tests for recipes
- JSON schema tests
- CLI exit code tests
- Secret redaction tests
- Dry-run/apply parity tests

Fixture examples:

```txt
fixtures/
  next-empty/
  next-vercel-basic/
  next-clerk/
  next-prisma/
  next-supabase/
  next-better-auth/
  hono-worker/
  vite-react-worker/
```

---

## 20. Open Source Strategy

Recommended npm package:

```txt
flarecel
```

Package command:

```bash
npx flarecel doctor
```

Repository structure:

```txt
flarecel/
  packages/
    cli/
    core/
    dashboard/
    mcp/
  recipes/
    next-opennext/
    r2-uploads/
    d1-drizzle/
    better-auth-d1-drizzle/
    rate-limit/
    queue/
  fixtures/
  docs/
  AGENTS.md
  README.md
```

Community contributions should focus on recipes:

- `flarecel add auth clerk`
- `flarecel add auth supabase`
- `flarecel add db neon`
- `flarecel add db convex`
- `flarecel add stripe webhooks`
- `flarecel add resend emails`

---

## 21. The Big Vision

Today:

> Cloudflare is cheap and powerful, but setup can interrupt the creative flow.

With Flarecel:

> A builder describes the app, Flarecel gives the coding agent Cloudflare judgment, and safe patches get applied with proof.

The long-term product:

- Cloudflare compatibility doctor
- optional local infrastructure view
- recipe marketplace
- agent-safe patch system
- cost estimator
- deployment confidence layer

The final feeling:

> I do not need to become a Cloudflare expert to use Cloudflare like one.

---

## 22. Best First Three Features

If building starts today, build these first:

1. `flarecel doctor --json`
2. `flarecel add r2 uploads --dry-run`
3. `flarecel add auth better-auth --db d1 --orm drizzle --dry-run`

Why:

- `doctor` proves the diagnostic value.
- R2 uploads are common and easy to understand.
- Better Auth + D1 + Drizzle creates a strong Cloudflare-native SaaS identity.

Then add:

4. `flarecel add rate-limit`
5. `flarecel add queue`
6. `flarecel open`

That is enough to make Flarecel feel real.
