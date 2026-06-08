import { runCommand } from "../dist/exec.js";

const started = Date.now();
const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], process.cwd(), {
  timeoutMs: 100
});
const elapsed = Date.now() - started;

if (!result.timedOut) {
  throw new Error(`Expected command to time out, got ${JSON.stringify(result)}`);
}
if (result.code !== null) {
  throw new Error(`Timed-out command should have null exit code, got ${result.code}`);
}
if (!result.stderr.includes("timed out after 100ms")) {
  throw new Error(`Expected timeout message, got "${result.stderr}"`);
}
if (elapsed > 2000) {
  throw new Error(`Timeout returned too slowly: ${elapsed}ms`);
}
