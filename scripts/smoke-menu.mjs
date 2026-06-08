import { PassThrough } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { startMenu, COMMAND_GROUPS, COMMAND_EXPLANATIONS, menuCommandArgv } from "../dist/menu.js";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");

await smokeMenuInteractive();
smokeTemplateCommandsDoNotRun();
smokeMenuFallback();
smokeGroupsInSyncWithHelp();

// drive the interactive menu with a fake raw TTY and assert it renders and quits.
async function smokeMenuInteractive() {
  const fakeIn = new PassThrough();
  fakeIn.isTTY = true;
  fakeIn.setRawMode = () => {};
  const origStdin = process.stdin;
  Object.defineProperty(process, "stdin", { value: fakeIn, configurable: true });

  let frames = 0;
  let output = "";
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    if (typeof s === "string") {
      output += s;
      if (s.includes("\x1b[J")) frames++;
    }
    return true;
  };
  const origTty = process.stdout.isTTY;
  process.stdout.isTTY = true;

  const done = startMenu(cli);
  const seq = ["\x1b[B", "\x1b[C", "\t", "\t", "q"];
  let i = 0;
  const timer = setInterval(() => { if (i < seq.length) fakeIn.write(seq[i++]); else clearInterval(timer); }, 15);

  await done;
  process.stdout.write = realWrite;
  process.stdout.isTTY = origTty;
  Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });

  if (frames < 2) throw new Error(`menu should render multiple frames, got ${frames}`);
  if (!output.includes("Cloudflare:")) {
    throw new Error("menu should show a quiet Cloudflare auth status line");
  }
  if (!output.includes("(needs input)")) {
    throw new Error("menu should visibly mark placeholder commands as needing input");
  }
  const firstCommand = COMMAND_GROUPS[0].cmds[0];
  if (!output.includes("What this does") || !output.includes(COMMAND_EXPLANATIONS[firstCommand])) {
    throw new Error("selected command should show its explanation automatically");
  }
}

function smokeTemplateCommandsDoNotRun() {
  if (menuCommandArgv("add <add-on>") !== null) {
    throw new Error("placeholder add command should not be runnable from the menu");
  }
  if (menuCommandArgv("explain <id>") !== null) {
    throw new Error("placeholder explain command should not be runnable from the menu");
  }
  const argv = menuCommandArgv("add r2 uploads");
  if (JSON.stringify(argv) !== JSON.stringify(["add", "r2", "uploads"])) {
    throw new Error("concrete menu commands should still produce argv");
  }
}

// piped (non-TTY) menu must degrade to the static help surface, never hang.
function smokeMenuFallback() {
  const res = spawnSync(process.execPath, [cli, "menu", "--no-color"], { encoding: "utf8", input: "" });
  if (res.status !== 0) throw new Error("menu fallback should exit 0");
  if (!res.stdout.includes("Diagnose") || !res.stdout.includes("flarecel doctor")) {
    throw new Error("non-TTY menu should print the help surface");
  }
}

// the menu and `help` share COMMAND_GROUPS; assert help output reflects them.
function smokeGroupsInSyncWithHelp() {
  const compact = spawnSync(process.execPath, [cli, "help", "--no-color"], { encoding: "utf8" }).stdout;
  if (!compact.includes("Start here") || !compact.includes("flarecel menu") || compact.includes("Command reference")) {
    throw new Error("default help should be a compact start screen");
  }
  if (!compact.includes("Auth") || !compact.includes("Cloudflare") || !compact.includes("Vercel") || !compact.includes("flarecel auth")) {
    throw new Error("default help should show the separate auth section");
  }

  const help = spawnSync(process.execPath, [cli, "help", "--all", "--no-color"], { encoding: "utf8" }).stdout;
  for (const g of COMMAND_GROUPS) {
    if (!help.includes(g.title)) throw new Error(`help missing shared group title: ${g.title}`);
  }

  const auth = spawnSync(process.execPath, [cli, "auth", "--json"], { encoding: "utf8" });
  if (auth.status !== 0) throw new Error("auth --json should exit 0");
  const report = JSON.parse(auth.stdout);
  if (report.cloudflare?.service !== "cloudflare" || report.vercel?.service !== "vercel") {
    throw new Error("auth --json should expose both provider statuses");
  }
  if (!report.commands?.cloudflare?.includes("flarecel auth cloudflare") || !report.commands?.vercel?.includes("flarecel auth vercel")) {
    throw new Error("auth --json should include setup commands");
  }

  const vercelAuth = spawnSync(process.execPath, [cli, "auth", "vercel", "--dry-run", "--json"], { encoding: "utf8" });
  if (vercelAuth.status !== 0) throw new Error("auth vercel --dry-run --json should exit 0");
  const vercelPlan = JSON.parse(vercelAuth.stdout);
  if (vercelPlan.provider !== "vercel" || vercelPlan.command?.[1] !== "login") {
    throw new Error("auth vercel should plan vercel login");
  }

  const cfAuth = spawnSync(process.execPath, [cli, "auth", "cf", "--dry-run", "--json"], { encoding: "utf8" });
  if (cfAuth.status !== 0) throw new Error("auth cf --dry-run --json should exit 0");
  const cfPlan = JSON.parse(cfAuth.stdout);
  if (cfPlan.provider !== "cloudflare" || cfPlan.command?.[1] !== "login") {
    throw new Error("auth cf should plan wrangler login");
  }
}
