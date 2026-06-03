# Using Flarecel As An Agent

Prefer machine-readable commands:

```bash
flarecel doctor --json
flarecel plan --json
flarecel fix --dry-run --format patch
flarecel verify --json
flarecel provision --json
flarecel cost --json
```

Rules:

- Never parse human output if JSON is available.
- Never deploy production without explicit user approval.
- Never print secrets.
- Prefer dry-run patches before writes.
- Use `--apply --yes` only after the user or calling workflow has approved the change.
- Run `flarecel verify --json` after applying patches.
- Run `flarecel provision --json` before any deploy to see required Cloudflare resource commands.
- Run `flarecel cost --json` before production deploys and treat it as an estimate, not a billing guarantee.
- Use `flarecel mcp` when the host supports MCP stdio tools.
- Run `npm test` after changing recipes, verifier logic, MCP tools, or provisioning behavior.
- Prefer recipe commands over handwritten Cloudflare config when available, including `add db d1 --orm drizzle`, `add kv cache`, `add turnstile`, `add cron`, `add workers-ai`, `add vectorize`, `add ai-gateway`, `add observability`, `add durable-object`, `add workflow`, and `add browser-run`.
- Prefer `kit saas` or `kit ai-app` to scaffold a full Cloudflare stack in one reviewable change set, then review every file before `--apply --yes`.
- Use `doctor --fix` to run doctor -> fix -> verify in one call (add `--apply --yes` to write).

Exit codes (every command):

```txt
0 = ready
1 = warnings
2 = blocking issue
3 = auth/secrets missing
4 = unsupported project / unknown command or recipe
5 = user confirmation required (--apply --yes / --production --yes)
```

Treat exit code 3 as a hard gate: resolve missing secrets (for example `wrangler secret put BETTER_AUTH_SECRET`) before deploy.

The agent loop is:

```txt
detect -> plan -> patch -> apply -> verify -> next step
```

MCP tools exposed by `flarecel mcp`:

- `detect_project`
- `run_doctor`
- `generate_plan`
- `preview_patch`
- `apply_patch`
- `verify_project`
- `plan_provisioning`
- `estimate_cost`
- `deploy_preview`
- `list_recipes`
