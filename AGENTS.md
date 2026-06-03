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
