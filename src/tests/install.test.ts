import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installClaude, uninstallClaude, installHermes, uninstallHermes, CLAUDE_MATCHER, HERMES_MATCHER } from "../install.js";

const ABS = "C:/Users/zuri/cephalo";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-inst-"));
const backups = (dir: string, base: string) => fs.readdirSync(dir).filter((f) => f.startsWith(base + ".cephalo-backup-"));

test("claude: install creates missing file, no duplicate on second run", () => {
  const dir = tmp();
  const f = path.join(dir, ".claude", "settings.json");
  installClaude(f, ABS);
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(s.hooks.PreToolUse, [
    { matcher: CLAUDE_MATCHER, hooks: [{ type: "command", command: "node C:/Users/zuri/cephalo/dist/cli.js hook claude" }] },
  ]);
  const again = installClaude(f, ABS);
  assert.match(again[0]!, /Already installed/);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).hooks.PreToolUse.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("claude: install preserves existing settings and backs up; uninstall removes only Cephalo", () => {
  const dir = tmp();
  const f = path.join(dir, "settings.json");
  const original = {
    model: "opus",
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool check" }] }], PostToolUse: [{ matcher: "*", hooks: [] }] },
  };
  fs.writeFileSync(f, JSON.stringify(original));
  const out = installClaude(f, ABS);
  assert.match(out[0]!, /^Backup: /);
  const bk = backups(dir, "settings.json");
  assert.equal(bk.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, bk[0]!), "utf8")), original);
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(s.model, "opus");
  assert.equal(s.hooks.PreToolUse.length, 2);

  uninstallClaude(f);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), original);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("claude/hermes: install upgrades an old narrower matcher in place", () => {
  const dir = tmp();
  const c = path.join(dir, "settings.json");
  fs.writeFileSync(c, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash|Read|Write|Edit", hooks: [{ type: "command", command: `node ${ABS}/dist/cli.js hook claude` }] }] } }));
  assert.match(installClaude(c, ABS).join("\n"), /Updated Cephalo matcher/);
  const s = JSON.parse(fs.readFileSync(c, "utf8"));
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.PreToolUse[0].matcher, CLAUDE_MATCHER);

  const h = path.join(dir, "config.yaml");
  fs.writeFileSync(h, `hooks:\n  pre_tool_call:\n    - matcher: "terminal|read_file|write_file|patch"\n      command: "node ${ABS}/dist/cli.js hook hermes"\n      timeout: 10\n`);
  assert.match(installHermes(h, ABS).join("\n"), /Updated Cephalo matcher/);
  const t = fs.readFileSync(h, "utf8");
  assert.ok(t.includes(`matcher: "${HERMES_MATCHER}"`));
  assert.equal((t.match(/hook hermes/g) ?? []).length, 2, "one entry per section (before-call and after-call), never duplicated");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("claude: invalid JSON is refused and left untouched", () => {
  const dir = tmp();
  const f = path.join(dir, "settings.json");
  fs.writeFileSync(f, "{ not json");
  assert.throws(() => installClaude(f, ABS), /not valid JSON/);
  assert.equal(fs.readFileSync(f, "utf8"), "{ not json");
  assert.equal(backups(dir, "settings.json").length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

const HERMES_SRC = `# my hermes config
model: sonnet # keep this comment
hooks:
  # existing hooks
  pre_tool_call:
    - matcher: "browser"
      command: "echo hi"
      timeout: 5
other: true
`;

test("hermes: install preserves comments, adds entry once, uninstall restores", () => {
  const dir = tmp();
  const f = path.join(dir, "config.yaml");
  fs.writeFileSync(f, HERMES_SRC);
  const out = installHermes(f, ABS);
  assert.match(out[0]!, /^Backup: /);
  const text = fs.readFileSync(f, "utf8");
  assert.match(text, /# my hermes config/);
  assert.match(text, /# keep this comment/);
  assert.match(text, /# existing hooks/);
  assert.ok(text.includes(`matcher: "${HERMES_MATCHER}"`));
  assert.match(text, /command: "node C:\/Users\/zuri\/cephalo\/dist\/cli\.js hook hermes"/);
  assert.match(text, /timeout: 10/);
  assert.equal(backups(dir, "config.yaml").length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups(dir, "config.yaml")[0]!), "utf8"), HERMES_SRC);

  assert.match(installHermes(f, ABS)[0]!, /Already installed/);
  assert.equal((fs.readFileSync(f, "utf8").match(/hook hermes/g) ?? []).length, 2, "re-install adds nothing");

  uninstallHermes(f);
  assert.equal(fs.readFileSync(f, "utf8"), HERMES_SRC);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hermes: works when hooks key is absent or empty; uninstall cleans up", () => {
  for (const src of ["model: x\n", "hooks:\nmodel: x\n", "hooks: {}\nmodel: x\n", "hooks:\n  pre_tool_call: []\n"]) {
    const dir = tmp();
    const f = path.join(dir, "config.yaml");
    fs.writeFileSync(f, src);
    installHermes(f, ABS);
    assert.equal((fs.readFileSync(f, "utf8").match(/hook hermes/g) ?? []).length, 2, src);
    uninstallHermes(f);
    assert.doesNotMatch(fs.readFileSync(f, "utf8"), /cephalo/, src);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hermes: missing config is not created", () => {
  const dir = tmp();
  assert.throws(() => installHermes(path.join(dir, "config.yaml"), ABS), /does not exist/);
  assert.equal(fs.readdirSync(dir).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
