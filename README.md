# Flarecel

Vercel vibes. Cloudflare bills.

Flarecel is an agent-friendly Cloudflare Workers deployment assistant. The first milestone is intentionally narrow: help a coding agent diagnose, patch, and verify a Next.js app for Cloudflare Workers through OpenNext.

It is not a hosting platform and it is not affiliated with Cloudflare or Vercel.

## Quick Start

```bash
npx flarecel doctor --json
npx flarecel plan --json
npx flarecel fix --dry-run --format patch
npx flarecel fix --apply --yes
npx flarecel verify --json
npx flarecel provision --json
```

## MVP Commands

```bash
flarecel doctor
flarecel plan
flarecel fix --dry-run
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
flarecel open
flarecel mcp
```

## Agent Contract

Every core command supports machine-readable output:

```bash
flarecel doctor --json
flarecel plan --json
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

## Quality Rails

This repo is allowed to start from taste and instinct, but changes should not stay vibes-only.

Run this before trusting generated recipe work:

```bash
npm test
```

The smoke suite builds the CLI, checks JSON/MCP output, parses generated TypeScript recipes, verifies Better Auth + D1 checks, and confirms provisioning plans emit exact Wrangler commands where Cloudflare has an explicit creation command.

## Current Scope

Implemented now:

- Project/framework detection.
- Next.js/OpenNext readiness checks.
- Wrangler config checks.
- Risk checks for common Worker-hostile packages and source imports.
- Agent-readable `doctor`, `plan`, and `verify` output.
- Dry-run patch generation.
- Apply-safe fixes with `--apply --yes`.
- MVP recipes for OpenNext, R2 uploads, D1 + Drizzle, KV cache, Rate Limiting, Queues, Turnstile, Cron Triggers, Workers AI, Vectorize, AI Gateway, Observability, Durable Objects, Workflows, and Browser Run.
- MVP Better Auth + D1 + Drizzle recipe.
- Provision planning from Wrangler bindings.
- Cost estimation and gated preview/production deploy planning.
- Stdio MCP server with tool discovery and tool calls.
- Lightweight `flarecel open` local report generation.

Still future:

- Rich Cloudflare resource provisioning UX.
- Production deploy rollback/versions support.
- Full visual local UI.
