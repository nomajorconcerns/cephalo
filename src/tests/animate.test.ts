import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OCTOPUS, TENTACLES, octopusRows, poseRows } from "../banner.js";
import { FRAME_MS, WAVE, spinnerFrame, startSpinner, whyNotAnimate, withSpinner } from "../animate.js";
import { askQuestion, promptText } from "../term.js";
import { makePainter, themeNames } from "../theme.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const ANSI = /\x1b\[/;
const vis = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const color = makePainter({ level: 3, theme: "reef", mode: "dark" });
const TTY = { isTTY: true, rows: 40, env: { TERM: "xterm-256color" } };

/** A fake clock: the test calls `tick()` instead of waiting. */
function fakeTimers() {
  let fn: (() => void) | undefined;
  let ms = 0;
  let cleared = 0;
  return {
    setTimer: (f: () => void, m: number) => {
      fn = f;
      ms = m;
      return 1;
    },
    clearTimer: () => void cleared++,
    tick: () => fn?.(),
    get ms() {
      return ms;
    },
    get cleared() {
      return cleared;
    },
  };
}

test("every pose is the same size as the resting octopus, so the picture never jumps", () => {
  for (const pose of [{}, { blink: true }, { tentacles: 1 }, { tentacles: 2 }, { tentacles: 2, blink: true }]) {
    const rows = poseRows(pose);
    assert.equal(rows.length, OCTOPUS.length);
    for (const r of rows) assert.equal(r.length, 16, r);
    assert.match(rows.join(""), /^[.PLWK]+$/);
  }
  assert.deepEqual(poseRows(), OCTOPUS, "the default pose is the original drawing");
  assert.equal(TENTACLES.length, 3);
  assert.notDeepEqual(poseRows({ tentacles: 1 }), poseRows({ tentacles: 2 }));
  assert.notDeepEqual(poseRows({ blink: true }), poseRows());
});

test("the tentacles wave over 4 frames, at ten frames a second", () => {
  assert.equal(WAVE.length, 4);
  assert.ok(new Set(WAVE).size >= 3, "three different tentacle shapes");
  assert.equal(FRAME_MS, 100);
  const frames = WAVE.map((_, t) => spinnerFrame(color, "working", t).join("\n"));
  assert.equal(new Set(frames).size, 4, "each of the four frames looks different");
  assert.equal(spinnerFrame(color, "working", 0).join("\n"), spinnerFrame(color, "working", 4).join("\n"), "and the cycle repeats");
});

test("a frame is 6 lines, fits in 80 columns (and in any width it is given), and shows the message beside the octopus", () => {
  for (const columns of [80, 60, 40, 30, 20]) {
    const lines = spinnerFrame(color, "reading sessions and pull requests, then asking GitHub about each branch for a long time", 3, columns);
    assert.equal(lines.length, 6);
    for (const l of lines) assert.ok([...vis(l)].length <= columns - 1, `${columns}: ${[...vis(l)].length} wide: ${vis(l)}`);
  }
  const lines = spinnerFrame(color, "scanning MCP servers", 0, 80);
  assert.match(vis(lines[2]!), /scanning MCP servers/);
  assert.equal(spinnerFrame(color, "a\u001b[2Jb\nc", 0, 80).map(vis).join("\n").includes("\u001b"), false, "control characters in the message are neutralized");
  assert.ok(!spinnerFrame(color, "a\u001b[2Jb\nc", 0, 80).join("").includes("\u001b[2J"));
});

test("frames use the active theme's colors, in every scheme, and the blink frame differs", () => {
  const seen = new Set<string>();
  for (const name of themeNames()) {
    const p = makePainter({ level: 3, theme: name, mode: "dark" });
    const f = spinnerFrame(p, "working", 0).join("\n");
    assert.match(f, ANSI);
    seen.add(f);
  }
  assert.equal(seen.size, 5);
  assert.notEqual(spinnerFrame(color, "w", 23).join(), spinnerFrame(color, "w", 3).join(), "tick 23 blinks");
  assert.ok(spinnerFrame(makePainter({ level: 0 }), "w", 0).every((l) => !ANSI.test(l)));
  assert.equal(octopusRows(color, poseRows()).length, 6);
});

test("whyNotAnimate: pipes, NO_COLOR, dumb terminals, CI, CEPHALO_NO_ANIMATION, reduced motion and short terminals all say no", () => {
  const why = (o: object, p = color) => whyNotAnimate(p, 6, { ...TTY, ...o });
  assert.equal(why({}), undefined, "a normal terminal animates");
  assert.match(why({ isTTY: false })!, /not a terminal/);
  assert.match(why({}, makePainter({ level: 0 }))!, /color is off/);
  assert.match(why({ env: { NO_COLOR: "1" } })!, /NO_COLOR/);
  assert.match(why({ env: { TERM: "dumb" } })!, /dumb/);
  for (const v of ["1", "true", "yes", "x"]) assert.match(why({ env: { CI: v } })!, /CI/, `CI=${v}`);
  assert.equal(why({ env: { CI: "" } }), undefined, "an empty CI does not count");
  assert.equal(why({ env: { CI: "false" } }), undefined);
  assert.match(why({ env: { CEPHALO_NO_ANIMATION: "1" } })!, /CEPHALO_NO_ANIMATION/);
  assert.equal(why({ env: { CEPHALO_NO_ANIMATION: "0" } }), undefined);
  assert.match(why({ env: { REDUCE_MOTION: "1" } })!, /reduced motion/);
  assert.match(why({ env: { CEPHALO_REDUCE_MOTION: "1" } })!, /reduced motion/);
  assert.match(why({ rows: 7 })!, /too short/);
  assert.equal(why({ rows: 8 }), undefined);
});

test("the spinner redraws in place on a timer, updates its message, and clears every line it used before it ends", () => {
  const out: string[] = [];
  const t = fakeTimers();
  const s = startSpinner("first message", { painter: color, ...TTY, columns: 80, write: (x: string) => void out.push(x), setTimer: t.setTimer, clearTimer: t.clearTimer });
  assert.equal(s.animated, true);
  assert.equal(t.ms, 100);
  assert.equal(out[0], "\x1b[?25l", "cursor hidden");
  assert.match(vis(out[1]!), /first message/);
  assert.equal(out[1]!.split("\n").length - 1, 6, "first draw: 6 lines");
  s.update("second message");
  t.tick();
  assert.ok(out[2]!.startsWith("\x1b[6A\r"), "later frames move up 6 lines and redraw");
  assert.match(vis(out[2]!), /second message/);
  assert.ok(out[2]!.split("\n").slice(0, 6).every((l: string) => l.includes("\x1b[2K")), "every line is erased before it is rewritten");
  t.tick();
  t.tick();
  s.stop();
  assert.equal(out.at(-1), "\x1b[6A\r\x1b[J\x1b[?25h", "up over the frame, erase to the end of the screen, cursor back");
  assert.equal(t.cleared, 1);
  const n = out.length;
  s.stop();
  assert.equal(out.length, n, "stopping twice does nothing");
});

test("withSpinner clears the animation before returning, and also when the work throws", async () => {
  for (const fail of [false, true]) {
    const out: string[] = [];
    const t = fakeTimers();
    const job = withSpinner(
      "work",
      async () => {
        t.tick();
        if (fail) throw new Error("nope");
        return 42;
      },
      { painter: color, ...TTY, columns: 80, write: (x: string) => void out.push(x), setTimer: t.setTimer, clearTimer: t.clearTimer },
    );
    if (fail) await assert.rejects(job, /nope/);
    else assert.equal(await job, 42);
    assert.equal(out.at(-1), "\x1b[6A\r\x1b[J\x1b[?25h");
    assert.equal(t.cleared, 1);
  }
});

test("when animation is off, a plain 'Working...' line goes to stderr once, nothing to stdout, and the work still runs", async () => {
  for (const o of [{ isTTY: false }, { env: { CI: "1" } }, { env: { CEPHALO_NO_ANIMATION: "1" } }, { env: { NO_COLOR: "1" } }, { env: { REDUCE_MOTION: "1" } }, { rows: 5 }]) {
    const out: string[] = [];
    const plain: string[] = [];
    const t = fakeTimers();
    const r = await withSpinner("checking things", () => "done", { painter: color, ...TTY, ...o, write: (x: string) => void out.push(x), writePlain: (x: string) => void plain.push(x), setTimer: t.setTimer, clearTimer: t.clearTimer });
    assert.equal(r, "done");
    assert.deepEqual(out, [], "no frames, no cursor codes");
    assert.deepEqual(plain, ["Working... checking things\n"]);
    assert.equal(t.ms, 0, "no timer was started");
  }
  const none: string[] = [];
  await withSpinner("x", () => 1, { painter: makePainter({ level: 0 }), ...TTY, writePlain: (s: string) => void none.push(s) });
  assert.deepEqual(none, ["Working... x\n"]);
});

test("prompts take the theme's prompt style, and are plain with no color", () => {
  assert.equal(promptText("Apply? [y/N] ", makePainter({ level: 0 })), "Apply? [y/N] ");
  assert.match(promptText("Apply? [y/N] ", makePainter({ level: 3, theme: "coral", mode: "dark" })), ANSI);
  let asked = "";
  askQuestion(
    {
      question: (q: string, cb: (a: string) => void) => {
        asked = q;
        cb("y");
      },
    },
    "Go? ",
    () => {},
  );
  assert.match(vis(asked), /^Go\? $/);
  const cli = fs.readFileSync(path.join(SRC, "cli.ts"), "utf8");
  assert.ok(!/\brl\.question\(/.test(cli), "every prompt goes through askQuestion");
});

test("the hook never loads the animation, the banner or the CLI's rendering: nothing on its import path is one of them", () => {
  const seen = new Set<string>();
  const stack = [path.join(SRC, "hooks.ts"), path.join(SRC, "tripwire", "hook.ts")];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of fs.readFileSync(f, "utf8").matchAll(/from\s+"(\.[^"]+)\.js"/g)) {
      const next = path.join(path.dirname(f), m[1]! + ".ts");
      if (fs.existsSync(next)) stack.push(next);
    }
  }
  const names = [...seen].map((f) => path.basename(f));
  for (const banned of ["animate.ts", "banner.ts", "term.ts", "render.ts", "themecmd.ts"]) assert.ok(!names.includes(banned), `${banned} is reachable from the hook`);
  assert.ok(names.includes("hooks.ts") && seen.size > 5);
});

function run(args: string[], env: Record<string, string>, input = "") {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-anim-")));
  return spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", env: { ...process.env, NO_COLOR: "", FORCE_COLOR: "", CI: "", CEPHALO_NO_ANIMATION: "", HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "lad"), ...env } });
}

test("real CLI: slow commands print 'Working...' on stderr when not in a terminal, keep stdout clean, and never emit cursor codes", () => {
  for (const args of [["doctor"], ["init", "--yes"], ["mcp", "scan"]]) {
    const r = run(args, { FORCE_COLOR: "3" });
    assert.match(r.stderr, /^Working\.\.\. /m, args.join(" "));
    assert.doesNotMatch(r.stdout + r.stderr, /\x1b\[\?25|\x1b\[\d+A|\x1b\[J/, `${args.join(" ")}: no animation codes`);
    assert.doesNotMatch(r.stdout, /Working\.\.\./, "stdout holds only the real output");
  }
  const json = run(["mcp", "scan", "--json"], { FORCE_COLOR: "3" });
  assert.doesNotMatch(json.stderr, /Working/, "--json output is never decorated");
});

test("real CLI: the hook prints only JSON, with color forced on in every way", () => {
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force origin main" }, session_id: "s" });
  for (const agent of ["claude", "hermes", "codex", "cursor"]) {
    const r = run(["hook", agent], { FORCE_COLOR: "3", COLORTERM: "truecolor", TERM: "xterm-256color" }, payload);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes("\x1b") && !r.stderr.includes("\x1b"), agent);
    assert.doesNotMatch(r.stderr, /Working/);
    if (r.stdout.trim()) JSON.parse(r.stdout);
    assert.doesNotMatch(r.stdout, /█|▀|▄|seatbelt/);
  }
});
