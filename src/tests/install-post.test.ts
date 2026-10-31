import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_MATCHER, CLAUDE_POST_MATCHER, HERMES_MATCHER, HERMES_POST_MATCHER, installClaude, installHermes, uninstallClaude, uninstallHermes } from "../install.js";
import { claudeStatus, hermesStatus } from "../status.js";
import { runDoctor } from "../doctor.js";

const ABS = "C:/Users/zuri/cephalo";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-post-"));

test("claude: install adds the before-call AND after-call hooks, keeps the user's own hooks, and uninstall puts everything back", () => {
  const dir = tmp();
  try {
    const f = path.join(dir, "settings.json");
    const original = {
      model: "sonnet",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine-pre" }] }],
        PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo mine-post" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
      },
    };
    fs.writeFileSync(f, JSON.stringify(original, null, 2) + "\n");
    const out = installClaude(f, ABS).join("\n");
    assert.match(out, /Added to hooks\.PreToolUse/);
    assert.match(out, /Added to hooks\.PostToolUse/);
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.equal(s.hooks.PreToolUse.length, 2);
    assert.equal(s.hooks.PostToolUse.length, 2);
    assert.equal(s.hooks.PostToolUse[1].matcher, CLAUDE_POST_MATCHER);
    assert.equal(s.hooks.PreToolUse[1].matcher, CLAUDE_MATCHER);
    assert.equal(s.hooks.PostToolUse[1].hooks[0].command, `node ${ABS}/dist/cli.js hook claude`);
    assert.deepEqual(s.hooks.Stop, original.hooks.Stop);
    assert.match(installClaude(f, ABS)[0], /Already installed/);
    assert.equal(claudeStatus(f, ABS).current, true);

    const un = uninstallClaude(f).join("\n");
    assert.match(un, /Removed from hooks\.PreToolUse/);
    assert.match(un, /Removed from hooks\.PostToolUse/);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), original, "the user's config is exactly as before");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("claude: an install made before the tripwire existed is reported outdated and upgraded in place", () => {
  const dir = tmp();
  try {
    const f = path.join(dir, "settings.json");
    fs.writeFileSync(f, JSON.stringify({ hooks: { PreToolUse: [{ matcher: CLAUDE_MATCHER, hooks: [{ type: "command", command: `node ${ABS}/dist/cli.js hook claude` }] }] } }));
    const before = claudeStatus(f, ABS);
    assert.equal(before.installed, true);
    assert.equal(before.current, false);
    assert.equal(before.postCurrent, false);
    const out = installClaude(f, ABS).join("\n");
    assert.match(out, /Backup: /);
    assert.doesNotMatch(out, /PreToolUse/, "the existing before-call entry is left alone");
    assert.match(out, /Added to hooks\.PostToolUse/);
    assert.equal(claudeStatus(f, ABS).current, true);

    const doc = runDoctor({ claudeFile: f, hermesFile: path.join(dir, "none.yaml"), rulesFile: path.join(dir, "r.yml"), auditFile: path.join(dir, "a.jsonl"), abs: ABS, hermesList: () => null, mcp: { home: dir, cwd: dir, hermesFile: path.join(dir, "n.yaml"), policyFile: path.join(dir, "mcp.yml"), approvalsFile: path.join(dir, "ap.json") } });
    assert.equal(doc.checks.find((c) => c.name === "Claude Code hook")?.level, "ok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hermes: before-call and after-call hooks, user's entries kept, uninstall restores the file byte for byte", () => {
  const dir = tmp();
  try {
    const f = path.join(dir, "config.yaml");
    const src = `# mine\nmodel: x\nhooks:\n  # keep\n  post_tool_call:\n    - matcher: "terminal"\n      command: "echo mine"\n      timeout: 5\n  pre_tool_call:\n    - matcher: "browser"\n      command: "echo hi"\n`;
    fs.writeFileSync(f, src);
    const out = installHermes(f, ABS).join("\n");
    assert.match(out, /Added to hooks\.pre_tool_call/);
    assert.match(out, /Added to hooks\.post_tool_call: matcher "terminal\|read_file\|search_files/);
    const text = fs.readFileSync(f, "utf8");
    assert.match(text, /# keep/);
    assert.ok(text.includes(`matcher: "${HERMES_POST_MATCHER}"`));
    assert.ok(text.includes(`matcher: "${HERMES_MATCHER}"`));
    assert.equal((text.match(/hook hermes/g) ?? []).length, 2);
    assert.equal(hermesStatus(f, ABS).current, true);
    assert.match(installHermes(f, ABS)[0], /Already installed/);
    uninstallHermes(f);
    assert.equal(fs.readFileSync(f, "utf8"), src);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hermes: a pre-tripwire install is reported outdated and gets only the missing after-call entry", () => {
  const dir = tmp();
  try {
    const f = path.join(dir, "config.yaml");
    fs.writeFileSync(f, `hooks:\n  pre_tool_call:\n    - matcher: "${HERMES_MATCHER}"\n      command: "node ${ABS}/dist/cli.js hook hermes"\n      timeout: 10\n`);
    const st = hermesStatus(f, ABS);
    assert.equal(st.installed, true);
    assert.equal(st.current, false);
    const out = installHermes(f, ABS).join("\n");
    assert.doesNotMatch(out, /pre_tool_call/);
    assert.match(out, /Added to hooks\.post_tool_call/);
    assert.equal(hermesStatus(f, ABS).current, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
