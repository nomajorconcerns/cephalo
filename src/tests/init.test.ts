import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../init.js";
import { claudeStatus, hermesStatus } from "../status.js";

const ABS = "C:/Users/zuri/cephalo";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-init-"));
  const files = {
    rulesFile: path.join(dir, ".cephalo", "rules.yml"),
    claudeFile: path.join(dir, ".claude", "settings.json"),
    hermesFile: path.join(dir, "hermes", "config.yaml"),
  };
  const lines: string[] = [];
  const base = { yes: true, interactive: false, confirm: async () => true, log: (l: string) => lines.push(l), abs: ABS, ...files };
  return { dir, files, lines, base };
}

test("init --yes: creates rules, creates Claude settings, skips missing Hermes", async () => {
  const { dir, files, lines, base } = setup();
  assert.equal(await runInit(base), 0);
  assert.ok(fs.existsSync(files.rulesFile));
  assert.equal(claudeStatus(files.claudeFile, ABS).current, true);
  assert.ok(!fs.existsSync(files.hermesFile));
  assert.match(lines.join("\n"), /Hermes: .* not found. Skipping/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("init --yes: installs Hermes when its config exists, keeps comments, is idempotent", async () => {
  const { dir, files, lines, base } = setup();
  fs.mkdirSync(path.dirname(files.hermesFile), { recursive: true });
  fs.writeFileSync(files.hermesFile, "# keep me\nmodel: x\n");
  assert.equal(await runInit(base), 0);
  assert.equal(hermesStatus(files.hermesFile, ABS).current, true);
  assert.match(fs.readFileSync(files.hermesFile, "utf8"), /# keep me/);
  assert.match(lines.join("\n"), /hermes hooks list/);

  lines.length = 0;
  const backupsBefore = fs.readdirSync(path.dirname(files.hermesFile)).length;
  assert.equal(await runInit(base), 0);
  assert.match(lines.join("\n"), /Nothing to change/);
  assert.equal(fs.readdirSync(path.dirname(files.hermesFile)).length, backupsBefore);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("init without --yes in a non-terminal changes nothing and exits 1", async () => {
  const { dir, files, lines, base } = setup();
  assert.equal(await runInit({ ...base, yes: false, interactive: false }), 1);
  assert.ok(!fs.existsSync(files.rulesFile));
  assert.ok(!fs.existsSync(files.claudeFile));
  assert.match(lines.join("\n"), /cephalo init --yes/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("init interactive: declining changes nothing, accepting applies", async () => {
  const { dir, files, base } = setup();
  assert.equal(await runInit({ ...base, yes: false, interactive: true, confirm: async () => false }), 0);
  assert.ok(!fs.existsSync(files.claudeFile));
  assert.equal(await runInit({ ...base, yes: false, interactive: true, confirm: async () => true }), 0);
  assert.ok(fs.existsSync(files.claudeFile));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("init upgrades an outdated hook and refuses unreadable config (exit 1, file untouched)", async () => {
  const { dir, files, base } = setup();
  fs.mkdirSync(path.dirname(files.claudeFile), { recursive: true });
  fs.writeFileSync(
    files.claudeFile,
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node ${ABS}/dist/cli.js hook claude` }] }] } }),
  );
  assert.equal(await runInit(base), 0);
  assert.equal(claudeStatus(files.claudeFile, ABS).current, true);

  fs.writeFileSync(files.claudeFile, "{ broken");
  assert.equal(await runInit(base), 1);
  assert.equal(fs.readFileSync(files.claudeFile, "utf8"), "{ broken");
  fs.rmSync(dir, { recursive: true, force: true });
});
