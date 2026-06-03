import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Async spawn that captures output. Resolves (never rejects) so callers can
// report failures as data. Async (unlike spawnSync) so a spinner can animate.
export function runCommand(command: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => resolve({ code: null, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
