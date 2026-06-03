// Presentation layer. ZERO dependencies, ZERO app logic.
// The ONLY module allowed to emit ANSI styling. output.ts is its only consumer.
// Color auto-disables when piped, under NO_COLOR, or via setColorEnabled(false),
// so JSON / patch / MCP output is never contaminated. FORCE_COLOR forces it on.

let enabled = detectColor();

function detectColor(): boolean {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

const ESC = "\x1b[";
function wrap(open: number, close: number) {
  return (text: string): string => (enabled ? `${ESC}${open}m${text}${ESC}${close}m` : text);
}
function wrap256(code: number) {
  return (text: string): string => (enabled ? `${ESC}38;5;${code}m${text}${ESC}39m` : text);
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  orange: wrap256(208), // Cloudflare-ish
  white: wrap(97, 39)
};

export const sym = {
  ok: "\u2713",
  err: "\u2717",
  warn: "\u26a0",
  info: "\u2139",
  bullet: "\u2022",
  arrow: "\u2192",
  pending: "\u25cb",
  dot: "\u00b7"
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleWidth(text: string): number {
  return text.replace(ANSI_RE, "").length;
}

// Brand line (kept simple to avoid emoji-width misalignment).
export function banner(subtitle: string): string {
  const mark = c.bold(c.orange("flarecel"));
  return `${mark} ${c.dim(sym.dot)} ${c.dim(subtitle)}`;
}

export function heading(text: string): string {
  return c.bold(text);
}

export function rule(width = 44): string {
  return c.gray("\u2500".repeat(width));
}

// Rounded box around already-styled lines. Width computed on visible text.
export function box(lines: string[]): string {
  const inner = Math.max(0, ...lines.map(visibleWidth));
  const top = c.gray(`\u256d${"\u2500".repeat(inner + 2)}\u256e`);
  const bottom = c.gray(`\u2570${"\u2500".repeat(inner + 2)}\u256f`);
  const body = lines.map((line) => {
    const pad = " ".repeat(inner - visibleWidth(line));
    return `${c.gray("\u2502")} ${line}${pad} ${c.gray("\u2502")}`;
  });
  return [top, ...body, bottom].join("\n");
}

// Score bar colored by value.
export function bar(value: number, max = 100, width = 20): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(ratio * width);
  const paint = value >= 80 ? c.green : value >= 50 ? c.yellow : c.red;
  return `${paint("\u2588".repeat(filled))}${c.gray("\u2591".repeat(width - filled))} ${c.bold(`${value}`)}${c.dim(`/${max}`)}`;
}

// Colored status word for report.status values.
export function statusLabel(status: string): string {
  switch (status) {
    case "ready":
    case "passed":
    case "applied":
    case "succeeded":
      return c.green(status);
    case "warning":
    case "planned":
    case "confirmation-required":
    case "secrets-missing":
      return c.yellow(status);
    case "blocking":
    case "failed":
    case "blocked":
    case "error":
      return c.red(status);
    default:
      return c.dim(status);
  }
}

// Symbol+color for severities and check statuses.
export function severityIcon(severity: string): string {
  switch (severity) {
    case "blocking":
    case "high":
    case "failed":
      return c.red(sym.err);
    case "warning":
      return c.yellow(sym.warn);
    case "passed":
      return c.green(sym.ok);
    case "info":
      return c.blue(sym.info);
    default:
      return c.gray(sym.bullet);
  }
}

export function label(text: string): string {
  return c.dim(`${text}:`);
}

export interface Spinner {
  stop: (finalLine?: string) => void;
}

// Braille spinner. Writes to STDERR only, and no-ops unless stderr is a TTY and
// color is enabled — so stdout (JSON/patch/MCP) is never touched. Returns a
// handle whose stop() clears the line and optionally prints a final status.
const FRAMES = ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"];
export function startSpinner(text: string): Spinner {
  if (!enabled || !process.stderr.isTTY) {
    return { stop: (final) => { if (final) process.stderr.write(`${final}\n`); } };
  }
  let i = 0;
  process.stderr.write("\x1b[?25l"); // hide cursor
  const timer = setInterval(() => {
    process.stderr.write(`\r${c.orange(FRAMES[i = (i + 1) % FRAMES.length])} ${c.dim(text)}`);
  }, 80);
  timer.unref?.();
  return {
    stop: (final) => {
      clearInterval(timer);
      process.stderr.write("\r\x1b[2K\x1b[?25h"); // clear line, show cursor
      if (final) process.stderr.write(`${final}\n`);
    }
  };
}

