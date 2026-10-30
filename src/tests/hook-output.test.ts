import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const ANSI = /\x1b\[/;

let tmp: string;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-hook-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args: string[], input: string | undefined, env: Record<string, string>) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    input: input ?? "",
    encoding: "utf8",
    env: {
      ...process.env,
      USERPROFILE: tmp,
      HOME: tmp,
      LOCALAPPDATA: tmp,
      ...env,
    },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const hook = (agent: string, input: string) => run(["hook", agent], input, { FORCE_COLOR: "1" });

function assertClean(r: { stdout: string; stderr: string; status: number | null }) {
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, ANSI);
  assert.ok(!r.stdout.includes("\x1b"));
  assert.doesNotMatch(r.stderr, ANSI);
}

const claudeIn = (command: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command } });
const hermesIn = (command: string) =>
  JSON.stringify({
    hook_event_name: "pre_tool_call",
    tool_name: "terminal",
    tool_input: { command },
    session_id: "s",
    cwd: ".",
    extra: {},
  });

test("claude hook: blocked call emits pure JSON deny", () => {
  const r = hook("claude", claudeIn("DROP TABLE users"));
  assertClean(r);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("claude hook: allowed call emits empty stdout", () => {
  const r = hook("claude", claudeIn("ls"));
  assertClean(r);
  assert.equal(r.stdout, "");
});

test("claude hook: malformed JSON stays clean", () => {
  assertClean(hook("claude", "{not json"));
});

test("hermes hook: blocked call emits pure JSON block", () => {
  const r = hook("hermes", hermesIn("DROP TABLE users"));
  assertClean(r);
  assert.equal(JSON.parse(r.stdout).action, "block");
});

test("hermes hook: allowed call emits {}", () => {
  const r = hook("hermes", hermesIn("ls"));
  assertClean(r);
  assert.equal(r.stdout.trim(), "{}");
});

test("hermes hook: malformed JSON stays clean", () => {
  assertClean(hook("hermes", "{not json"));
});

for (const args of [[], ["--help"], ["-h"], ["help"], ["init", "--yes"]]) {
  const name = args.join(" ") || "(no args)";
  test(`positive control: cephalo ${name} shows banner`, () => {
    const colored = run(args, "", { FORCE_COLOR: "1", NO_COLOR: "" });
    assert.equal(colored.status, 0);
    assert.match(colored.stdout, ANSI);
    assert.match(colored.stdout, /cephalo/i);

    const plain = run(args, "", { NO_COLOR: "1", FORCE_COLOR: "" });
    assert.equal(plain.status, 0);
    assert.doesNotMatch(plain.stdout, ANSI);
    assert.match(plain.stdout, /cephalo/);
  });
}

test("unknown command: usage on stderr, exit 1, no banner", () => {
  const r = run(["bogus"], "", { FORCE_COLOR: "1" });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.doesNotMatch(r.stderr, ANSI);
});
