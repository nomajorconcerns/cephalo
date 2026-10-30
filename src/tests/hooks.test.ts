import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "../hooks.js";
import { DEFAULT_RULES } from "../rules.js";
import { readAudit } from "../audit.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-hook-"));
  const auditFile = path.join(dir, "audit.jsonl");
  return { dir, opts: { rules: DEFAULT_RULES, auditFile } };
}

const MSG = (id: string, d: string) =>
  `🛑 Cephalo blocked this (rule: ${id} - ${d}). If it is intended, ask the user to run it themselves.`;

test("claude: Bash DROP TABLE is denied with exact JSON", () => {
  const { dir, opts } = setup();
  const out = runHook("claude", JSON.stringify({ tool_name: "Bash", tool_input: { command: "DROP TABLE users" } }), opts);
  assert.equal(
    out,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: MSG("no-drop", "Dropping tables or databases"),
      },
    }),
  );
  const log = readAudit({}, opts.auditFile);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.decision, "block");
  assert.equal(log[0]!.rule, "no-drop");
  assert.equal(log[0]!.agent, "claude");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("claude: Read .env denied, Write settings.json denied, Edit src allowed", () => {
  const { dir, opts } = setup();
  const run = (tool_name: string, file_path: string) =>
    runHook("claude", JSON.stringify({ tool_name, tool_input: { file_path } }), opts);
  assert.match(run("Read", "C:\\proj\\.env"), /no-secret-file/);
  assert.match(run("Write", "C:\\Users\\zuri\\.claude\\settings.json"), /protect-config/);
  assert.equal(run("Edit", "src/index.ts"), "");
  assert.match(run("MultiEdit", "C:\\Users\\zuri\\.claude\\settings.json"), /protect-config/);
  const nb = (notebook_path: string) =>
    runHook("claude", JSON.stringify({ tool_name: "NotebookEdit", tool_input: { notebook_path } }), opts);
  assert.match(nb("C:\\p\\.env"), /no-secret-file/);
  assert.equal(nb("a.ipynb"), "");
  assert.equal(run("Read", "C:\\Users\\zuri\\.claude\\settings.json"), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("claude: allowed command prints nothing", () => {
  const { dir, opts } = setup();
  assert.equal(runHook("claude", JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" } }), opts), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hermes: terminal block / allow, path tools", () => {
  const { dir, opts } = setup();
  const run = (tool_name: string, tool_input: object) =>
    runHook("hermes", JSON.stringify({ hook_event_name: "pre_tool_call", tool_name, tool_input, session_id: "s", cwd: ".", extra: {} }), opts);
  assert.equal(
    run("terminal", { command: "git push --force origin main" }),
    JSON.stringify({ action: "block", message: MSG("no-force-push", "Force pushing to git remotes") }),
  );
  assert.equal(run("terminal", { command: "git push origin main" }), "{}");
  assert.match(run("read_file", { path: ".env" }), /"action":"block"/);
  assert.match(run("write_file", { path: "C:\\Users\\zuri\\AppData\\Local\\hermes\\config.yaml" }), /protect-config/);
  assert.equal(run("patch", { path: "C:\\Users\\zuri\\.cephalo\\rules.yml" }), "{}");
  assert.match(run("search_files", { path: "C:\\proj\\.env" }), /no-secret-file/);
  assert.equal(run("search_files", { path: "src" }), "{}");
  assert.match(run("execute_code", { code: "import os; os.system('rm -rf /')" }), /no-rm-rf/);
  assert.equal(run("execute_code", { code: "print(1)" }), "{}");
  assert.equal(run("write_file", { path: "src/a.ts" }), "{}");
  assert.equal(run("web_search", { query: "x" }), "{}");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("fail-open: bad JSON allows and logs the error", () => {
  const { dir, opts } = setup();
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as any).write = (s: string) => ((captured += s), true);
  try {
    assert.equal(runHook("claude", "not json{", opts), "");
    assert.equal(runHook("hermes", "", opts), "{}");
  } finally {
    process.stderr.write = origWrite;
  }
  assert.match(captured, /hook error/);
  const log = readAudit({}, opts.auditFile);
  assert.equal(log.length, 2);
  assert.ok(log.every((e) => e.decision === "allow" && e.error));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("block still enforced when audit log cannot be written", () => {
  const { dir, opts } = setup();
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = () => true;
  try {
    // audit "file" is a directory -> append fails
    const out = runHook("claude", JSON.stringify({ tool_name: "Bash", tool_input: { command: "git reset --hard" } }), {
      rules: DEFAULT_RULES,
      auditFile: dir,
    });
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    process.stderr.write = origWrite;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readAudit: --blocked filter and limit, newest last", () => {
  const { dir, opts } = setup();
  for (const c of ["npm test", "DROP TABLE a", "ls", "git reset --hard"]) {
    runHook("claude", JSON.stringify({ tool_name: "Bash", tool_input: { command: c } }), opts);
  }
  const blocked = readAudit({ blocked: true }, opts.auditFile);
  assert.deepEqual(blocked.map((e) => e.command), ["DROP TABLE a", "git reset --hard"]);
  assert.deepEqual(readAudit({ limit: 2 }, opts.auditFile).map((e) => e.command), ["ls", "git reset --hard"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
