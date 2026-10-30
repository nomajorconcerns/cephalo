import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor, formatChecks, type Check } from "../doctor.js";
import { runInit } from "../init.js";
import { ensureRulesFile } from "../rules.js";
import { HERMES_MATCHER } from "../install.js";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-doc-"));
  // fake "abs" project with a dist/cli.js so the hook target exists
  const abs = path.join(dir, "proj").replace(/\\/g, "/");
  fs.mkdirSync(path.join(abs, "dist"), { recursive: true });
  fs.writeFileSync(path.join(abs, "dist", "cli.js"), "");
  const files = {
    rulesFile: path.join(dir, ".cephalo", "rules.yml"),
    auditFile: path.join(dir, ".cephalo", "audit.jsonl"),
    claudeFile: path.join(dir, ".claude", "settings.json"),
    hermesFile: path.join(dir, "hermes", "config.yaml"),
  };
  return { dir, abs, files };
}

const level = (checks: Check[], name: string) => checks.find((c) => c.name === name)?.level;

test("doctor on an empty machine: warns about rules/Claude, no failures, read-only", () => {
  const { dir, abs, files } = setup();
  const r = runDoctor({ ...files, abs, hermesList: () => null });
  assert.equal(r.exitCode, 0);
  assert.equal(level(r.checks, "Rules file"), "warn");
  assert.equal(level(r.checks, "Claude Code hook"), "warn");
  assert.equal(level(r.checks, "Hermes hook"), "info");
  assert.ok(!fs.existsSync(files.rulesFile), "doctor must not create the rules file");
  assert.ok(!fs.existsSync(files.auditFile), "doctor must not write the audit log");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor after init: all green except an unconfirmed Hermes approval", async () => {
  const { dir, abs, files } = setup();
  fs.mkdirSync(path.dirname(files.hermesFile), { recursive: true });
  fs.writeFileSync(files.hermesFile, "model: x\n");
  await runInit({ yes: true, interactive: false, confirm: async () => true, log: () => {}, abs, rulesFile: files.rulesFile, claudeFile: files.claudeFile, hermesFile: files.hermesFile });

  const notApproved = `[pre_tool_call]\n  - node ${abs}/dist/cli.js hook hermes matcher='${HERMES_MATCHER}' (timeout=10s, ✗ not allowlisted)`;
  let r = runDoctor({ ...files, abs, hermesList: () => notApproved });
  assert.equal(r.exitCode, 1);
  assert.equal(level(r.checks, "Hermes approval"), "fail");
  assert.equal(level(r.checks, "Self-test"), "ok");
  assert.equal(level(r.checks, "Rules file"), "ok");
  assert.equal(level(r.checks, "Claude Code hook"), "ok");
  assert.equal(level(r.checks, "Hermes hook"), "ok");

  const approved = `[pre_tool_call]\n  - node ${abs}/dist/cli.js hook hermes matcher='${HERMES_MATCHER}' (timeout=10s, ✓ allowlisted)`;
  r = runDoctor({ ...files, abs, hermesList: () => approved });
  assert.equal(r.exitCode, 0);
  assert.equal(level(r.checks, "Hermes approval"), "ok");
  assert.match(formatChecks(r.checks).join("\n"), /All good|No problems/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor flags a missing hook target, a broken rules file, a removed no-drop rule", async () => {
  const { dir, abs, files } = setup();
  await runInit({ yes: true, interactive: false, confirm: async () => true, log: () => {}, abs, rulesFile: files.rulesFile, claudeFile: files.claudeFile, hermesFile: files.hermesFile });
  fs.rmSync(path.join(abs, "dist", "cli.js"));
  let r = runDoctor({ ...files, abs, hermesList: () => null });
  assert.equal(level(r.checks, "Claude Code hook target"), "fail");
  assert.equal(r.exitCode, 1);

  fs.mkdirSync(path.dirname(files.rulesFile), { recursive: true });
  fs.writeFileSync(files.rulesFile, "rules:\n  - id: x\n    type: command\n    pattern: '('\n    action: block\n");
  r = runDoctor({ ...files, abs, hermesList: () => null });
  assert.equal(level(r.checks, "Rules file"), "fail");
  assert.match(r.checks.find((c) => c.name === "Rules file")!.detail, /invalid pattern/);

  fs.writeFileSync(files.rulesFile, "rules:\n  - id: only\n    type: command\n    pattern: 'zzz'\n    action: block\n");
  r = runDoctor({ ...files, abs, hermesList: () => null });
  assert.equal(level(r.checks, "Self-test"), "fail");
  assert.equal(level(r.checks, "Default rules"), "warn");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("doctor: unreadable Claude settings is a failure; installed-but-wrong hook is a failure", () => {
  const { dir, abs, files } = setup();
  ensureRulesFile(files.rulesFile);
  fs.mkdirSync(path.dirname(files.claudeFile), { recursive: true });
  fs.writeFileSync(files.claudeFile, "{ nope");
  let r = runDoctor({ ...files, abs, hermesList: () => null });
  assert.equal(level(r.checks, "Claude Code hook"), "fail");

  fs.writeFileSync(files.claudeFile, JSON.stringify({ hooks: {} }));
  r = runDoctor({ ...files, abs, hermesList: () => null });
  assert.equal(level(r.checks, "Claude Code hook"), "fail");
  assert.match(r.checks.find((c) => c.name === "Claude Code hook")!.detail, /NOT being checked/);
  fs.rmSync(dir, { recursive: true, force: true });
});
