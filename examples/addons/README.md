# Example add-on

`my-provider.json` is a complete, copy-paste starting point for authoring your own Flarecel add-on.

## Use it

1. Copy it into your project as `.flarecel/addons/<name>.json` (the `name` field is what you run, not the filename).
2. Edit the fields for your provider.
3. Preview: `flarecel add <name> --dry-run` — writes nothing.
4. Apply: `flarecel add <name> --apply --yes`.

`flarecel catalog list` will show it once it's in `.flarecel/addons/`.

## Fields

| Field | Required | What it does |
|-------|----------|--------------|
| `name` | yes | The add-on id you run (`flarecel add <name>`). Lowercase letters, digits, dashes. |
| `title` | yes | Human label shown in output. |
| `deps` / `devDeps` | no | Packages added to `package.json` (Flarecel does not run `npm install`). |
| `envTypes` | no | Lines added to the `CloudflareEnv` interface in `cloudflare-env.d.ts`. |
| `envExample` | no | Lines appended to `.dev.vars.example`. Secret-like keys must use a placeholder value, not a real secret. |
| `wrangler` | no | Object of keys shallow-merged into your Wrangler config (e.g. `compatibility_flags`). |
| `files` | no | Files to create: `{ "path", "content", "reason" }`. `{{projectName}}` in `content` is substituted. |
| `warnings` | no | Extra warnings shown with the change set. |
| `nextActions` | no | Suggested follow-up commands. |
| `doc` | no | Markdown written to `docs/flarecel-<name>.md`. A default is generated if omitted. |

## Safety rules (enforced)

- **Pure data, never code.** Specs are JSON only — no executable JS runs from an add-on.
- **No path escapes.** `files[].path` must be relative and inside the project (no `..`, no absolute paths).
- **No baked secrets.** A secret-like key (`*KEY`, `*TOKEN`, `*SECRET`, `*PASSWORD`, `*DSN`, ...) with a real-looking value is rejected; use a placeholder like `replace-me`.
- **Only `{{projectName}}` is templated.** No other substitution or logic.
- Project add-ons are labeled "Flarecel did not author this" — review the dry-run change set before applying.
