import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { getPlatform, ALL_PLATFORMS } from "../platform.js";
import { evaluate } from "../engine.js";
import { DEFAULT_RULES } from "../rules.js";

test("getPlatform maps node platform ids; unknown POSIX falls back to linux", () => {
  assert.equal(getPlatform("win32").id, "win32");
  assert.equal(getPlatform("darwin").id, "darwin");
  assert.equal(getPlatform("linux").id, "linux");
  assert.equal(getPlatform("freebsd").id, "linux");
  assert.equal(ALL_PLATFORMS.length, 3);
});

test("config and data locations per OS", () => {
  const w = getPlatform("win32");
  const wenv = { home: "C:\\Users\\a", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } as NodeJS.ProcessEnv };
  assert.equal(w.claudeSettingsPath(wenv), path.join("C:\\Users\\a", ".claude", "settings.json"));
  assert.equal(w.hermesConfigPath(wenv), path.join("C:\\Users\\a\\AppData\\Local", "hermes", "config.yaml"));
  assert.equal(w.hermesConfigPath({ home: "C:\\Users\\a", env: {} }), path.join("C:\\Users\\a", "AppData", "Local", "hermes", "config.yaml"));
  for (const id of ["darwin", "linux"]) {
    const p = getPlatform(id);
    const e = { home: "/home/a", env: {} };
    assert.equal(p.hermesConfigPath(e), path.join("/home/a", ".hermes", "config.yaml"));
    assert.equal(p.claudeSettingsPath(e), path.join("/home/a", ".claude", "settings.json"));
    assert.equal(p.dataDir(e), path.join("/home/a", ".cephalo"));
  }
  assert.equal(w.dataDir(wenv), path.join("C:\\Users\\a", ".cephalo"));
  assert.equal(w.spawnOptions().shell, true);
  assert.equal(getPlatform("linux").spawnOptions().shell, false);
});

test("windows path normalization", () => {
  const w = getPlatform("win32");
  const e = { home: "C:\\Users\\a", env: { USERPROFILE: "C:\\Users\\a" } as NodeJS.ProcessEnv };
  assert.equal(w.normalizePath("C:\\Users\\a\\proj\\..\\.claude\\settings.json", e), "C:/Users/a/.claude/settings.json");
  assert.equal(w.normalizePath("%USERPROFILE%\\.env", e), "C:/Users/a/.env");
  assert.equal(w.normalizePath("$env:USERPROFILE\\.env", e), "C:/Users/a/.env");
  assert.equal(w.normalizePath("~\\.env", e), "C:/Users/a/.env");
  assert.equal(w.normalizePath("\\\\?\\C:\\x\\.env", e), "C:/x/.env");
});

test("posix path normalization", () => {
  const l = getPlatform("linux");
  const e = { home: "/home/a", env: {} };
  assert.equal(l.normalizePath("~/proj/../.claude/settings.json", e), "/home/a/.claude/settings.json");
  assert.equal(l.normalizePath("$HOME/.env", e), "/home/a/.env");
  assert.equal(l.normalizePath("/home//a/./x", e), "/home/a/x");
  const m = getPlatform("darwin");
  assert.equal(m.normalizePath("/private/etc/hosts", e), "/etc/hosts");
  assert.equal(m.normalizePath("/private/var/log/x", e), "/var/log/x");
  assert.equal(m.normalizePath("/private/other", e), "/private/other");
});

test("command normalization strips shell obfuscation", () => {
  const l = getPlatform("linux");
  assert.equal(l.normalizeCommand("r''m -rf /x"), "rm -rf /x");
  assert.equal(l.normalizeCommand('r""m -rf /x'), "rm -rf /x");
  assert.equal(l.normalizeCommand("\\rm -rf /x"), "rm -rf /x");
  assert.equal(l.normalizeCommand("r\\m -rf /x"), "rm -rf /x");
  assert.equal(l.normalizeCommand("rm \\\n -rf /x"), "rm   -rf /x");
  const w = getPlatform("win32");
  assert.equal(w.normalizeCommand("r^d /s /q C:\\x"), "rd /s /q C:\\x");
  assert.equal(w.normalizeCommand("Remove`-Item -Recurse -Force x"), "Remove-Item -Recurse -Force x");
});

test("engine blocks obfuscated forms on each OS and never gets weaker than raw matching", () => {
  const rules = DEFAULT_RULES;
  const l = getPlatform("linux");
  assert.equal(evaluate({ command: "r''m -rf /x" }, rules, l).decision, "block");
  assert.equal(evaluate({ command: "\\rm -rf /x" }, rules, l).decision, "block");
  assert.equal(evaluate({ command: "rm -rf /x" }, rules, l).rule?.id, "no-rm-rf");
  assert.equal(evaluate({ command: "ls -la" }, rules, l).decision, "allow");
  const w = getPlatform("win32");
  assert.equal(evaluate({ command: "r^d /s /q C:\\x" }, rules, w).rule?.id, "no-win-recursive-delete");
  assert.equal(evaluate({ command: "Remove`-Item x -Recurse -Force" }, rules, w).decision, "block");
  // path rules see the normalized path
  const e = evaluate({ path: "C:\\proj\\sub\\..\\.env", access: "read" }, rules, w);
  assert.equal(e.rule?.id, "no-secret-file");
  const m = evaluate({ path: "/Users/a/proj/../.claude/settings.json", access: "write" }, rules, getPlatform("darwin"));
  assert.equal(m.rule?.id, "protect-config");
  assert.equal(evaluate({ path: "/home/a/src/app.ts", access: "write" }, rules, l).decision, "allow");
  assert.equal(evaluate({ path: "/home/a/.env.example", access: "read" }, rules, l).decision, "allow");
});
