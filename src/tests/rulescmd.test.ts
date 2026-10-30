import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listRules, resetRules, showRule } from "../rulescmd.js";
import { DEFAULT_RULES, ensureRulesFile } from "../rules.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-rules-"));
  return { dir, file: path.join(dir, "rules.yml") };
}
const reset = (file: string, over: Partial<Parameters<typeof resetRules>[0]> = {}) => {
  const lines: string[] = [];
  const p = resetRules({ file, yes: true, interactive: false, confirm: async () => true, log: (l) => lines.push(l), ...over });
  return p.then((code) => ({ code, out: lines.join("\n") }));
};

test("list: missing file is not an error and is not created", () => {
  const { dir, file } = tmpFile();
  const r = listRules(file);
  assert.equal(r.exitCode, 0);
  assert.match(r.lines.join("\n"), /No rules file/);
  assert.ok(!fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("list: defaults show origin default and no missing rules", () => {
  const { dir, file } = tmpFile();
  ensureRulesFile(file);
  const r = listRules(file);
  const text = r.lines.join("\n");
  assert.equal(r.exitCode, 0);
  assert.match(text, new RegExp(`${DEFAULT_RULES.length} rule\\(s\\). Missing defaults: none`));
  assert.ok(DEFAULT_RULES.every((d) => text.includes(d.id)));
  assert.doesNotMatch(text, /modified|custom/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("list/show: detects modified, custom and missing rules", () => {
  const { dir, file } = tmpFile();
  fs.writeFileSync(
    file,
    [
      "rules:",
      "  - id: no-drop",
      "    type: command",
      "    pattern: 'DROP DATABASE'",
      "    action: block",
      "  - id: mine",
      "    description: my rule",
      "    type: command",
      "    pattern: 'foo'",
      "    action: block",
      "",
    ].join("\n"),
  );
  const text = listRules(file).lines.join("\n");
  assert.match(text, /no-drop .*modified/);
  assert.match(text, /mine .*custom/);
  assert.match(text, /Missing defaults: no-truncate/);
  const shown = showRule("no-drop", file).lines.join("\n");
  assert.match(shown, /pattern:\s+DROP DATABASE/);
  assert.match(shown, /default:\s+\\bDROP/);
  assert.equal(showRule("nope", file).exitCode, 1);
  assert.equal(showRule(undefined, file).exitCode, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reset: creates when missing; no-op when already default", async () => {
  const { dir, file } = tmpFile();
  let r = await reset(file);
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(file));
  r = await reset(file);
  assert.match(r.out, /already matches/);
  assert.equal(fs.readdirSync(dir).length, 1, "no backup for a no-op");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reset: backs up a customised file and restores defaults", async () => {
  const { dir, file } = tmpFile();
  const custom = "rules:\n  - id: mine\n    type: command\n    pattern: foo\n    action: block\n";
  fs.writeFileSync(file, custom);
  const r = await reset(file);
  assert.equal(r.code, 0);
  assert.match(r.out, /mine \(custom\)/);
  const backups = fs.readdirSync(dir).filter((f) => f.includes(".cephalo-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]!), "utf8"), custom);
  assert.match(listRules(file).lines.join("\n"), /Missing defaults: none/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reset: needs --yes in a non-terminal; declining changes nothing", async () => {
  const { dir, file } = tmpFile();
  const custom = "rules:\n  - id: mine\n    type: command\n    pattern: foo\n    action: block\n";
  fs.writeFileSync(file, custom);
  let r = await reset(file, { yes: false, interactive: false });
  assert.equal(r.code, 1);
  assert.equal(fs.readFileSync(file, "utf8"), custom);
  r = await reset(file, { yes: false, interactive: true, confirm: async () => false });
  assert.equal(r.code, 0);
  assert.equal(fs.readFileSync(file, "utf8"), custom);
  assert.equal(fs.readdirSync(dir).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
