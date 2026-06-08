import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

// async spawn that captures output. Resolves (never rejects) so callers can
// report failures as data. Async (unlike spawnSync) so a spinner can animate.
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  options: RunCommandOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let closed = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const commandText = [command, ...args].join(" ");

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill && !result.timedOut) clearTimeout(forceKill);
      resolve(result);
    };

    let forceKill: NodeJS.Timeout | null = null;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        stderr = stderr || `${commandText} timed out after ${timeoutMs}ms.`;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => {
          if (!closed) child.kill("SIGKILL");
        }, 1000);
        forceKill.unref?.();
        finish({ code: null, stdout, stderr, timedOut: true });
      }, timeoutMs)
      : null;
    timeout?.unref?.();

    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => finish({ code: null, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => {
      closed = true;
      finish({ code, stdout, stderr });
    });
  });
}
