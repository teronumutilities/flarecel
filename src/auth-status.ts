import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type LoginState = "in" | "out" | "unknown";
export type LoginService = "cloudflare" | "vercel";

export interface LoginStatus {
  service: LoginService;
  state: LoginState;
  source?: "env-token" | "wrangler-cli" | "vercel-cli";
  detail: string;
  nextAction?: string;
}

interface ProbeError extends Error {
  code?: string;
}

interface ProbeResult {
  status: number | null;
  error?: unknown;
}

// cheap, non-throwing Cloudflare login check. Prefers CLOUDFLARE_API_TOKEN
// (CI), else runs project-local `wrangler whoami` when available, then falls
// back to global `wrangler` on PATH. Returns "unknown" when it can't tell.
export function cloudflareAuthStatus(cwd: string, timeoutMs = 8000): LoginStatus {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return cloudflareEnvTokenStatus();
  }

  const result = spawnSync(resolveAuthCommand(cwd, "wrangler"), ["whoami"], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, NO_COLOR: "1" }
  });

  return cloudflareStatusFromProbe(result);
}

export async function cloudflareAuthStatusAsync(cwd: string, timeoutMs = 8000): Promise<LoginStatus> {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return cloudflareEnvTokenStatus();
  }

  return cloudflareStatusFromProbe(await runWhoami(resolveAuthCommand(cwd, "wrangler"), cwd, timeoutMs));
}

export function vercelAuthStatus(cwd: string, timeoutMs = 5000): LoginStatus {
  const result = spawnSync(resolveAuthCommand(cwd, "vercel"), ["whoami"], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, NO_COLOR: "1" }
  });

  return vercelStatusFromProbe(result);
}

export async function vercelAuthStatusAsync(cwd: string, timeoutMs = 5000): Promise<LoginStatus> {
  return vercelStatusFromProbe(await runWhoami(resolveAuthCommand(cwd, "vercel"), cwd, timeoutMs));
}

export function formatCloudflareAuthStatus(status: LoginStatus): string {
  if (status.source === "env-token" && status.state === "in") return "Cloudflare: token detected in env";
  if (status.state === "in") return "Cloudflare: signed in";
  if (status.state === "out") return "Cloudflare: not signed in · run wrangler login";
  if (status.nextAction === "npm install") return "Cloudflare: unknown · install deps first";
  if (status.nextAction === "wrangler whoami") return "Cloudflare: unknown · run wrangler whoami";
  return `Cloudflare: unknown · ${status.nextAction ?? "check manually"}`;
}

export function formatVercelAuthStatus(status: LoginStatus): string {
  if (status.state === "in") return "Vercel: signed in";
  if (status.state === "out") return "Vercel: not signed in · run vercel login";
  if (status.nextAction === "npm i -g vercel") return "Vercel: unknown · install Vercel CLI if needed";
  if (status.nextAction === "vercel whoami") return "Vercel: unknown · run vercel whoami";
  return `Vercel: unknown · ${status.nextAction ?? "optional migration helper"}`;
}

function resolveAuthCommand(cwd: string, name: "wrangler" | "vercel"): string {
  const bin = process.platform === "win32" ? `${name}.cmd` : name;
  const localPath = path.join(cwd, "node_modules", ".bin", bin);
  return existsSync(localPath) ? localPath : name;
}

function cloudflareEnvTokenStatus(): LoginStatus {
  return {
    service: "cloudflare",
    state: "in",
    source: "env-token",
    detail: "Using CLOUDFLARE_API_TOKEN from the environment."
  };
}

function cloudflareStatusFromProbe(result: ProbeResult): LoginStatus {
  if (result.status === 0) {
    return {
      service: "cloudflare",
      state: "in",
      source: "wrangler-cli",
      detail: "Wrangler whoami succeeded."
    };
  }
  if (errorCode(result.error) === "ETIMEDOUT") {
    return {
      service: "cloudflare",
      state: "unknown",
      source: "wrangler-cli",
      detail: "wrangler whoami timed out.",
      nextAction: "wrangler whoami"
    };
  }
  if (errorCode(result.error) === "ENOENT") {
    return {
      service: "cloudflare",
      state: "unknown",
      detail: "Wrangler CLI is not installed in this project or on PATH.",
      nextAction: "npm install"
    };
  }
  return {
    service: "cloudflare",
    state: "out",
    source: "wrangler-cli",
    detail: "Wrangler is not authenticated.",
    nextAction: "wrangler login"
  };
}

function vercelStatusFromProbe(result: ProbeResult): LoginStatus {
  if (result.status === 0) {
    return {
      service: "vercel",
      state: "in",
      source: "vercel-cli",
      detail: "Vercel CLI whoami succeeded."
    };
  }
  if (errorCode(result.error) === "ETIMEDOUT") {
    return {
      service: "vercel",
      state: "unknown",
      source: "vercel-cli",
      detail: "vercel whoami timed out.",
      nextAction: "vercel whoami"
    };
  }
  if (errorCode(result.error) === "ENOENT") {
    return {
      service: "vercel",
      state: "unknown",
      detail: "Vercel CLI is not installed.",
      nextAction: "npm i -g vercel"
    };
  }
  return {
    service: "vercel",
    state: "out",
    source: "vercel-cli",
    detail: "Vercel CLI is not authenticated.",
    nextAction: "vercel login"
  };
}

function runWhoami(command: string, cwd: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ["whoami"], {
        cwd,
        stdio: "ignore",
        env: { ...process.env, NO_COLOR: "1" }
      });
    } catch (error) {
      resolve({ status: null, error });
      return;
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ status: null, error: probeError("ETIMEDOUT", `${command} whoami timed out.`) });
    }, timeoutMs);
    timeout.unref?.();

    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    child.on("error", (error) => finish({ status: null, error }));
    child.on("close", (status) => finish({ status }));
  });
}

function probeError(code: string, message: string): ProbeError {
  const error = new Error(message) as ProbeError;
  error.code = code;
  return error;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
