import { poseRows, octopusRows } from "./banner.js";
import { cliPainter } from "./term.js";
import type { Env, Painter } from "./theme.js";

/**
 * The loading animation: the pixel octopus waves its tentacles beside a short status message while a slow command works
 * (init, doctor, mcp scan, models eval, replay, cost). It is drawn in the active theme's colors, about ten frames a second,
 * fits in 80 columns, and clears every line it used before the results are printed.
 *
 * It runs only where it can do no harm:
 *   - never for `cephalo hook ...` (nothing in the hook code imports this file)
 *   - not when stdout is not a terminal, with NO_COLOR, with TERM=dumb, in CI, or with CEPHALO_NO_ANIMATION=1
 *   - not when the terminal is too short to hold it, or the user asks for less motion (REDUCE_MOTION=1, CEPHALO_REDUCE_MOTION=1)
 * In those cases a plain "Working..." line is printed once, on stderr so that piped output stays clean.
 *
 * Limit: the frames advance on a timer, so they move only while the command is waiting on something asynchronous (a network
 * call, a model, a child process). A step that blocks the event loop (doctor and replay run synchronous checks) shows the first
 * frame and holds it until that step ends.
 */

const truthy = (v: string | undefined) => v !== undefined && v.trim() !== "" && !/^(0|false|no|off)$/i.test(v.trim());

export interface AnimateEnv {
  env?: Env;
  isTTY?: boolean;
  rows?: number;
}

/** Why the animation will not play, or undefined if it will. */
export function whyNotAnimate(painter: Painter, height: number, o: AnimateEnv = {}): string | undefined {
  const env = o.env ?? process.env;
  const isTTY = o.isTTY ?? Boolean(process.stdout.isTTY);
  const rows = o.rows ?? process.stdout.rows ?? 24;
  if (!isTTY) return "output is not a terminal";
  if (painter.level === 0) return "color is off";
  if (env.NO_COLOR) return "NO_COLOR is set";
  if (env.TERM === "dumb") return "TERM=dumb";
  if (truthy(env.CI)) return "running in CI";
  if (truthy(env.CEPHALO_NO_ANIMATION)) return "CEPHALO_NO_ANIMATION is set";
  if (truthy(env.REDUCE_MOTION) || truthy(env.CEPHALO_REDUCE_MOTION)) return "reduced motion requested";
  if (rows < height + 2) return "terminal is too short";
  return undefined;
}

/** Tentacle poses in the order they are shown: four frames per cycle. */
export const WAVE = [0, 1, 0, 2];
export const FRAME_MS = 100; // ten frames a second
const GAP = "  ";
const OCTOPUS_WIDTH = 16;
const HEIGHT = 6;

const strip = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ");

/** One frame: the octopus in a pose with the message beside its middle rows, never wider than `columns`. */
export function spinnerFrame(p: Painter, message: string, tick: number, columns = 80): string[] {
  const blink = tick % 24 === 23;
  const rows = octopusRows(p, poseRows({ tentacles: WAVE[tick % WAVE.length]!, blink }));
  const room = Math.max(0, columns - 1 - OCTOPUS_WIDTH - GAP.length);
  const text = [...strip(message)];
  const shown = text.length > room ? text.slice(0, Math.max(0, room - 1)).join("") + (room > 0 ? "\u2026" : "") : text.join("");
  return rows.map((r, i) => (i === 2 ? r + GAP + p.role("heading", shown) : i === 3 ? r + GAP + p.role("dim", dots(tick, room)) : r));
}

/** A small "still going" cue under the message: a growing row of dots (kept short so it never reaches the margin). */
function dots(tick: number, room: number): string {
  return room < 4 ? "" : ".".repeat(1 + (tick % 4));
}

export interface Spinner {
  /** Change the status message. */
  update(message: string): void;
  /** Stop, clear every line, and put the cursor back. Safe to call twice. */
  stop(): void;
  /** True if it is animating, false if it printed the plain line. */
  readonly animated: boolean;
}

export interface SpinnerOptions extends AnimateEnv {
  painter?: Painter;
  /** Where frames go (stdout by default). */
  write?: (s: string) => void;
  /** Where the plain "Working..." line goes (stderr by default). */
  writePlain?: (s: string) => void;
  columns?: number;
  /** Timers, for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const HIDE = "\u001b[?25l";
const SHOW = "\u001b[?25h";

export function startSpinner(message: string, o: SpinnerOptions = {}): Spinner {
  const p = o.painter ?? cliPainter();
  const write = o.write ?? ((s: string) => void process.stdout.write(s));
  const writePlain = o.writePlain ?? ((s: string) => void process.stderr.write(s));
  if (whyNotAnimate(p, HEIGHT, o) !== undefined) {
    writePlain(`Working... ${strip(message)}`.trimEnd() + "\n");
    return { update() {}, stop() {}, animated: false };
  }
  const columns = o.columns ?? process.stdout.columns ?? 80;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = o.clearTimer ?? ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>));
  let msg = message;
  let tick = 0;
  let drawn = false;
  let stopped = false;
  const draw = () => {
    const lines = spinnerFrame(p, msg, tick, columns);
    write((drawn ? `\u001b[${HEIGHT}A\r` : "") + lines.map((l) => `\u001b[2K${l}\n`).join(""));
    drawn = true;
  };
  const restore = () => process.stdout.write(SHOW);
  const onSigint = () => {
    restore();
    process.exit(130);
  };
  process.once("SIGINT", onSigint);
  process.once("exit", restore);
  write(HIDE);
  draw();
  const timer = setTimer(() => {
    tick++;
    draw();
  }, FRAME_MS);
  const unref = (timer as { unref?: () => void } | undefined)?.unref;
  void unref; // keep the process alive while it waits; the awaited work does that anyway
  return {
    animated: true,
    update(m: string) {
      msg = m;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("exit", restore);
      write(`\u001b[${HEIGHT}A\r\u001b[J` + SHOW); // up over the frame, erase to the end of the screen, cursor back
    },
  };
}

/** Runs `fn` with the loading animation shown, and always clears it before returning or throwing. */
export async function withSpinner<T>(message: string, fn: (s: Spinner) => Promise<T> | T, o: SpinnerOptions = {}): Promise<T> {
  const s = startSpinner(message, o);
  try {
    return await fn(s);
  } finally {
    s.stop();
  }
}
