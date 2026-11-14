import { test } from "node:test";
import assert from "node:assert/strict";
import { FRAME_MS } from "../animate.js";
import { octopusRows, poseRows } from "../banner.js";
import { makePainter } from "../theme.js";
import { HEADER_ROWS, MIN_COLUMNS, REACT_FRAMES, headerFrame, startWatchHeader, type WatchHeaderOptions } from "../watchheader.js";
import type { AuditEntry } from "../audit.js";

const vis = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[78]/g, "");
const color = makePainter({ level: 3, theme: "reef", mode: "dark" });
const TTY = { isTTY: true, rows: 40, columns: 100, env: { TERM: "xterm-256color" } };
const entry = (decision: "allow" | "block", agent = "claude", rule?: string): AuditEntry =>
  ({ ts: "2026-11-13T12:04:11.000Z", agent, tool: "Bash", command: "x", decision, ...(rule ? { rule } : {}) }) as AuditEntry;

/** Fake timers, a fake resize event, a fake exit and a recording write. */
function harness(extra: Partial<WatchHeaderOptions> = {}) {
  const out: string[] = [];
  let fn: (() => void) | undefined;
  let ms = 0;
  let cleared = 0;
  let resize: ((s: { columns: number; rows: number }) => void) | undefined;
  let exit: (() => void) | undefined;
  const h = startWatchHeader({
    ...TTY,
    painter: color,
    file: "/home/u/.cephalo/audit.jsonl",
    write: (s) => void out.push(s),
    setTimer: (f, m) => ((fn = f), (ms = m), 1),
    clearTimer: () => void cleared++,
    onResize: (f) => ((resize = f), () => (resize = undefined)),
    onExit: (f) => ((exit = f), () => (exit = undefined)),
    ...extra,
  });
  return {
    h,
    out,
    tick: () => fn?.(),
    resize: (columns: number, rows: number) => resize?.({ columns, rows }),
    exit: () => exit?.(),
    get ms() { return ms; },
    get cleared() { return cleared; },
    get timerSet() { return fn !== undefined; },
    get listening() { return resize !== undefined; },
  };
}

test("on a terminal: the header is drawn at the top, the log gets a scroll region below it, and the octopus waves at ten frames a second", () => {
  const t = harness();
  assert.equal(t.h.animated, true);
  const first = t.out[0]!;
  assert.match(first, /\x1b\[\?25l/, "cursor hidden");
  assert.match(first, /\x1b\[H\x1b\[2J/, "the screen is cleared once");
  assert.match(first, new RegExp(`\\x1b\\[${HEADER_ROWS + 2};40r`), "the log scrolls in rows 8 to 40");
  assert.ok(first.endsWith(`\x1b[${HEADER_ROWS + 2};1H`), "the cursor starts in the log region");
  assert.ok(first.includes(octopusRows(color, poseRows())[0]!), "the same octopus drawing as the banner");
  assert.match(vis(first), /cephalo watch/);
  assert.match(vis(first), /watching audit\.jsonl/);
  assert.equal(t.ms, FRAME_MS);
  const frames = new Set<string>();
  for (let i = 0; i < 4; i++) {
    t.tick();
    const f = t.out.at(-1)!;
    assert.ok(f.startsWith("\x1b7") && f.endsWith("\x1b8"), "every frame saves and restores the cursor");
    assert.equal((f.match(/\x1b\[2K/g) ?? []).length, HEADER_ROWS, "and redraws exactly the six header rows");
    for (let r = 1; r <= HEADER_ROWS; r++) assert.ok(f.includes(`\x1b[${r};1H`), `row ${r} is addressed absolutely`);
    frames.add(f);
  }
  assert.equal(frames.size, 3, "the tentacles move through the three shapes of WAVE (0, 1, 0, 2)");
  t.h.stop();
});

test("the status counts calls, blocks and agents; a BLOCK makes the octopus react briefly and shows the rule", () => {
  const t = harness();
  t.h.entry(entry("allow", "claude"));
  t.h.entry(entry("allow", "hermes"));
  t.tick();
  assert.match(vis(t.out.at(-1)!), /2 calls · 0 blocked · 2 agents/);
  assert.match(vis(t.out.at(-1)!), /Ctrl\+C to stop/);
  const before = t.out.length;
  t.h.entry(entry("block", "claude", "no-rm-rf"));
  assert.equal(t.out.length, before + 1, "the header is redrawn at once for a BLOCK");
  assert.match(vis(t.out.at(-1)!), /BLOCK \[no-rm-rf\]/);
  assert.match(vis(t.out.at(-1)!), /3 calls · 1 blocked · 2 agents/);
  const closed = octopusRows(color, poseRows({ tentacles: 0, blink: true }))[2]!;
  assert.ok(t.out.at(-1)!.includes(closed), "eyes shut as it flinches");
  for (let i = 0; i < REACT_FRAMES; i++) t.tick();
  assert.doesNotMatch(vis(t.out.at(-1)!), /BLOCK/, "the reaction ends");
  assert.match(vis(t.out.at(-1)!), /Ctrl\+C to stop/);
  t.h.stop();
});

test("log lines stay whole: each is one write, and header frames never land between them", () => {
  const t = harness();
  const lines = [
    "Watching /home/u/.cephalo/audit.jsonl  -  Ctrl+C to stop",
    "12:04:11  ALLOW  claude/Bash  git status",
    "12:04:19  BLOCK  claude/Bash [no-rm-rf]  rm -rf ./build",
    "12:04:23  BLOCK  hermes/read_file [no-secret-file]  config/.env",
  ];
  t.out.length = 0;
  for (const l of lines) {
    t.h.write(l);
    t.tick();
    t.h.entry(entry(l.includes("BLOCK") ? "block" : "allow", "claude", "no-rm-rf"));
    t.tick();
  }
  const logWrites = t.out.filter((s) => !s.startsWith("\x1b7"));
  assert.deepEqual(logWrites, lines.map((l) => l + "\n"), "the log text, exactly, one write per line, in order");
  for (const f of t.out.filter((s) => s.startsWith("\x1b7"))) assert.ok(f.endsWith("\x1b8") && !f.includes("\n"), "a frame is self-contained");
  t.h.stop();
});

for (const [name, opts] of [
  ["not a terminal", { isTTY: false }],
  ["NO_COLOR", { env: { TERM: "xterm-256color", NO_COLOR: "1" } }],
  ["TERM=dumb", { env: { TERM: "dumb" } }],
  ["CI", { env: { TERM: "xterm-256color", CI: "true" } }],
  ["CEPHALO_NO_ANIMATION=1", { env: { TERM: "xterm-256color", CEPHALO_NO_ANIMATION: "1" } }],
  ["color off", { painter: makePainter({ level: 0, theme: "reef", mode: "dark" }) }],
  ["too narrow", { columns: MIN_COLUMNS - 1 }],
  ["too short", { rows: 10 }],
] as const) {
  test(`${name}: no header, no timer, and every line printed exactly as before`, () => {
    const t = harness(opts as Partial<WatchHeaderOptions>);
    assert.equal(t.h.animated, false);
    assert.equal(t.timerSet, false);
    assert.equal(t.listening, false);
    t.h.write("12:04:11  ALLOW  claude/Bash  git status");
    t.h.entry(entry("block", "claude", "no-rm-rf"));
    t.h.write("12:04:19  BLOCK  claude/Bash [no-rm-rf]  rm -rf ./build");
    t.h.stop();
    assert.deepEqual(t.out, ["12:04:11  ALLOW  claude/Bash  git status\n", "12:04:19  BLOCK  claude/Bash [no-rm-rf]  rm -rf ./build\n"]);
  });
}

test("a resize moves the scroll region and redraws; too small stops the header, and the lines go on plainly", () => {
  const t = harness();
  t.resize(120, 50);
  assert.ok(t.out.some((s) => s === `\x1b7\x1b[${HEADER_ROWS + 2};50r\x1b8`), "the region follows the new height, cursor saved around it");
  assert.ok(t.out.at(-1)!.startsWith("\x1b7"), "then the header is redrawn");
  t.resize(MIN_COLUMNS - 5, 50);
  assert.equal(t.h.animated, false);
  assert.equal(t.cleared, 1, "the timer stops");
  assert.ok(t.out.at(-1)!.includes("\x1b[r") && t.out.at(-1)!.includes("\x1b[?25h"), "region reset, cursor shown");
  const n = t.out.length;
  t.tick(); // a timer callback that fires late, after the stop, draws nothing
  assert.equal(t.out.length, n);
  t.h.write("after");
  assert.deepEqual(t.out.slice(n), ["after\n"]);
});

test("stop and exit: the scroll region is reset and the cursor shown, once", () => {
  const t = harness();
  t.h.stop();
  const last = t.out.at(-1)!;
  assert.equal(last, "\x1b7\x1b[r\x1b8\x1b[?25h");
  t.h.stop();
  assert.equal(t.out.at(-1), last, "stop is safe to call twice");
  assert.equal(t.listening, false, "no resize listener left");

  const u = harness();
  u.exit();
  assert.equal(u.out.at(-1), "\x1b7\x1b[r\x1b8\x1b[?25h", "an exit without stop() still restores the terminal");
  assert.equal(u.cleared, 1);
});

test("the header frame fits the width: never wider than the terminal, the status cut with an ellipsis", () => {
  for (const cols of [MIN_COLUMNS, 50, 80, 200]) {
    const f = headerFrame(color, { file: "/a/very/long/path/to/the/audit-log-file-name.jsonl", calls: 123456, blocked: 7890, agents: 3 }, 0, 0, cols);
    assert.equal(f.length, HEADER_ROWS);
    for (const r of f) assert.ok([...vis(r)].length <= cols - 1, `${cols}: ${vis(r)}`);
  }
  assert.match(vis(headerFrame(color, { file: "/x/audit.jsonl", calls: 1, blocked: 0, agents: 1 }, 0, 0, 80).join("\n")), /1 call · 0 blocked · 1 agent\b/);
});
