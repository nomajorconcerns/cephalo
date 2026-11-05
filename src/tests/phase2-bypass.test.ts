import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { evaluate } from "../engine.js";
import { runHook } from "../hooks.js";
import { CLAUDE_MATCHER, HERMES_MATCHER } from "../install.js";
import { getPlatform } from "../platform.js";
import { SYSTEM_RULES, defaultInstallRoots, installGuardRules } from "../platform-rules.js";
import { DEFAULT_RULES, activePlatformRules, type Rule } from "../rules.js";
import type { TripHookOptions } from "../tripwire/hook.js";
import { recordEvent } from "../tripwire/state.js";

const linux = getPlatform("linux");
const host = getPlatform();
const RULES = [...DEFAULT_RULES, ...activePlatformRules(DEFAULT_RULES, linux)];
const verdict = (command: string) => evaluate({ command }, RULES, linux);
const tmp = (name: string) => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `cephalo-${name}-`)));

/* ------------------------------------------------------------------ 5. the commands that got through */

const BLOCK: Array<[string, string]> = [
  [`python3 -c "open('/home/u/.cephalo/rules.yml','w').write('x')"`, "no-protected-write-code"],
  [`python3 -c "import pathlib; pathlib.Path('/home/u/.cephalo/rules.yml').write_text('x')"`, "no-protected-write-code"],
  [`python3 -c 'open("/home/u/.cephalo/audit.jsonl", "a").write("")'`, "no-protected-write-code"],
  [`python3 -c "with open(__import__('os').path.expanduser('~/.cephalo/rules.yml'), 'w') as f: f.write('x')"`, "no-protected-write-code"],
  [`node -e "require('fs').writeFileSync('/home/u/.claude/settings.json','{}')"`, "no-protected-write-code"],
  ["ln -s ~/.cephalo/rules.yml notes.yml", "no-protected-symlink"],
  ["ln -sf /home/u/.claude/settings.json x", "no-protected-symlink"],
  ["grep . .env", "no-secret-shell"],
  ["awk 1 .env", "no-secret-shell"],
  ["cp .env /tmp/x", "no-secret-shell"],
  ["cat .env.local", "no-secret-read"], // the older default rule gets there first
  ["source .env", "no-secret-shell"],
  ["sed -n 1p config/.env", "no-secret-shell"],
  ["docker run --env-file=.env img", "no-secret-shell"],
  ["echo '{}' > ~/.claude/settings.json", "no-agent-config-tamper"],
  ["echo '{}' > /home/u/.claude/settings.local.json", "no-agent-config-tamper"],
  ["sed -i s/a/b/ /home/u/.claude/settings.json", "no-agent-config-tamper"],
  ["cp evil.json ~/.claude/settings.json", "no-agent-config-tamper"],
  ["mv x /home/u/.hermes/config.yaml", "no-agent-config-tamper"],
  ["tee /home/u/.hermes/config.yaml < x", "no-agent-config-tamper"],
  ["copy evil.yaml C:\\Users\\u\\AppData\\Local\\hermes\\config.yaml", "no-agent-config-tamper"],
  // the same rules after quote evasion: only the normalized variant sees these
  ["cp .e''nv /tmp/x", "no-secret-shell"],
  ["ec''ho '{}' > ~/.claude/settings.json", "no-agent-config-tamper"],
];

const ALLOW = [
  "cat ~/.claude/settings.json", // reading the config stays allowed
  "cp ~/.claude/settings.json /tmp/settings-backup.json", // the config is the source, not the target
  "cat .env.example",
  "git add .env.example",
  "cat .envrc",
  "cat .environment",
  'grep -r "process.env" src',
  "ls",
  "ln -s a b",
  `python3 -c "print(1)"`,
  `python3 -c "open('notes.txt','w').write('x')"`,
  `python3 -c "print(open('/home/u/.cephalo/rules.yml').read())"`, // reading the rules file stays allowed
  "echo '{}' > settings.json",
  "npm run build && echo done",
];

for (const [command, ruleId] of BLOCK) {
  test(`blocks: ${command}`, () => {
    const v = verdict(command);
    assert.equal(v.decision, "block", command);
    assert.equal(v.rule?.id, ruleId, `${command} -> ${v.rule?.id}`);
  });
}
for (const command of ALLOW) {
  test(`allows: ${command}`, () => assert.equal(verdict(command).decision, "allow", `${command} -> ${verdict(command).rule?.id}`));
}

test("the new shell rules are system rules, so they protect existing installs with no change to rules.yml", () => {
  const ids = new Set(SYSTEM_RULES.map((r) => r.id));
  for (const id of ["no-secret-shell", "no-agent-config-tamper", "no-protected-symlink", "no-protected-write-code", "no-install-tamper", "protect-cephalo-install"]) assert.ok(ids.has(id), id);
  const fileIds = new Set(DEFAULT_RULES.map((r) => r.id));
  for (const id of ids) assert.ok(!fileIds.has(id), `${id} must not duplicate a default rule id`);
});

test("ReDoS: every new pattern stays fast on 10k-character adversarial input", () => {
  const ids = ["no-secret-shell", "no-agent-config-tamper", "no-protected-symlink", "no-protected-write-code", "no-install-tamper"];
  const rules = SYSTEM_RULES.filter((r) => ids.includes(r.id));
  assert.equal(rules.length, ids.length);
  const hostile = [
    " -c".repeat(4000),
    "open(" + "x".repeat(10_000),
    ".cephalo/rules.yml".repeat(600),
    "> ".repeat(5000) + ".claude/settings.json",
    "'".repeat(10_000),
    "ln ".repeat(3500) + ".cephalo",
    "cp " + "a ".repeat(5000),
    ".env".repeat(2500),
    " .env.".repeat(1600) + "x",
    "tee " + "/.claude/settings".repeat(600),
    "writeFile ".repeat(1000) + "x".repeat(300),
  ];
  for (const r of rules) {
    for (const s of hostile) {
      const t0 = Date.now();
      new vm.Script("new RegExp(src, 'i').test(s)").runInNewContext({ src: r.pattern, s }, { timeout: 4000 });
      const ms = Date.now() - t0;
      assert.ok(ms < 1500, `${r.id} took ${ms}ms on a ${s.length}-char string`);
    }
  }
});

/* ------------------------------------------------------------------ 2. relative paths and symlinks */

test("a relative path is resolved against the session's cwd before path rules run", () => {
  const home = tmp("rel");
  const cwd = path.join(home, "proj");
  fs.mkdirSync(cwd, { recursive: true });
  const rules = [...SYSTEM_RULES];
  const w = (p: string, c?: string) => evaluate({ path: p, access: "write", cwd: c }, rules, host);
  assert.equal(w(path.join("..", ".cephalo", "rules.yml"), cwd).rule?.id, "protect-audit-log");
  assert.equal(w(".cephalo/audit.jsonl", home).rule?.id, "protect-audit-log");
  assert.equal(w("sub/../.cephalo/rules.yml", home).rule?.id, "protect-audit-log");
  assert.equal(w("notes.txt", cwd).decision, "allow");
  assert.equal(w("rules.yml").decision, "allow", "without a cwd there is nothing to resolve against: unchanged behaviour");
  const secret = evaluate({ path: ".env", access: "read", cwd: home }, [...DEFAULT_RULES], host);
  assert.equal(secret.rule?.id, "no-secret-file");
});

function trySymlink(target: string, link: string, type?: "file" | "dir" | "junction"): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false; // Windows without the privilege (or developer mode) cannot create symlinks
  }
}

test("symlinks are resolved with realpath before path rules run (a link to the rules file, then a Write to the link)", (t) => {
  const home = tmp("link");
  fs.mkdirSync(path.join(home, ".cephalo"));
  fs.writeFileSync(path.join(home, ".cephalo", "rules.yml"), "rules: []\n");
  const proj = path.join(home, "proj");
  fs.mkdirSync(proj);
  if (!trySymlink(path.join(home, ".cephalo", "rules.yml"), path.join(proj, "notes.yml"), "file")) return t.skip("cannot create symlinks here");
  const rules = [...SYSTEM_RULES];
  const viaFile = evaluate({ path: path.join(proj, "notes.yml"), access: "write" }, rules, host);
  assert.equal(viaFile.rule?.id, "protect-audit-log", "absolute path to the link");
  assert.equal(evaluate({ path: "notes.yml", access: "write", cwd: proj }, rules, host).rule?.id, "protect-audit-log", "relative path to the link");
  // a link to the folder, and a file that does not exist yet inside it
  if (trySymlink(path.join(home, ".cephalo"), path.join(proj, "data"), process.platform === "win32" ? "junction" : "dir")) {
    assert.equal(evaluate({ path: path.join(proj, "data", "rules.yml"), access: "write" }, rules, host).rule?.id, "protect-audit-log");
    assert.equal(evaluate({ path: "data/audit.jsonl", access: "write", cwd: proj }, rules, host).rule?.id, "protect-audit-log", "not created yet");
  }
  assert.equal(evaluate({ path: path.join(proj, "plain.txt"), access: "write" }, rules, host).decision, "allow");
});

test("a link to the Cephalo folder (a junction on Windows, which needs no privilege) does not hide the files inside it", (t) => {
  const home = tmp("dirlink");
  fs.mkdirSync(path.join(home, ".cephalo"));
  fs.writeFileSync(path.join(home, ".cephalo", "rules.yml"), "rules: []\n");
  const proj = path.join(home, "proj");
  fs.mkdirSync(proj);
  if (!trySymlink(path.join(home, ".cephalo"), path.join(proj, "data"), process.platform === "win32" ? "junction" : "dir")) return t.skip("cannot create links here");
  const rules = [...SYSTEM_RULES];
  assert.equal(evaluate({ path: path.join(proj, "data", "rules.yml"), access: "write" }, rules, host).rule?.id, "protect-audit-log");
  assert.equal(evaluate({ path: "data/audit.jsonl", access: "write", cwd: proj }, rules, host).rule?.id, "protect-audit-log", "a file that does not exist yet, inside the link");
  assert.equal(evaluate({ path: "data/other.txt", access: "write", cwd: proj }, rules, host).decision, "allow", "other files in the folder are not protected");
  assert.equal(evaluate({ path: "data/rules.yml", access: "read", cwd: proj }, rules, host).decision, "allow", "reading stays allowed");
});

test("a link to a .env file does not hide it from the read rule", (t) => {
  const dir = tmp("envlink");
  fs.writeFileSync(path.join(dir, ".env"), "K=v\n");
  if (!trySymlink(path.join(dir, ".env"), path.join(dir, "config.txt"), "file")) return t.skip("cannot create symlinks here");
  const r = evaluate({ path: "config.txt", access: "read", cwd: dir }, [...DEFAULT_RULES], host);
  assert.equal(r.rule?.id, "no-secret-file");
});

/* ------------------------------------------------------------------ 4. Cephalo's own install folder */

test("Cephalo's install folder (the dist/ the hook runs) cannot be written by the agent", () => {
  const root = tmp("install");
  const rules = installGuardRules([root]);
  const w = (p: string) => evaluate({ path: p, access: "write" }, rules, host);
  const r = (p: string) => evaluate({ path: p, access: "read" }, rules, host);
  assert.equal(w(path.join(root, "dist", "hooks.js")).rule?.id, "protect-cephalo-install");
  assert.equal(w(path.join(root, "dist", "tests", "x.js")).rule?.id, "protect-cephalo-install");
  assert.equal(w(path.join("dist", "cli.js")).decision, "allow", "relative with no cwd is not guessed at");
  assert.equal(evaluate({ path: path.join("dist", "cli.js"), access: "write", cwd: root }, rules, host).rule?.id, "protect-cephalo-install", "relative to the cwd");
  assert.equal(r(path.join(root, "dist", "hooks.js")).decision, "allow", "reading it is fine");
  assert.equal(w(path.join(root, "src", "hooks.ts")).decision, "allow", "source files are not the running hook");
  assert.equal(w(path.join(root, "distillery", "x")).decision, "allow");
  const slash = root.replace(/\\/g, "/");
  const bash = (c: string) => evaluate({ command: c }, rules, linux);
  assert.equal(bash(`echo x > ${slash}/dist/cli.js`).rule?.id, "no-install-tamper");
  assert.equal(bash(`rm -f ${slash}/dist/hooks.js`).rule?.id, "no-install-tamper");
  assert.equal(bash(`cp evil.js ${slash}/dist/cli.js`).rule?.id, "no-install-tamper");
  assert.equal(bash(`sed -i s/a/b/ ${root}${path.sep}dist${path.sep}cli.js`).rule?.id, "no-install-tamper");
  assert.equal(bash(`python3 -c "open('${slash}/dist/cli.js','w').write('')"`).rule?.id, "no-protected-write-code");
  assert.equal(bash(`cat ${slash}/dist/cli.js`).decision, "allow");
  assert.equal(bash(`cp ${slash}/dist/cli.js /tmp/copy.js`).decision, "allow");
  assert.equal(bash(`ls ${slash}/dist`).decision, "allow");
});

test("the real install folder is guarded by the built-in rules", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  assert.ok(defaultInstallRoots().some((r) => r.toLowerCase() === root.toLowerCase() || fs.realpathSync.native(root).toLowerCase() === r.toLowerCase()), "roots include this install");
  const v = evaluate({ path: path.join(root, "dist", "hooks.js"), access: "write" }, [...SYSTEM_RULES], host);
  assert.equal(v.rule?.id, "protect-cephalo-install");
});

/* ------------------------------------------------------------------ 1. Grep, Glob, WebFetch, WebSearch and Hermes' matching tools */

const pre = (tool: string, input: object, extra: object = {}) => ({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, ...extra });

function world() {
  const dir = tmp("search");
  const audit = path.join(dir, "audit.jsonl");
  const tripDir = path.join(dir, "trip");
  const trip: TripHookOptions = { dir: tripDir, policy: { mode: "enforce" } };
  const rules: Rule[] = [...DEFAULT_RULES, ...host.rules()];
  const run = (agent: "claude" | "hermes", payload: object, over: { trip?: TripHookOptions } = {}) =>
    runHook(agent, JSON.stringify(payload), { auditFile: audit, rules, tripwire: over.trip ?? trip });
  const denied = (out: string, ruleId?: string) => {
    if (!out) return false;
    const text = out.includes("hookSpecificOutput") ? JSON.parse(out).hookSpecificOutput.permissionDecisionReason : JSON.parse(out).message;
    return ruleId ? text.includes(`rule: ${ruleId}`) : true;
  };
  return { dir, audit, trip, tripDir, rules, run, denied };
}

test("Claude Grep and Glob cannot read or list .env files", () => {
  const w = world();
  const withEnv = path.join(w.dir, "app");
  fs.mkdirSync(path.join(withEnv, "sub"), { recursive: true });
  fs.writeFileSync(path.join(withEnv, "sub", ".env"), "K=v\n");
  fs.writeFileSync(path.join(withEnv, "index.ts"), "x\n");
  const clean = path.join(w.dir, "clean");
  fs.mkdirSync(clean);
  fs.writeFileSync(path.join(clean, "index.ts"), "x\n");
  fs.writeFileSync(path.join(clean, ".env.example"), "K=\n");

  const grep = (input: object, cwd = clean) => w.run("claude", pre("Grep", input, { cwd }));
  const glob = (input: object, cwd = clean) => w.run("claude", pre("Glob", input, { cwd }));

  // aimed at the file itself (path rule), at its name (filters), or at a folder that holds one (scan)
  assert.ok(w.denied(grep({ pattern: "K", path: path.join(withEnv, "sub", ".env") }), "no-secret-file"));
  assert.ok(w.denied(grep({ pattern: "K", glob: ".env*", path: clean }), "no-secret-search"));
  assert.ok(w.denied(grep({ pattern: "K", glob: "**/.env" }), "no-secret-search"));
  assert.ok(w.denied(grep({ pattern: "K", glob: "{*.ts,.env.local}" }), "no-secret-search"));
  assert.ok(w.denied(grep({ pattern: "K", path: withEnv }), "no-secret-search"), "a folder with a .env inside, no filter");
  assert.ok(w.denied(grep({ pattern: "K" }, withEnv)), "no path: the cwd is searched");
  assert.ok(w.denied(grep({ pattern: "K", path: "." }, withEnv)), "relative path is resolved against the cwd");
  assert.ok(w.denied(glob({ pattern: "**/.env*" }), "no-secret-search"));
  assert.ok(w.denied(glob({ pattern: ".env", path: withEnv }), "no-secret-search"));
  // allowed: nothing aimed at a secret
  assert.equal(grep({ pattern: "K", path: clean }), "", ".env.example is not a secret");
  assert.equal(grep({ pattern: "K", glob: "*.ts", path: withEnv }), "", "a filter that excludes .env narrows the search");
  assert.equal(grep({ pattern: "process.env" }), "");
  assert.equal(glob({ pattern: "**/*.ts" }, withEnv), "");
  assert.equal(glob({ pattern: "src/**/*.js" }), "");
  // a denied search is logged as a block
  const log = fs.readFileSync(w.audit, "utf8");
  assert.match(log, /"tool":"Grep"[^\n]*"decision":"block"[^\n]*"rule":"no-secret-search"/);
});

test("Hermes search_files cannot read or list .env files", () => {
  const w = world();
  const withEnv = path.join(w.dir, "app");
  fs.mkdirSync(withEnv);
  fs.writeFileSync(path.join(withEnv, ".env"), "K=v\n");
  const clean = path.join(w.dir, "clean");
  fs.mkdirSync(clean);
  const sf = (input: object) => w.run("hermes", pre("search_files", input));
  assert.ok(w.denied(sf({ pattern: "K", target: "content", path: withEnv }), "no-secret-search"));
  assert.ok(w.denied(sf({ pattern: "K", target: "content", path: clean, file_glob: ".env*" }), "no-secret-search"));
  assert.ok(w.denied(sf({ pattern: ".env*", target: "files", path: clean }), "no-secret-search"));
  assert.ok(w.denied(sf({ pattern: "K", path: path.join(withEnv, ".env") }), "no-secret-file"));
  assert.equal(sf({ pattern: "K", target: "content", path: clean }), "{}");
  assert.equal(sf({ pattern: ".env", target: "content", path: clean }), "{}", "in content mode `pattern` is text to find, not a file name");
  assert.equal(sf({ pattern: "*.ts", target: "files", path: withEnv }), "{}");
});

test("the installer matchers cover Grep, Glob, WebFetch, WebSearch and Hermes' web tools", () => {
  const has = (matcher: string, tool: string) => new RegExp(`^(?:${matcher})$`).test(tool);
  for (const t of ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Grep", "Glob", "WebFetch", "WebSearch", "mcp__fs__read"]) assert.ok(has(CLAUDE_MATCHER, t), `claude ${t}`);
  for (const t of ["terminal", "read_file", "write_file", "patch", "search_files", "execute_code", "web_search", "web_extract", "mcp_fs_read"]) assert.ok(has(HERMES_MATCHER, t), `hermes ${t}`);
  assert.ok(!has(CLAUDE_MATCHER, "Task"));
});

/* ------------------------------------------------------------------ 6. a tripwire-locked session loses the web tools */

test("a session locked by the tripwire also loses WebFetch, WebSearch, web_search and web_extract", () => {
  const w = world();
  const lock = (agent: string, session: string) =>
    recordEvent(agent, session, { ts: new Date().toISOString(), tool: "Read", level: "alert", findings: [{ id: "t", severity: "high", label: "test lock", excerpt: "-" }] }, w.tripDir);
  lock("claude", "locked");
  lock("hermes", "locked");

  const claude = (tool: string, input: object, session: string) => w.run("claude", pre(tool, input, { session_id: session }));
  const hermes = (tool: string, input: object, session: string) => w.run("hermes", pre(tool, input, { session_id: session }));

  assert.ok(w.denied(claude("WebFetch", { url: "https://example.com/x", prompt: "p" }, "locked"), "trip-web"));
  assert.ok(w.denied(claude("WebSearch", { query: "q" }, "locked"), "trip-web"));
  assert.ok(w.denied(hermes("web_search", { query: "q" }, "locked"), "trip-web"));
  assert.ok(w.denied(hermes("web_extract", { urls: ["https://example.com/x"] }, "locked"), "trip-web"));
  // other tools in the locked session keep working, and so do the web tools in a clean session
  assert.equal(claude("Read", { file_path: path.join(w.dir, "a.txt") }, "locked"), "");
  assert.equal(claude("WebFetch", { url: "https://example.com/x" }, "clean"), "");
  assert.equal(claude("WebSearch", { query: "q" }, "clean"), "");
  assert.equal(hermes("web_search", { query: "q" }, "clean"), "{}");
  // warn mode would have blocked, but allows and says so
  const warn: TripHookOptions = { dir: w.tripDir, policy: { mode: "warn" } };
  assert.equal(w.run("claude", pre("WebFetch", { url: "https://example.com/x" }, { session_id: "locked" }), { trip: warn }), "");
  assert.match(fs.readFileSync(w.audit, "utf8"), /"tool":"WebFetch"[^\n]*"decision":"allow"[^\n]*would have blocked trip-web/);
  // the audit log records the host only, never the URL path or query
  const log = fs.readFileSync(w.audit, "utf8");
  assert.match(log, /WebFetch example\.com/);
  assert.doesNotMatch(log, /example\.com\/x/);
});
