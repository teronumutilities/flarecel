// Opt-in runtime smoke: boot the built OpenNext worker in workerd (via miniflare)
// and dispatch one fetch. Reports { status, bootMs, ok } as JSON.
//   node scripts/verify-runtime.mjs [--cwd <path>] [--path .open-next/worker.js]
//
// Degrades gracefully: if the build output or miniflare is missing, it SKIPS
// (exit 0 with status:"skipped") rather than failing. Intentionally NOT in
// `npm test` — it needs the workerd binary and a real build. Hard timeout so a
// hung/boot-crashing worker cannot stall CI.
import { existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cwd = path.resolve(flag("--cwd") ?? process.cwd());
const workerRel = flag("--path") ?? ".open-next/worker.js";
const workerPath = path.join(cwd, workerRel);
const TIMEOUT_MS = 15000;

function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}
function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

if (!existsSync(workerPath)) {
  emit({ status: "skipped", reason: `No build output at ${workerRel}. Run the OpenNext build first.`, ok: true });
  process.exit(0);
}

let Miniflare;
try {
  ({ Miniflare } = await import("miniflare"));
} catch {
  emit({ status: "skipped", reason: "miniflare is not installed. Run: npm i -D miniflare", ok: true });
  process.exit(0);
}

const timer = setTimeout(() => {
  emit({ status: "failed", reason: `Runtime boot exceeded ${TIMEOUT_MS}ms (possible boot crash or hang).`, ok: false });
  process.exit(1);
}, TIMEOUT_MS);
timer.unref?.();

const started = Date.now();
let mf;
try {
  mf = new Miniflare({
    scriptPath: workerPath,
    modules: true,
    compatibilityFlags: ["nodejs_compat"],
    // Mock ASSETS so an OpenNext worker that expects the binding does not crash on boot.
    serviceBindings: { ASSETS: () => new Response("", { status: 404 }) }
  });
  const response = await mf.dispatchFetch("http://localhost/");
  const bootMs = Date.now() - started;
  // Boot success = the worker loaded and returned a response without throwing.
  // A 404/500 still proves the module evaluated; we only fail on boot/throw.
  emit({ status: "passed", bootMs, httpStatus: response.status, ok: true });
  clearTimeout(timer);
  await mf.dispose();
  process.exit(0);
} catch (error) {
  clearTimeout(timer);
  if (mf) await mf.dispose().catch(() => {});
  emit({ status: "failed", reason: `Worker failed to boot: ${error instanceof Error ? error.message : String(error)}`, ok: false });
  process.exit(1);
}
