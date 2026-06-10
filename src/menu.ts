import { emitKeypressEvents } from "node:readline";
import { spawn } from "node:child_process";
import { c, sym, splash } from "./ui.js";
import { cloudflareAuthStatus, formatCloudflareAuthStatus } from "./auth-status.js";

export interface CommandGroup {
  title: string;
  paint: (s: string) => string;
  cmds: string[];
}

// single source of truth for both `flarecel help` and `flarecel menu`.
export const COMMAND_GROUPS: CommandGroup[] = [
  { title: "Diagnose", paint: c.cyan, cmds: ["progress", "onboard", "auth", "doctor", "cloudflare", "env", "secrets plan", "doctor --fix", "doctor --baseline", "doctor --diff", "plan", "explain <id>", "diagnose <error>", "why <path>", "verify", "cost"] },
  { title: "Fix & migrate", paint: c.green, cmds: ["fix --dry-run", "fix --apply --yes", "remove <add-on>", "migrate vercel"] },
  { title: "Add features", paint: c.magenta, cmds: ["add r2 uploads", "add db d1 --orm drizzle", "add auth better-auth", "add saas-billing", "add stripe", "add resend", "add <add-on>", "compose <add-ons>", "catalog list"] },
  { title: "Ship", paint: c.orange, cmds: ["provision", "deploy --preview --yes", "deploy --production --yes", "ci", "versions", "rollback --yes", "open", "mcp"] }
];

export const COMMAND_EXPLANATIONS: Record<string, string> = {
  "doctor": "Scans the project and tells you what blocks Cloudflare deploy, in human output or JSON.",
  "progress": "Shows the whole Cloudflare path in plain language: diagnose, patch, verify, provision, preview, production.",
  "onboard": "Alias for progress. Useful when you want the non-technical map before touching files.",
  "auth": "Shows Cloudflare and Vercel login status, plus the exact commands to get each CLI authenticated.",
  "doctor --fix": "Runs doctor, previews or applies safe fixes, then verifies again. Add --apply --yes to write.",
  "cloudflare": "Read-only account check: compares local Wrangler bindings to real Cloudflare R2, D1, KV, Queues, and secrets.",
  "env": "Audits env names from common env files and source usage, classifies public/config/secret, and never prints values.",
  "secrets plan": "Shows only secret-looking env names plus exact wrangler secret put commands.",
  "doctor --baseline": "Saves today's doctor findings so future runs can show only new/resolved issues.",
  "doctor --diff": "Compares current doctor findings against the saved baseline.",
  "plan": "Turns doctor findings into a step-by-step Cloudflare readiness path.",
  "explain <id>": "Explains one doctor issue id in plain language: what it is, why it matters, what changes.",
  "diagnose <error>": "Paste a Wrangler/deploy/runtime error and Flarecel maps it to likely fixes.",
  "why <path>": "Shows which applied add-on generated a file, using Flarecel manifests.",
  "verify": "Checks the patched project: Wrangler config, bindings, scripts, source risks, secrets, and Wrangler login.",
  "cost": "Estimates Cloudflare cost from usage flags, with warnings for bill-shock-prone resources.",
  "fix --dry-run": "Generates safe Cloudflare readiness changes without writing files.",
  "fix --apply --yes": "Writes the safe fix set. Use after reviewing the dry-run patch.",
  "remove <add-on>": "Reverts files written by an applied add-on manifest, with conflict protection.",
  "migrate vercel": "Translates portable vercel.json/env pieces and flags Vercel-shaped code like middleware, ISR, maxDuration, and next/image.",
  "add r2 uploads": "Adds Cloudflare R2 storage for uploads/files plus a demo API route.",
  "add db d1 --orm drizzle": "Adds Cloudflare D1 SQL with Drizzle schema/migration helpers.",
  "add auth better-auth": "Adds Better Auth, usually paired with D1 + Drizzle for a Cloudflare-native auth stack.",
  "add saas-billing": "Adds an experimental Stripe billing stack with D1 subscription helpers.",
  "add stripe": "Adds a Workers-safe Stripe webhook/helper add-on.",
  "add resend": "Adds a Workers-safe Resend email helper add-on.",
  "add <add-on>": "Runs any supported add-on. Use help --all to see the full list.",
  "compose <add-ons>": "Composes several add-ons (e.g. `compose next-opennext + auth better-auth + r2`) into one reviewable change set, merging shared files instead of clobbering.",
  "catalog list": "Lists bundled catalog add-ons (PostHog, Sentry, OpenAI, Anthropic, ...) and any project overrides in .flarecel/addons/.",
  "provision": "Plans Cloudflare resource commands for bindings like R2, D1, KV, Queues, and Vectorize.",
  "deploy --preview --yes": "Runs the preview upload/deploy path after verification passes.",
  "deploy --production --yes": "Runs production deploy. Requires explicit --yes and verification should pass first.",
  "ci": "Generates a GitHub Actions workflow that deploys to Cloudflare on push. Dry-run by default; write with --apply --yes. Needs a CLOUDFLARE_API_TOKEN repo secret.",
  "open": "Writes a local HTML readiness report for non-technical review.",
  "versions": "Lists recent Worker versions (read-only) so you can pick a rollback target.",
  "rollback --yes": "Reverts production to a previous Worker version. Gated like deploy: requires --yes.",
  "mcp": "Starts the stdio MCP server so agents can call Flarecel tools without parsing human output."
};

type Row = { kind: "group"; gi: number } | { kind: "cmd"; gi: number; cmd: string };

function isTemplateCommand(cmd: string): boolean {
  return /<[^>]+>/.test(cmd);
}

export function menuCommandArgv(cmd: string): string[] | null {
  if (isTemplateCommand(cmd)) return null;
  return cmd.split(" ").filter(Boolean);
}

function templateExplanation(cmd: string): string {
  if (cmd === "add <add-on>") return "Needs an add-on name. Run catalog list to browse, then type flarecel add <name>.";
  if (cmd === "compose <add-ons>") return "Needs add-on names separated by +. Example: flarecel compose next-opennext + r2 + observability --dry-run.";
  if (cmd === "remove <add-on>") return "Needs an applied add-on name. Use why <path> or check .flarecel/applied, then type flarecel remove <name>.";
  if (cmd === "explain <id>") return "Needs a doctor issue id. Run doctor first, then type flarecel explain <issue-id>.";
  if (cmd === "diagnose <error>") return "Needs an error message. Type flarecel diagnose \"<error text>\".";
  if (cmd === "why <path>") return "Needs a file path. Type flarecel why <path> to see which add-on wrote it.";
  return `Needs input. Type flarecel ${cmd} with a real value.`;
}

// interactive, collapsible command menu. TTY-only; callers fall back to help
// otherwise. cliPath is the path to this CLI's entry so we can re-invoke it,
// inheriting all existing dispatch + safety + exit-code behavior unchanged.
export async function startMenu(cliPath: string, cwd = process.cwd()): Promise<void> {
  const expanded = COMMAND_GROUPS.map(() => true);
  let selected = 1;
  const auth = cloudflareAuthStatus(cwd, 1500);

  const buildRows = (): Row[] => {
    const rows: Row[] = [];
    COMMAND_GROUPS.forEach((g, gi) => {
      rows.push({ kind: "group", gi });
      if (expanded[gi]) for (const cmd of g.cmds) rows.push({ kind: "cmd", gi, cmd });
    });
    return rows;
  };

  const render = (): void => {
    const rows = buildRows();
    let out = "\x1b[H\x1b[J"; // home + clear
    out += `${splash()}\n`;
    out += `${c.dim(formatCloudflareAuthStatus(auth))}\n\n`;
    rows.forEach((row, i) => {
      const on = i === selected;
      const cursor = on ? c.bold(c.orange(sym.arrow)) : " ";
      if (row.kind === "group") {
        const g = COMMAND_GROUPS[row.gi];
        const caret = expanded[row.gi] ? "\u25be" : "\u25b8"; // ▾ / ▸
        out += `${cursor} ${caret} ${g.paint(c.bold(g.title))}\n`;
      } else {
        const g = COMMAND_GROUPS[row.gi];
        const template = isTemplateCommand(row.cmd);
        const label = template ? `${row.cmd} ${c.dim("(needs input)")}` : row.cmd;
        const text = template
          ? on ? c.bold(c.gray(label)) : c.gray(label)
          : on ? c.bold(g.paint(row.cmd)) : c.gray(row.cmd);
        out += `${cursor}    ${text}\n`;
      }
    });

    const selectedRow = rows[selected];
    if (selectedRow?.kind === "cmd") {
      out += `\n${c.bold("What this does")}\n`;
      out += `${c.gray(isTemplateCommand(selectedRow.cmd) ? templateExplanation(selectedRow.cmd) : COMMAND_EXPLANATIONS[selectedRow.cmd] ?? `Runs flarecel ${selectedRow.cmd}.`)}\n`;
    } else {
      out += `\n${c.bold("What this does")}\n`;
      out += `${c.gray("Pick a command; the explanation updates as you move.")}\n`;
    }

    out += `\n${c.dim("\u2191\u2193 move \u00b7 \u2190 collapse \u00b7 \u2192 expand \u00b7 enter run \u00b7 q quit")}\n`;
    process.stdout.write(out);
  };

  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdout.write("\x1b[?25l"); // hide cursor

    const cleanup = (): void => {
      process.stdin.setRawMode?.(false);
      process.stdin.removeListener("keypress", onKey);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h"); // show cursor
    };

    const moveSel = (delta: number): void => {
      const n = buildRows().length;
      selected = (selected + delta + n) % n;
      render();
    };

    const runCommand = (cmd: string): void => {
      const argv = menuCommandArgv(cmd);
      if (!argv) {
        render();
        return;
      }
      cleanup();
      process.stdout.write("\x1b[H\x1b[J");
      const child = spawn(process.execPath, [cliPath, ...argv], { stdio: "inherit" });
      child.on("close", () => {
        process.stdout.write(`\n${c.dim("Press any key to return to the menu \u00b7 q to quit")}`);
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("keypress", (_s, k) => {
          if (k && (k.name === "q" || (k.ctrl && k.name === "c"))) { fullExit(); return; }
          process.stdin.on("keypress", onKey);
          process.stdout.write("\x1b[?25l");
          render();
        });
      });
    };

    const fullExit = (): void => {
      cleanup();
      process.stdout.write("\x1b[H\x1b[J");
      resolve();
    };

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean } | undefined): void => {
      if (!key) return;
      if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) { fullExit(); return; }
      if (key.name === "up") return moveSel(-1);
      if (key.name === "down") return moveSel(1);

      const rows = buildRows();
      const row = rows[selected];
      if (key.name === "left") {
        if (row.kind === "group") expanded[row.gi] = false;
        else { expanded[row.gi] = false; selected = rows.findIndex((r) => r.kind === "group" && r.gi === row.gi); }
        return render();
      }
      if (key.name === "right") {
        if (row.kind === "group") expanded[row.gi] = true;
        return render();
      }
      if (key.name === "tab") {
        return render();
      }
      if (key.name === "return") {
        if (row.kind === "group") { expanded[row.gi] = !expanded[row.gi]; render(); }
        else runCommand(row.cmd);
      }
    };

    process.stdin.resume();
    process.stdin.on("keypress", onKey);
    render();
  });
}
