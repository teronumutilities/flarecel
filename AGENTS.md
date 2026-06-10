# Using Flarecel As An Agent

Prefer machine-readable commands:

```bash
flarecel doctor --json
flarecel progress --json
flarecel plan --json
flarecel fix --dry-run --format patch
flarecel env --json
flarecel secrets plan --json
flarecel verify --json
flarecel provision --json
flarecel cost --json
flarecel ci --dry-run --format patch
```

Rules:

- Never parse human output if JSON is available. Human output may contain ANSI color; `--json`, `--format patch`, and `--no-color` are always color-free (color also auto-disables when output is piped or `NO_COLOR` is set).
- Run `flarecel progress --json` when you need the plain-language map of the current project: diagnose, patch, verify, provision, preview, then production.
- Never deploy production without explicit user approval.
- Never print secrets.
- Prefer dry-run patches before writes.
- Use `--apply --yes` only after the user or calling workflow has approved the change.
- Run `flarecel verify --json` after applying patches.
- Treat verify check `wrangler-auth` as the Cloudflare login gate. If it fails, run `wrangler login` locally or set `CLOUDFLARE_API_TOKEN` in CI before provisioning/deploying.
- Run `flarecel env --json` when migrating or preparing deploys. It classifies env names as public/config/secret without printing values.
- Run `flarecel secrets plan --json` before deploys that need secrets. Treat returned `wrangler secret put <NAME>` commands as setup work, not generated secret values.
- Run `flarecel provision --json` before any deploy to see required Cloudflare resource commands.
- Run `flarecel cost --json` before production deploys and treat it as an estimate, not a billing guarantee.
- Use `flarecel mcp` when the host supports MCP stdio tools.
- Run `npm test` after changing add-ons, verifier logic, MCP tools, or provisioning behavior.
- Prefer add-on commands over handwritten Cloudflare config when available, including `add db d1 --orm drizzle`, `add kv cache`, `add turnstile`, `add cron`, `add workers-ai`, `add vectorize`, `add ai-gateway`, `add observability`, `add durable-object`, `add workflow`, and `add browser-run`.
- Prefer `flarecel compose <add-ons>` (e.g. `compose next-opennext + auth better-auth + r2 uploads + queue emails + rate-limit + observability`) to scaffold a full Cloudflare stack in one reviewable change set — shared files like `package.json` and `wrangler.jsonc` are merged, not clobbered. Review every file before `--apply --yes`. Agents using MCP should call `preview_compose` with a structured `addOns` array.
- Treat "recipe" as internal/legacy vocabulary, kept only for the `list_recipes` MCP tool and the legacy `recipe` arg alias. User-facing language should say add-on for single features and compose for combining them.
- Third-party provider add-ons (`auth clerk|supabase|authjs|cloudflare-access`, `db d1 --orm prisma`, `db supabase|neon|turso|planetscale|mongodb`, `backend convex`, `redis upstash`) are labeled experimental and generate Workers-safe client code; review the generated `docs/flarecel-*.md` and pin/verify versions before production.
- User-authored add-ons can live in `.flarecel/addons/*.json` (declarative data only, no code execution) and run via `flarecel add <name>`. Their output is labeled "Flarecel did not author this" — treat it as untrusted and review the dry-run change set before `--apply --yes`.
- `flarecel add <https-url>` fetches a declarative add-on from the internet and validates it through the same no-code pipeline. It is network-flagged, https-only (http allowed only for localhost), size-capped, and NEVER writes without explicit `--apply --yes --trust`. Output is labeled "REMOTE ADD-ON ... NOT authored by you or Flarecel" — review every file.
- Use `doctor --fix` to run doctor -> fix -> verify in one call (add `--apply --yes` to write).
- Use `migrate vercel` to translate an existing `vercel.json` and env key names to Cloudflare; review FLAG warnings for anything that does not port automatically.
- Use `migrate vercel` even when `vercel.json` is missing if the app came from Vercel; it also scans source/env/package signals like middleware, ISR, maxDuration, next/image, and @vercel packages.
- Use `explain <issue-id>` for a plain-language description of any doctor finding.
- Treat `cost --compare vercel` as a labeled estimate only (never a quote); it always emits a disclaimer.
- Use `flarecel ci` to scaffold a GitHub Actions workflow that deploys to Cloudflare on push. It is a file-changing command: dry-run by default, write with `--apply --yes`. It needs a `CLOUDFLARE_API_TOKEN` repo secret — treat that as setup work (`gh secret set CLOUDFLARE_API_TOKEN`), never a generated value, and never print it.
- `verify --runtime` is opt-in and boots the built worker in workerd; it is not part of `npm test`.

Exit codes (every command):

```txt
0 = ready
1 = warnings
2 = blocking issue
3 = auth/secrets missing
4 = unsupported project / unknown command or add-on
5 = user confirmation required (--apply --yes / --production --yes)
```

Treat exit code 3 as a hard gate: resolve missing secrets (for example `wrangler secret put BETTER_AUTH_SECRET`) before deploy.

The agent loop is:

```txt
detect -> explain -> patch -> provision -> verify -> deploy
```

Mapped to real commands (the exact sequence the CLI prints on startup and in `flarecel help --all`):

```txt
doctor -> plan -> fix --dry-run -> fix --apply --yes -> provision -> verify -> deploy --preview -> deploy --production
```

Treat `fix --apply --yes` as the only writing step, and `provision` as mandatory before any deploy. The read-only `cloudflare` account-connection check is a precondition for provisioning and deploys, not a patch step.

MCP tools exposed by `flarecel mcp`:

- `detect_project`
- `run_doctor`
- `generate_plan`
- `get_progress`
- `preview_patch`
- `preview_compose`
- `apply_patch`
- `verify_project`
- `plan_provisioning`
- `estimate_cost`
- `deploy_preview`
- `list_recipes` (legacy name; returns add-ons)
- `migrate_vercel`
- `audit_env`
- `plan_secrets`
- `explain_issue`
- `diagnose_error`
