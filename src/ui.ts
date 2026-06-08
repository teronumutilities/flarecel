// presentation layer. ZERO dependencies, ZERO app logic.
// the ONLY module allowed to emit ANSI styling. output.ts is its only consumer.
// color auto-disables when piped, under NO_COLOR, or via setColorEnabled(false),
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
  orange: wrap256(208), // cloudflare-ish
  softWhite: wrap256(255),
  silver: wrap256(250),
  mutedWhite: wrap256(247),
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

// Unicode shade ramp: empty -> light -> medium -> dark -> solid. Used for
// gradient bar edges and the boot dissolve. Index 0 is a space on purpose so
// callers can treat it as a single continuous ramp.
export const SHADE = [" ", "\u2591", "\u2592", "\u2593", "\u2588"] as const;

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function visibleWidth(text: string): number {
  return text.replace(ANSI_RE, "").length;
}

// brand line (kept simple to avoid emoji-width misalignment).
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

// rounded box around already-styled lines. Width computed on visible text.
export function box(lines: string[]): string {
  // clamp the box to the terminal so a single long line can't blow it past the
  // viewport (which makes the borders wrap and look broken). 4 = two borders +
  // two padding spaces.
  const maxInner = Math.max(20, (process.stdout.columns ?? 80) - 4);
  const wrapped = lines.flatMap((line) => wrapAnsiLine(line, maxInner));
  const inner = Math.max(0, ...wrapped.map(visibleWidth));
  const top = c.gray(`\u256d${"\u2500".repeat(inner + 2)}\u256e`);
  const bottom = c.gray(`\u2570${"\u2500".repeat(inner + 2)}\u256f`);
  const body = wrapped.map((line) => {
    const pad = " ".repeat(inner - visibleWidth(line));
    return `${c.gray("\u2502")} ${line}${pad} ${c.gray("\u2502")}`;
  });
  return [top, ...body, bottom].join("\n");
}

// word-wrap to a visible-width budget, ignoring ANSI for measurement. Splits on
// spaces (long unbreakable tokens are hard-split) so styled segments stay intact.
function wrapAnsiLine(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const words = line.split(" ");
  const rows: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) rows.push(current);
    if (visibleWidth(word) <= width) {
      current = word;
    } else {
      // hard-split a token longer than the budget (e.g. a URL).
      let rest = word;
      while (visibleWidth(rest) > width) {
        rows.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      current = rest;
    }
  }
  if (current) rows.push(current);
  return rows;
}

// score bar colored by value. The fill edge gets a single shaded cell so the
// solid->empty transition reads as a gradient (█▓▒░) instead of a hard step.
export function bar(value: number, max = 100, width = 20): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const exact = ratio * width;
  const filled = Math.floor(exact);
  const paint = value >= 80 ? c.green : value >= 50 ? c.yellow : c.red;
  // fractional remainder picks a shade glyph for the boundary cell.
  const frac = exact - filled;
  const edge = filled < width && frac > 0 ? SHADE[Math.max(1, Math.round(frac * 3))] : "";
  const empty = Math.max(0, width - filled - edge.length);
  return `${paint("\u2588".repeat(filled))}${edge ? paint(edge) : ""}${c.gray("\u2591".repeat(empty))} ${c.bold(`${value}`)}${c.dim(`/${max}`)}`;
}

// colored status word for report.status values.
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
    case "action-required":
      return c.yellow(status);
    case "empty":
      return c.gray(status);
    case "blocking":
    case "failed":
    case "blocked":
    case "error":
      return c.red(status);
    default:
      return c.dim(status);
  }
}

// symbol+color for severities and check statuses.
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

// boot splash: cloud (Cloudflare) facing off the triangle (Vercel). Static,
// shown on the help screen. Color no-ops when disabled, so piped help is plain.
export function splash(): string {
  return `${c.bold(c.orange("flarecel"))}  ${c.dim(sym.dot)}  ${c.dim("vercel vibes. cloudflare bills.")}`;
}

// boot animation: a big orange cloud and a small triangle approach each other,
// clash, then vanish into the word "flarecel". No labels, no KO. Mysterious.
export async function playVersus(): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const LINES = 5;
  const cloudArt = [
    "     .~~~.",
    "   .(     ).",
    "  (         )",
    " (           )",
    "  '~-------~'"
  ];
  const triArt = [
    "    /\\    ",
    "   /  \\   ",
    "  /    \\  ",
    " /      \\ ",
    "/________\\"
  ];

  const render = (lines: string[]) => lines.map((l) => `  ${l}`).join("\n") + "\n";
  const WIDTH = 60;
  type Paint = (text: string) => string;
  type Cell = { ch: string; paint?: Paint };
  type Spark = { row: number; col: number; text: string; paint: Paint };

  const drawArt = (canvas: Cell[][], art: string[], x: number, paint: Paint): void => {
    for (let row = 0; row < art.length; row += 1) {
      for (let i = 0; i < art[row].length; i += 1) {
        const ch = art[row][i];
        const col = x + i;
        if (ch === " " || col < 0 || col >= WIDTH) continue;
        canvas[row][col] = { ch, paint };
      }
    }
  };

  const drawSpark = (canvas: Cell[][], spark: Spark): void => {
    for (let i = 0; i < spark.text.length; i += 1) {
      const col = spark.col + i;
      if (spark.row < 0 || spark.row >= LINES || col < 0 || col >= WIDTH) continue;
      const ch = spark.text[i];
      if (ch === " ") continue;
      canvas[spark.row][col] = { ch, paint: spark.paint };
    }
  };

  const emptyCanvas = (): Cell[][] => Array.from(
    { length: LINES },
    () => Array.from({ length: WIDTH }, () => ({ ch: " " }))
  );

  const linesFromCanvas = (canvas: Cell[][]): string[] => canvas.map((row) =>
    row.map((cell) => cell.paint ? cell.paint(cell.ch) : cell.ch).join("").trimEnd()
  );

  const scene = (cloudX: number, triX: number, sparks: Spark[] = []): string[] => {
    const canvas = emptyCanvas();
    drawArt(canvas, cloudArt, cloudX, c.orange);
    drawArt(canvas, triArt, triX, c.white);
    for (const spark of sparks) drawSpark(canvas, spark);
    return linesFromCanvas(canvas);
  };

  const sparksOnly = (sparks: Spark[]): string[] => {
    const canvas = emptyCanvas();
    for (const spark of sparks) drawSpark(canvas, spark);
    return linesFromCanvas(canvas);
  };

  let painted = false;
  const redraw = (lines: string[]) => {
    if (painted) process.stdout.write(`\x1b[${LINES}A\x1b[J`);
    else {
      process.stdout.write("\x1b[J");
      painted = true;
    }
    process.stdout.write(render(lines));
  };

  const impact = (cx: number, paint: Paint = c.yellow): Spark[] => [
    { row: 0, col: cx - 1, text: "\\|/", paint },
    { row: 1, col: cx - 2, text: ">|<", paint },
    { row: 2, col: cx - 2, text: "--", paint },
    { row: 2, col: cx, text: "\u2734", paint: (s) => c.bold(c.orange(s)) },
    { row: 2, col: cx + 1, text: "--", paint },
    { row: 3, col: cx - 2, text: ">|<", paint },
    { row: 4, col: cx - 1, text: "/|\\", paint }
  ];

  // Non-TTY, or a terminal too narrow for the animation canvas (wrapping would
  // break the cursor-up redraw and stack frames): just print the word big.
  if (!process.stdout.isTTY || (process.stdout.columns ?? 80) < WIDTH + 2) {
    const big = [
      "\u2597\u2580\u2596\u259c                \u259c ",
      "\u2590  \u2590 \u259d\u2580\u2596\u2599\u2580\u2596\u259e\u2580\u2596\u259e\u2580\u2596\u259e\u2580\u2596\u2590 ",
      "\u259c\u2580 \u2590 \u259e\u2580\u258c\u258c  \u259b\u2580 \u258c \u2596\u259b\u2580 \u2590 ",
      "\u2590   \u2598\u259d\u2580\u2598\u2598  \u259d\u2580\u2598\u259d\u2580 \u259d\u2580\u2598 \u2598"
    ];
    process.stdout.write(`${big.map((l) => `  ${c.bold(c.orange(l))}`).join("\n")}\n`);
    return;
  }

  process.stdout.write("\x1b[?25l"); // hide cursor

  const approach = [
    [0, 46, 120],
    [2, 43, 115],
    [4, 40, 110],
    [6, 37, 105],
    [8, 34, 100],
    [10, 32, 95],
    [12, 30, 90],
    [13, 28, 85],
    [14, 27, 80]
  ] as const;

  for (const [cloudX, triX, ms] of approach) {
    redraw(scene(cloudX, triX));
    await sleep(ms);
  }

  const cx = 27;
  const clash = [
    scene(14, 27, impact(cx, c.yellow)),
    scene(15, 26, impact(cx, c.orange)),
    scene(13, 29, impact(cx, c.yellow)),
    scene(14, 27, impact(cx, (s) => c.bold(c.yellow(s))))
  ];

  for (const lines of clash) {
    redraw(lines);
    await sleep(85);
  }

  const explosionFrames = [
    sparksOnly([{ row: 2, col: cx, text: "\u2734", paint: (s) => c.bold(c.yellow(s)) }]),
    sparksOnly([
      { row: 1, col: cx - 2, text: "\\ | /", paint: c.yellow },
      { row: 2, col: cx - 3, text: "--\u2734--", paint: c.orange },
      { row: 3, col: cx - 2, text: "/ | \\", paint: c.yellow }
    ]),
    sparksOnly([
      { row: 0, col: cx - 6, text: ".  \u2726     \u2726  .", paint: c.yellow },
      { row: 1, col: cx - 5, text: "\u2726  \\ | /  \u2726", paint: c.orange },
      { row: 2, col: cx - 7, text: "-- \u2726 \u2734 \u2726 --", paint: (s) => c.bold(c.yellow(s)) },
      { row: 3, col: cx - 5, text: "\u2726  / | \\  \u2726", paint: c.orange },
      { row: 4, col: cx - 6, text: ".  \u2726     \u2726  .", paint: c.yellow }
    ]),
    sparksOnly([
      { row: 0, col: cx - 10, text: ".       .       .", paint: c.dim },
      { row: 1, col: cx - 8, text: "\u2726     \u2726     \u2726", paint: c.dim },
      { row: 2, col: cx - 5, text: ".   \u2726   .", paint: c.dim },
      { row: 3, col: cx - 8, text: "\u2726     \u2726     \u2726", paint: c.dim },
      { row: 4, col: cx - 10, text: ".       .       .", paint: c.dim }
    ]),
    sparksOnly([])
  ];

  for (const lines of explosionFrames) {
    redraw(lines);
    await sleep(135);
  }

  await sleep(200);

  // clear and dissolve the wordmark out of shade-block noise (░▒▓█).
  process.stdout.write(`\x1b[${LINES}A\x1b[J`);

  // just the word, BIG, understated.
  const big = [
    "\u2597\u2580\u2596\u259c                \u259c ",
    "\u2590  \u2590 \u259d\u2580\u2596\u2599\u2580\u2596\u259e\u2580\u2596\u259e\u2580\u2596\u259e\u2580\u2596\u2590 ",
    "\u259c\u2580 \u2590 \u259e\u2580\u258c\u258c  \u259b\u2580 \u258c \u2596\u259b\u2580 \u2590 ",
    "\u2590   \u2598\u259d\u2580\u2598\u2598  \u259d\u2580\u2598\u259d\u2580 \u259d\u2580\u2598 \u2598"
  ];

  // each glyph cell carries a stable random seed; rising `reveal` threshold lets
  // cells flip from shade noise (░▒▓) to their final glyph at staggered times.
  const seeds = big.map((line) => Array.from(line, () => Math.random()));
  const dissolveFrame = (reveal: number): string[] => big.map((line, row) =>
    Array.from(line, (ch, col) => {
      if (ch === " ") return " ";
      const seed = seeds[row][col];
      if (seed <= reveal) return ch; // resolved to the real glyph
      // still noise: deeper shade as it nears its reveal point.
      return SHADE[1 + Math.min(2, Math.floor((reveal / Math.max(seed, 1e-6)) * 3))];
    }).join("")
  );

  const dissolveSteps = [0.0, 0.25, 0.5, 0.75, 1.0];
  let dissolvePainted = false;
  for (const reveal of dissolveSteps) {
    const lines = dissolveFrame(reveal);
    if (dissolvePainted) process.stdout.write(`\x1b[${big.length + 1}A\x1b[J`);
    dissolvePainted = true;
    process.stdout.write(`\n${lines.map((l) => `  ${c.bold(c.orange(l))}`).join("\n")}\n`);
    await sleep(70);
  }
  process.stdout.write("\n");
  process.stdout.write("\x1b[?25h"); // show cursor
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
