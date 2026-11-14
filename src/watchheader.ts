import path from "node:path";
import { octopusRows, poseRows } from "./banner.js";
import { FRAME_MS, WAVE, whyNotAnimate, type AnimateEnv } from "./animate.js";
import type { AuditEntry } from "./audit.js";
import type { Painter } from "./theme.js";

/**
 * The live header of `cephalo watch`: the pixel octopus (the same poses and frame timing as the loading animation)
 * beside "cephalo watch" and a short status, fixed at the top of the terminal while the log lines scroll underneath.
 *
 * How: the screen is cleared once, the header takes rows 1-6, and a scroll region (DECSTBM) from row 8 down holds the
 * log, so new lines scroll only below the header. Every header frame is one write that saves the cursor, draws the six
 * rows and restores the cursor, so it can never land inside a log line. Each log line is written whole, in one write.
 *
 * The octopus waves while idle. When a BLOCK appears it flinches for about a second and a half (eyes shut, faster
 * tentacles) and the status shows the rule.
 *
 * It runs only where the loading animation would (see whyNotAnimate in animate.ts: a terminal, color on, no NO_COLOR,
 * TERM=dumb, CI, CEPHALO_NO_ANIMATION or reduced motion), and only on a terminal at least MIN_COLUMNS wide and tall
 * enough for the header plus a few log lines. Otherwise every line is printed exactly as before and nothing else is.
 * A resize keeps the region in step; a resize below those sizes stops the header for the rest of the session.
 * Never used by `cephalo hook ...` (hook stdout must contain only JSON).
 */

export const HEADER_ROWS = 6;
/** The first row of the log region: the header, then one blank row. */
const LOG_TOP = HEADER_ROWS + 2;
/** The octopus (16) plus the gap plus room for a useful status. */
export const MIN_COLUMNS = 40;
/** Log rows that must fit under the header. */
const MIN_LOG_ROWS = 4;
/** How long the octopus reacts to a BLOCK, in frames. */
export const REACT_FRAMES = 15;

const ESC = "\u001b";
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const RESET_REGION = `${ESC}[r`;
const at = (row: number) => `${ESC}[${row};1H`;
const GAP = "  ";
const OCTOPUS_WIDTH = 16;

const strip = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ");

export interface HeaderStatus {
  file: string;
  calls: number;
  blocked: number;
  agents: number;
  /** The rule of the latest BLOCK, while the octopus reacts to it. */
  rule?: string;
}

/** One header frame: six rows, the octopus with the status beside it, each row cut to fit `columns`. */
export function headerFrame(p: Painter, s: HeaderStatus, tick: number, react: number, columns: number): string[] {
  const reacting = react > 0;
  const tentacles = WAVE[(reacting ? tick * 2 : tick) % WAVE.length]!;
  const blink = reacting ? react > REACT_FRAMES - 4 : tick % 24 === 23;
  const octo = octopusRows(p, poseRows({ tentacles, blink }));
  const room = Math.max(0, columns - 1 - OCTOPUS_WIDTH - GAP.length);
  const fit = (t: string) => {
    const c = [...strip(t)];
    return c.length > room ? c.slice(0, Math.max(0, room - 1)).join("") + (room > 0 ? "…" : "") : c.join("");
  };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const text: Record<number, string> = {
    1: p.role("heading", fit("cephalo watch")),
    2: p.role("dim", fit(`watching ${path.basename(s.file)}`)),
    3: fit(`${plural(s.calls, "call")} · ${s.blocked} blocked · ${plural(s.agents, "agent")}`),
    4: reacting && s.rule ? p.label("block", fit(`BLOCK [${s.rule}]`)) : p.role("dim", fit("Ctrl+C to stop")),
  };
  return octo.map((row, i) => (text[i] !== undefined ? row + GAP + text[i] : row));
}

export interface WatchHeader {
  /** Print one log line (whole, in one write). */
  write(line: string): void;
  /** Count an entry that was shown (and react if it was blocked). */
  entry(e: AuditEntry): void;
  /** Stop: the scroll region is reset and the cursor shown again. Safe to call twice. */
  stop(): void;
  readonly animated: boolean;
}

export interface WatchHeaderOptions extends AnimateEnv {
  painter: Painter;
  file: string;
  /** Where everything goes (stdout by default). */
  write?: (s: string) => void;
  columns?: number;
  /** Timers and terminal events, for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Subscribes to terminal resizes and returns the size each time; returns an unsubscribe function. */
  onResize?: (fn: (size: { columns: number; rows: number }) => void) => () => void;
  /** Subscribes to process exit (Ctrl+C ends through the watch's own abort, then stop()). */
  onExit?: (fn: () => void) => () => void;
}

export function startWatchHeader(o: WatchHeaderOptions): WatchHeader {
  const write = o.write ?? ((s: string) => void process.stdout.write(s));
  const plain: WatchHeader = { write: (line) => write(line + "\n"), entry() {}, stop() {}, animated: false };
  const p = o.painter;
  let columns = o.columns ?? process.stdout.columns ?? 80;
  let rows = o.rows ?? process.stdout.rows ?? 24;
  if (whyNotAnimate(p, LOG_TOP - 1 + MIN_LOG_ROWS, { ...o, rows }) !== undefined || columns < MIN_COLUMNS) return plain;

  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer = o.clearTimer ?? ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>));
  const onResize =
    o.onResize ??
    ((fn) => {
      const h = () => fn({ columns: process.stdout.columns ?? columns, rows: process.stdout.rows ?? rows });
      process.stdout.on("resize", h);
      return () => void process.stdout.off("resize", h);
    });
  const onExit =
    o.onExit ??
    ((fn) => {
      process.once("exit", fn);
      return () => void process.removeListener("exit", fn);
    });

  const status: HeaderStatus = { file: o.file, calls: 0, blocked: 0, agents: 0 };
  const agents = new Set<string>();
  let tick = 0;
  let react = 0;
  let live = true;

  const frame = () => headerFrame(p, status, tick, react, columns).map((l, i) => `${at(i + 1)}${ESC}[2K${l}`).join("");
  const region = () => `${ESC}[${LOG_TOP};${rows}r`;
  /** The header in place, the cursor left where the log is. */
  const draw = () => write(SAVE + frame() + RESTORE);
  /** Leaves the header as the last frame drawn, hands the whole screen back to normal scrolling, and shows the cursor. */
  const release = () => write(SAVE + RESET_REGION + RESTORE + SHOW);

  // Clear once, draw the header, keep the log in the rows below it.
  write(HIDE + `${ESC}[H${ESC}[2J` + frame() + region() + at(LOG_TOP));
  const timer = setTimer(() => {
    if (!live) return;
    tick++;
    if (react > 0) react--;
    draw();
  }, FRAME_MS);

  const stop = () => {
    if (!live) return;
    live = false;
    clearTimer(timer);
    offResize();
    offExit();
    release();
  };
  const offExit = onExit(() => {
    if (live) {
      live = false;
      clearTimer(timer);
      release();
    }
  });
  const offResize = onResize((size) => {
    if (!live) return;
    columns = size.columns;
    rows = size.rows;
    if (columns < MIN_COLUMNS || rows < LOG_TOP - 1 + MIN_LOG_ROWS + 2) return stop(); // too small: plain from here on
    write(SAVE + region() + RESTORE); // setting the region moves the cursor, so it is saved around it
    draw();
  });

  return {
    get animated() {
      return live;
    },
    write(line) {
      write(line + "\n");
    },
    entry(e) {
      if (!live) return;
      status.calls++;
      if (e.agent) agents.add(e.agent);
      status.agents = agents.size;
      if (e.decision === "block") {
        status.blocked++;
        status.rule = e.rule;
        react = REACT_FRAMES;
        draw();
      }
    },
    stop,
  };
}
