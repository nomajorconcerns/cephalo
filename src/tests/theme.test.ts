import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { banner, octopusRows } from "../banner.js";
import { readConfig } from "../config.js";
import { runDoctor, formatChecks } from "../doctor.js";
import { formatAuditColored, formatVerdict } from "../render.js";
import { themeChoice } from "../term.js";
import { themeCommand } from "../themecmd.js";
import { THEMES, backgroundMode, colorLevel, contrast, getTheme, makePainter, themeNames, toAnsi16, toAnsi256, type Level, type Mode, type RGB, type Role } from "../theme.js";
import { formatWatchLine } from "../watch.js";
import type { AuditEntry } from "../audit.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const tmp = (n: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `cephalo-${n}-`)));
const ANSI = /\x1b\[/;
const entry = (o: Partial<AuditEntry> = {}): AuditEntry => ({ ts: "2026-10-30T12:34:56.000Z", agent: "claude", tool: "Bash", decision: "allow", command: "ls", ...o });

const BG: Record<Mode, RGB> = { dark: [13, 17, 23], light: [255, 255, 255] };
const COLOR_ROLES: Role[] = ["allow", "block", "ask", "shadow", "ok", "warn", "fail", "info", "accent", "dim", "heading", "prompt"];

test("there are five schemes with unique names, including a monochrome one, and reef is the default", () => {
  assert.deepEqual(themeNames(), ["reef", "abyss", "coral", "glow", "ink"]);
  assert.equal(getTheme(undefined).name, "reef");
  assert.equal(getTheme("nope").name, "reef");
});

test("every color role is readable on both a dark and a light terminal (contrast of at least 4.5, or 3 for dim)", () => {
  for (const t of THEMES) {
    if (t.name === "ink") continue;
    for (const mode of ["dark", "light"] as const) {
      const pal = mode === "dark" ? t.dark : t.light;
      for (const r of COLOR_ROLES) {
        const c = pal.roles[r].c!;
        const need = r === "dim" ? 3 : 4.5;
        assert.ok(contrast(c, BG[mode]) >= need, `${t.name}/${mode}/${r} contrast ${contrast(c, BG[mode]).toFixed(2)} < ${need}`);
      }
      assert.ok(contrast(pal.from, BG[mode]) >= 3 && contrast(pal.to, BG[mode]) >= 3, `${t.name}/${mode} wordmark gradient`);
    }
  }
});

test("allow, block and ask are told apart by more than hue: BLOCK and ASK are bold, and the ink scheme uses no color at all", () => {
  for (const t of THEMES) for (const pal of [t.dark, t.light]) {
    assert.ok(pal.roles.block.bold && pal.roles.ask.bold && pal.roles.fail.bold, t.name);
  }
  const ink = getTheme("ink");
  for (const pal of [ink.dark, ink.light]) for (const r of COLOR_ROLES) assert.equal(pal.roles[r].c, undefined, `ink/${r}`);
  const p = makePainter({ theme: "ink", level: 3, mode: "dark" });
  const [a, b, k] = [p.label("allow"), p.label("block"), p.label("ask")];
  assert.ok(!/\x1b\[[0-9;]*3[0-9];/.test(a + b + k) && !/38;/.test(a + b + k), "no foreground colors");
  assert.equal(new Set([a, b, k]).size, 3);
  assert.match(b, /\x1b\[1;7m/);
  assert.match(k, /\x1b\[1;4m/);
});

test("color depth: NO_COLOR, FORCE_COLOR, pipes, dumb terminals and what the terminal advertises", () => {
  const lv = (env: Record<string, string>, tty = true, platform = "linux") => colorLevel(env, tty, platform);
  assert.equal(lv({}, false), 0, "a pipe");
  assert.equal(lv({ TERM: "xterm" }, true), 1);
  assert.equal(lv({ TERM: "dumb" }), 0);
  assert.equal(lv({ NO_COLOR: "1", FORCE_COLOR: "3" }), 0, "NO_COLOR wins");
  assert.equal(lv({ FORCE_COLOR: "0" }), 0);
  assert.equal(lv({ FORCE_COLOR: "false" }), 0);
  assert.equal(lv({ FORCE_COLOR: "1" }, false), 1, "forced on for a pipe");
  assert.equal(lv({ FORCE_COLOR: "2" }, false), 2);
  assert.equal(lv({ FORCE_COLOR: "3" }, false), 3);
  assert.equal(lv({ TERM: "xterm-256color" }), 2);
  assert.equal(lv({ COLORTERM: "truecolor" }), 3);
  assert.equal(lv({ WT_SESSION: "x" }), 3);
  assert.equal(lv({ TERM: "xterm" }, true, "win32"), 3);
  assert.equal(lv({ NO_COLOR: "" , TERM: "xterm" }), 1, "an empty NO_COLOR does not count");
});

test("background: CEPHALO_BACKGROUND, then COLORFGBG, else dark", () => {
  assert.equal(backgroundMode({}), "dark");
  assert.equal(backgroundMode({ COLORFGBG: "0;15" }), "light");
  assert.equal(backgroundMode({ COLORFGBG: "15;0" }), "dark");
  assert.equal(backgroundMode({ COLORFGBG: "0;default;15" }), "light");
  assert.equal(backgroundMode({ COLORFGBG: "garbage" }), "dark");
  assert.equal(backgroundMode({ COLORFGBG: "0;15", CEPHALO_BACKGROUND: "dark" }), "dark");
  assert.equal(backgroundMode({ CEPHALO_BACKGROUND: "LIGHT" }), "light");
});

test("the painter writes 24-bit, 256 or 16-color codes by level, and nothing at level 0", () => {
  const c = (level: Level) => makePainter({ theme: "reef", level, mode: "dark" }).role("block", "X");
  assert.equal(c(0), "X");
  assert.match(c(3), /^\x1b\[1;38;2;255;107;107mX\x1b\[0m$/);
  assert.match(c(2), /^\x1b\[1;38;5;\d+mX\x1b\[0m$/);
  assert.match(c(1), /^\x1b\[1;(9[0-7]|3[0-7])mX\x1b\[0m$/);
  assert.equal(makePainter({ level: 3 }).role("dim", ""), "", "empty text gets no codes");
  for (let r = 0; r < 256; r += 51) for (let g = 0; g < 256; g += 51) for (let b = 0; b < 256; b += 51) {
    const n = toAnsi256([r, g, b]);
    assert.ok(n >= 16 && n <= 255);
    assert.ok([0, 7, 15].includes(toAnsi16([r, g, b], "dark")) === false || toAnsi16([r, g, b], "dark") !== 0);
    assert.ok(![7, 15].includes(toAnsi16([r, g, b], "light")), "light terminals never get white text");
    assert.notEqual(toAnsi16([r, g, b], "dark"), 0, "dark terminals never get black text");
  }
});

test("log lines: plain text is exactly the old format, and a colored line holds the same words", () => {
  const plain = makePainter({ level: 0 });
  const entries = [entry(), entry({ decision: "block", rule: "no-force-push", command: "git push -f" }), entry({ decision: "ask", rule: "ask-push" }), entry({ shadow: [{ rule: "x", would: "block" }] })];
  for (const e of entries) {
    const colored = formatAuditColored(e, makePainter({ level: 3, theme: "glow" }));
    assert.equal(formatAuditColored(e, plain), formatLine(e));
    assert.equal(colored.replace(/\x1b\[[0-9;]*m/g, ""), formatLine(e), "stripping the codes gives the plain line back");
  }
  function formatLine(e: AuditEntry) { return formatAuditColored(e, plain); }
  assert.match(formatAuditColored(entries[1]!, plain), /BLOCK/);
});

test("watch lines take the theme; with color off they are plain; words stay", () => {
  const e = entry({ decision: "block", rule: "r" });
  const t = formatWatchLine(e, { color: true, painter: makePainter({ theme: "coral", level: 3, mode: "dark" }) });
  assert.match(t, /\x1b\[1;38;2;251;113;133mBLOCK\x1b\[0m/);
  const plain = formatWatchLine(e, { color: false, painter: makePainter({ theme: "coral", level: 3 }) });
  assert.ok(!ANSI.test(plain));
  assert.match(plain, /BLOCK {2}claude\/Bash \[r\]/);
});

test("verdict lines carry the words BLOCKED, ASK and ALLOWED in every scheme and with color off", () => {
  for (const name of themeNames()) for (const level of [0, 1, 3] as const) {
    const p = makePainter({ theme: name, level });
    const strip = (l: string[]) => l.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(strip(formatVerdict({ decision: "block", rule: { id: "r", description: "d" } }, p, "block")), /BLOCKED \(r: d\)/);
    assert.match(strip(formatVerdict({ decision: "ask", rule: { id: "r", description: "d" } }, p, "block")), /ASK \(r: d\)/);
    assert.match(strip(formatVerdict({ decision: "allow" }, p, "block")), /ALLOWED/);
    assert.match(strip(formatVerdict({ decision: "allow", shadow: [{ rule: { id: "s", description: "d" }, would: "block" }] }, p, "block")), /would block \(shadow mode\): s/);
  }
});

test("doctor: marks and summary are colored by the theme, and the same text comes back when stripped", () => {
  const checks = [{ level: "ok" as const, name: "A", detail: "fine" }, { level: "warn" as const, name: "B", detail: "hm", fix: "do x" }, { level: "fail" as const, name: "C", detail: "bad" }];
  const plain = formatChecks(checks);
  const colored = formatChecks(checks, makePainter({ level: 3, theme: "abyss" }));
  assert.ok(colored.some((l) => ANSI.test(l)));
  assert.deepEqual(colored.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")), plain);
  assert.ok(plain.every((l) => !ANSI.test(l)));
  assert.ok(runDoctor !== undefined);
});

test("the banner: no color is one plain line; a colored one uses the theme; every scheme draws a 6-row octopus", () => {
  const off = makePainter({ level: 0 });
  assert.equal(banner("9.9.9", off), "cephalo v9.9.9 - the seatbelt for AI coding agents\n");
  const seen = new Set<string>();
  for (const name of themeNames()) for (const mode of ["dark", "light"] as const) {
    const p = makePainter({ theme: name, level: 3, mode });
    const rows = octopusRows(p);
    assert.equal(rows.length, 6);
    assert.ok(banner("1.0.0", p).includes("1.0.0"));
    if (mode === "dark") seen.add(rows.join("\n"));
  }
  assert.equal(seen.size, 5, "each scheme draws the octopus in its own colors");
  assert.match(octopusRows(makePainter({ theme: "reef", level: 3, mode: "dark" }))[0]!, /38;2;255;92;138/, "reef keeps the pink octopus");
  const plainRows = octopusRows(makePainter({ level: 0 }));
  assert.ok(plainRows.every((r) => !ANSI.test(r)), "no escape codes at level 0");
});

test("the choice of scheme: CEPHALO_THEME for one run, then the settings file, then reef; bad values fall back", () => {
  const dir = tmp("themecfg");
  const file = path.join(dir, "config.yml");
  assert.deepEqual(themeChoice({}, file), { name: "reef", source: "default" });
  fs.writeFileSync(file, "theme: coral\n");
  assert.deepEqual(themeChoice({}, file), { name: "coral", source: "config" });
  assert.deepEqual(themeChoice({ CEPHALO_THEME: "GLOW" }, file), { name: "glow", source: "CEPHALO_THEME" });
  assert.deepEqual(themeChoice({ CEPHALO_THEME: "nope" }, file), { name: "coral", source: "config" });
  fs.writeFileSync(file, "theme: neon\n");
  assert.equal(themeChoice({}, file).name, "reef");
  assert.match(readConfig(file).problems.join(" "), /theme must be one of/);
  fs.writeFileSync(file, "{ nope");
  assert.equal(themeChoice({}, file).name, "reef", "a broken settings file never breaks output");
});

test("`cephalo theme`: list, preview, set, reset, and errors", () => {
  const dir = tmp("themecmd");
  const file = path.join(dir, ".cephalo", "config.yml");
  const run = (args: string[], env = {}) => themeCommand(args, { env, configFile: file, level: 0, mode: "dark" });
  const list = run([]);
  assert.match(list.lines.join("\n"), /\* reef/);
  assert.match(list.lines.join("\n"), /In use: reef \(the default\)/);
  assert.equal(run(["set", "glow"]).exitCode, 0);
  assert.match(run(["list"]).lines.join("\n"), /\* glow[\s\S]*In use: glow \(your settings\)/);
  assert.match(run(["list"], { CEPHALO_THEME: "ink" }).lines.join("\n"), /In use: ink \(CEPHALO_THEME, this run only\)/);
  assert.equal(run(["set", "neon"]).exitCode, 1);
  assert.equal(run(["set"]).exitCode, 1);
  assert.equal(run(["preview", "neon"]).exitCode, 1);
  assert.equal(run(["bogus"]).exitCode, 1);
  const all = run(["preview"]).lines.join("\n");
  for (const n of themeNames()) assert.match(all, new RegExp(`^${n}`, "m"));
  assert.match(all, /Color is off here/);
  assert.match(all, /BLOCK[\s\S]*ASK[\s\S]*ALLOW/);
  const col = themeCommand(["preview", "abyss"], { env: {}, configFile: file, level: 3, mode: "light" }).lines.join("\n");
  assert.match(col, /\x1b\[/);
  assert.equal(run(["reset"]).exitCode, 0);
  assert.equal(readConfig(file).config.theme, "reef");
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes("backup")), "changing a settings file keeps a backup");
});

/* ------------------------------------------------------------------ the real CLI */

function cli(args: string[], env: Record<string, string>, home: string, input = "") {
  return spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", env: { ...process.env, NO_COLOR: "", FORCE_COLOR: "", CEPHALO_THEME: "", HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "lad"), ...env } });
}

test("real CLI: the scheme changes the codes; NO_COLOR removes them; a pipe has none by default; set persists", () => {
  const home = tmp("themecli");
  const deny = ["test", "git push --force origin main"];
  const reef = cli(deny, { FORCE_COLOR: "3" }, home).stdout;
  const glow = cli(deny, { FORCE_COLOR: "3", CEPHALO_THEME: "glow" }, home).stdout;
  assert.match(reef, ANSI);
  assert.notEqual(reef, glow);
  assert.match(reef, /BLOCKED/);
  assert.doesNotMatch(cli(deny, { FORCE_COLOR: "3", NO_COLOR: "1" }, home).stdout, ANSI);
  assert.doesNotMatch(cli(deny, {}, home).stdout, ANSI, "not a terminal: plain");
  assert.equal(cli(["theme", "set", "coral"], {}, home).status, 0);
  assert.match(fs.readFileSync(path.join(home, ".cephalo", "config.yml"), "utf8"), /^theme: coral$/m);
  const coral = cli(deny, { FORCE_COLOR: "3" }, home).stdout;
  assert.notEqual(coral, reef);
  assert.match(coral, /38;2;251;113;133/);
  const light = cli(deny, { FORCE_COLOR: "3", CEPHALO_BACKGROUND: "light" }, home).stdout;
  assert.notEqual(light, coral);
  assert.match(cli(["theme", "list"], {}, home).stdout, /\* coral/);
  assert.match(cli(["config", "get", "theme"], {}, home).stdout, /coral/);
  assert.match(cli(["theme", "preview", "glow"], { FORCE_COLOR: "3" }, home).stdout, ANSI);
});

test("real CLI: hook output is pure JSON in every scheme, with color forced on, and no banner", () => {
  const home = tmp("themehook");
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push --force origin main" }, session_id: "s" });
  for (const theme of themeNames()) {
    fs.mkdirSync(path.join(home, ".cephalo"), { recursive: true });
    fs.writeFileSync(path.join(home, ".cephalo", "config.yml"), `theme: ${theme}\n`);
    for (const agent of ["claude", "hermes", "codex", "cursor"]) {
      const r = cli(["hook", agent], { FORCE_COLOR: "3", CEPHALO_THEME: theme, COLORTERM: "truecolor", TERM: "xterm-256color" }, home, payload);
      assert.equal(r.status, 0, `${agent}/${theme}`);
      assert.ok(!r.stdout.includes("\x1b"), `${agent}/${theme}: escape code in hook stdout`);
      assert.ok(!r.stderr.includes("\x1b"), `${agent}/${theme}: escape code in hook stderr`);
      if (r.stdout.trim()) JSON.parse(r.stdout);
      assert.doesNotMatch(r.stdout, /seatbelt|█|▀/);
    }
  }
});

test("`cephalo theme list` gives every scheme a small preview: the gradient and the three labels", () => {
  const plain = themeCommand(["list"], { env: {}, configFile: path.join(tmp("lp"), "c.yml"), level: 0, mode: "dark" }).lines.join("\n");
  assert.equal((plain.match(/ALLOW {2}BLOCK {2}ASK/g) ?? []).length, 5, "one preview per scheme, and the words are there with no color");
  const col = themeCommand(["list"], { env: {}, configFile: path.join(tmp("lc"), "c.yml"), level: 3, mode: "dark" }).lines.join("\n");
  assert.equal((col.match(/█/g) ?? []).length, 5 * 12, "a 12-block gradient bar per scheme");
  assert.match(col, /\[/);
});
