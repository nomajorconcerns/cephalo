import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate } from "../engine.js";
import { DEFAULT_RULES, loadRules } from "../rules.js";

const ev = (i: Parameters<typeof evaluate>[0]) => evaluate(i, DEFAULT_RULES);

const blockedCommands: [string, string][] = [
  ["DROP TABLE users", "no-drop"],
  ['psql -c "drop database prod"', "no-drop"],
  ["rm -rf /", "no-rm-rf"],
  ["rm -fr build", "no-rm-rf"],
  ["Remove-Item -Recurse -Force C:\\data", "no-win-recursive-delete"],
  ["rd /s /q C:\\data", "no-win-recursive-delete"],
  ["git push --force origin main", "no-force-push"],
  ["git push -f", "no-force-push"],
  ["DELETE FROM users;", "no-delete-all"],
  ["git reset --hard HEAD~3", "no-hard-reset"],
  ["cat .env", "no-secret-read"],
  ["cephalo uninstall hermes", "no-cephalo-tamper"],
];

for (const [command, id] of blockedCommands) {
  test(`blocks command: ${command}`, () => {
    const r = ev({ command });
    assert.equal(r.decision, "block");
    assert.equal(r.rule?.id, id);
  });
}

test('blocks path read ".env"', () => {
  const r = ev({ path: ".env", access: "read" });
  assert.equal(r.decision, "block");
  assert.equal(r.rule?.id, "no-secret-file");
});

test("blocks path write to Claude settings.json", () => {
  const r = ev({ path: "C:\\Users\\zuri\\.claude\\settings.json", access: "write" });
  assert.equal(r.decision, "block");
  assert.equal(r.rule?.id, "protect-config");
});

const allowedCommands = [
  "SELECT * FROM users",
  "DELETE FROM users WHERE id = 5;",
  "rm file.txt",
  "git push --force-with-lease",
  "git push origin main",
  "npm test",
];

for (const command of allowedCommands) {
  test(`allows command: ${command}`, () => {
    assert.equal(ev({ command }).decision, "allow");
  });
}

test('allows path read ".env.example"', () => {
  assert.equal(ev({ path: ".env.example", access: "read" }).decision, "allow");
});

test('allows path write "src/index.ts"', () => {
  assert.equal(ev({ path: "src/index.ts", access: "write" }).decision, "allow");
});

test("protect-config only applies to writes (reading Claude settings is fine)", () => {
  assert.equal(ev({ path: "C:\\Users\\zuri\\.claude\\settings.json", access: "read" }).decision, "allow");
});

test("loadRules creates a missing rules file from defaults and round-trips", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-test-"));
  try {
    const file = path.join(dir, "nested", "rules.yml");
    const rules = loadRules(file);
    assert.ok(fs.existsSync(file));
    assert.equal(rules.length, DEFAULT_RULES.length);
    assert.equal(evaluate({ command: "DROP TABLE x" }, rules).decision, "block");
    assert.equal(evaluate({ path: ".env.local", access: "read" }, rules).decision, "block");
    assert.equal(evaluate({ command: "npm test" }, rules).decision, "allow");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
