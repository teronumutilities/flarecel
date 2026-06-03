import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");

agentLoopReachesGreen();
agentLoopRespectsSafety();

// The end-to-end loop an agent runs: doctor -> fix (dry-run) -> apply -> verify,
// branching on exit codes. Asserts the documented codes and that the fix lands.
function agentLoopReachesGreen() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-agentloop-"));
  try {
    cpSync(fixture, tmp, { recursive: true });
    rmSync(path.join(tmp, "app", "api", "edge-risk"), { recursive: true, force: true });

    // 1. doctor: blocking (missing OpenNext + wrangler) -> exit 2
    const doctor = run(["doctor", "--json", "--cwd", tmp]);
    assertEqual(doctor.status, 2, "initial doctor should be blocking (exit 2)");
    const before = JSON.parse(doctor.stdout).readinessScore;

    // 2. fix --dry-run: planned, writes nothing
    const dry = run(["fix", "--dry-run", "--json", "--cwd", tmp]);
    assertEqual(dry.status, 0, dry.stderr);
    const dryCs = JSON.parse(dry.stdout);
    assertEqual(dryCs.status, "planned", "fix dry-run should be planned");
    if (existsSync(path.join(tmp, "open-next.config.ts"))) throw new Error("dry-run must not write files");

    // 3. fix --apply --yes: applied, writes land
    const apply = run(["fix", "--apply", "--yes", "--json", "--cwd", tmp]);
    assertEqual(apply.status, 0, apply.stderr);
    assertEqual(JSON.parse(apply.stdout).status, "applied", "fix apply should be applied");
    if (!existsSync(path.join(tmp, "open-next.config.ts"))) throw new Error("apply should have written open-next.config.ts");
    if (!existsSync(path.join(tmp, "wrangler.jsonc"))) throw new Error("apply should have written wrangler.jsonc");

    // 4. verify: OpenNext now installed; overall improved from blocking
    const verify = run(["verify", "--json", "--cwd", tmp]);
    if (verify.status === 2) throw new Error("verify should no longer be blocking after fix");
    const vReport = JSON.parse(verify.stdout);
    const opennext = vReport.checks.find((c) => c.id === "opennext-installed");
    assertEqual(opennext?.status, "passed", "opennext-installed should pass after fix");

    // 5. doctor again: score moved up, no longer blocking
    const after = run(["doctor", "--json", "--cwd", tmp]);
    if (after.status === 2) throw new Error("doctor should no longer be blocking after fix");
    const afterScore = JSON.parse(after.stdout).readinessScore;
    if (!(afterScore > before)) throw new Error(`readiness should improve (${before} -> ${afterScore})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Safety boundary: fix must NOT silently rewrite risky source (edge runtime),
// and apply requires --yes.
function agentLoopRespectsSafety() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-agentsafety-"));
  try {
    cpSync(fixture, tmp, { recursive: true });
    const edgeRoute = path.join(tmp, "app", "api", "edge-risk", "route.ts");
    const original = readFileSync(edgeRoute, "utf8");

    // --apply without --yes must refuse (exit 5) and write nothing.
    const noYes = run(["fix", "--apply", "--json", "--cwd", tmp]);
    assertEqual(noYes.status, 5, "fix --apply without --yes should exit 5");

    // After a real apply, the edge-runtime export must be untouched (flagged, not rewritten).
    run(["fix", "--apply", "--yes", "--json", "--cwd", tmp]);
    if (readFileSync(edgeRoute, "utf8") !== original) {
      throw new Error("fix must not silently rewrite edge-runtime source");
    }
    // ...and verify should still flag it.
    const verify = run(["verify", "--json", "--cwd", tmp]);
    const flagged = JSON.parse(verify.stdout).checks.some((c) => c.id.includes("edge-runtime") || c.message.includes("edge"));
    if (!flagged) throw new Error("verify should still flag the edge-runtime risk");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: "utf8" });
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected}, got ${actual}`);
}
