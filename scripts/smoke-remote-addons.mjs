import { cpSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = path.join(repoRoot, "dist", "cli.js");
const fixture = path.join(repoRoot, "fixtures", "next-basic");
const PORT = 8796;

// the server must run in its OWN process: the test driver uses spawnSync, which
// blocks the event loop, so an in-process server could not answer the CLI's fetch.
const serverFile = path.join(tmpdir(), `flarecel-addon-server-${process.pid}.mjs`);

main();

function main() {
  writeFileSync(serverFile, `
import { createServer } from "node:http";
const valid = ${JSON.stringify(JSON.stringify({ name: "axiom", title: "Axiom logging", deps: ["@axiomhq/js"], files: [{ path: "lib/axiom.ts", content: "export const app = \"{{projectName}}\";\\n" }] }))};
const evil = ${JSON.stringify(JSON.stringify({ name: "evil", title: "x", files: [{ path: "../../etc/passwd", content: "x" }] }))};
createServer((req,res)=>{res.setHeader("content-type","application/json");res.end(req.url && req.url.includes("evil") ? evil : valid)}).listen(${PORT});
`);
  const server = spawn(process.execPath, [serverFile], { stdio: "ignore" });
  // give the server a moment to bind.
  spawnSync(process.execPath, ["-e", "setTimeout(()=>{}, 400)"]);
  try {
    smokeReviewGated();
    smokeTrustedApply();
    smokeMaliciousRejected();
    smokeNonHttpsRefused();
  } finally {
    server.kill();
    rmSync(serverFile, { force: true });
  }
}

function project() {
  const tmp = mkdtempSync(path.join(tmpdir(), "flarecel-remote-"));
  cpSync(fixture, tmp, { recursive: true });
  return tmp;
}

function smokeReviewGated() {
  const tmp = project();
  try {
    const res = run(["add", `http://localhost:${PORT}/axiom.json`, "--apply", "--yes", "--json", "--cwd", tmp]);
    assertEqual(res.status, 5, `remote add without --trust must require review (exit 5); stderr=${res.stderr}`);
    const j = JSON.parse(res.stdout);
    assertEqual(j.status, "review-required", "remote add should be review-required");
    if (existsSync(path.join(tmp, "lib", "axiom.ts"))) throw new Error("remote add wrote a file without --trust");
    if (!(j.warnings || []).some((w) => w.includes("REMOTE ADD-ON"))) throw new Error("missing remote provenance warning");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeTrustedApply() {
  const tmp = project();
  try {
    const res = run(["add", `http://localhost:${PORT}/axiom.json`, "--apply", "--yes", "--trust", "--json", "--cwd", tmp]);
    const j = JSON.parse(res.stdout);
    assertEqual(j.status, "applied", `remote add with --trust should apply; stderr=${res.stderr}`);
    if (!existsSync(path.join(tmp, "lib", "axiom.ts"))) throw new Error("trusted remote add did not write file");
    if (!existsSync(path.join(tmp, ".flarecel", "applied", "axiom.json"))) throw new Error("trusted remote add should write an add-on manifest");
    const why = JSON.parse(run(["why", "lib/axiom.ts", "--json", "--cwd", tmp]).stdout);
    if (!why.sources?.some((source) => source.addOn === "axiom")) throw new Error("trusted remote add should be visible through why");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeMaliciousRejected() {
  const tmp = project();
  try {
    const res = run(["add", `http://localhost:${PORT}/evil.json`, "--apply", "--yes", "--trust", "--json", "--cwd", tmp]);
    if (res.status === 0) throw new Error("malicious remote add should not succeed");
    if (existsSync(path.join(tmp, "lib", "axiom.ts"))) throw new Error("malicious add unexpectedly wrote files");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function smokeNonHttpsRefused() {
  const tmp = project();
  try {
    const res = run(["add", "http://example.com/x.json", "--cwd", tmp]);
    if (!/https/i.test(res.stderr)) throw new Error("non-https remote should be refused with an https message");
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
