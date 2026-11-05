import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defFromRaw, identityOf, normalizeCommandLine, normalizeCommandString, normalizeExecutable, normalizeUrl } from "../mcp/identity.js";
import { addAllowEntry, loadMcpPolicy, matchAllow, parseMcpPolicy, setMcpMode } from "../mcp/policy.js";
import { candidatesFor, listAllServers, listClaudeServers, listHermesServers, parseMcpToolName, type ConfiguredServer } from "../mcp/servers.js";
import { checkMcpCall } from "../mcp/check.js";
import { runHook } from "../hooks.js";
import { evaluate } from "../engine.js";
import { getPlatform } from "../platform.js";
import { DEFAULT_RULES, activePlatformRules } from "../rules.js";
import { applyAllow, applyMode, listMcp, planAllow, planMode } from "../mcpcmd.js";
import { redactParams } from "../redact.js";
import { formatAudit, readAudit } from "../audit.js";
import { CLAUDE_MATCHER, HERMES_MATCHER } from "../install.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-mcp-"));
const rm = (d: string) => fs.rmSync(d, { recursive: true, force: true });
const policy = (text: string) => parseMcpPolicy(text).policy;

function fixture() {
  const dir = tmp();
  const home = path.join(dir, "home");
  const proj = path.join(dir, "proj");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "ghp_secretsecretsecretsecret" } },
        remote: { type: "http", url: "https://API.Example.com:443/mcp/?key=abc" },
      },
      projects: { [proj.replace(/\\/g, "/")]: { mcpServers: { github: { command: "node", args: ["evil.js"] } } } },
    }),
  );
  fs.writeFileSync(path.join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { files: { command: "C:\\Program Files\\nodejs\\NPX.CMD", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"] } } }));
  const hermes = path.join(dir, "hermes.yaml");
  fs.writeFileSync(hermes, "mcp_servers:\n  my-api:\n    url: https://hermes.example.com/mcp\n  off:\n    command: foo\n    enabled: false\n  time:\n    command: uvx\n    args: [mcp-server-time]\n");
  return { dir, home, proj, hermes, cwd: path.join(proj, "sub") };
}

test("identity: executable, cmd /c unwrap, URL normalization", () => {
  assert.equal(normalizeExecutable("C:\\Program Files\\nodejs\\NPX.CMD"), "npx");
  assert.equal(normalizeExecutable("/usr/local/bin/Node"), "node");
  assert.equal(normalizeCommandLine("npx", ["-y", "pkg"]), "npx -y pkg");
  assert.equal(normalizeCommandLine("cmd", ["/c", "npx", "-y", "pkg"]), "npx -y pkg");
  assert.equal(normalizeCommandLine("CMD.exe", ["/C", "npx -y pkg"]), "npx -y pkg");
  assert.equal(normalizeCommandLine("node", ["my script.js"]), 'node "my script.js"');
  assert.equal(normalizeCommandString("/opt/bin/uvx   mcp-server-time"), "uvx mcp-server-time");
  assert.equal(normalizeUrl("HTTPS://API.Example.com:443/mcp/?key=abc#x"), "https://api.example.com/mcp");
  assert.equal(normalizeUrl("https://user:pw@host.dev:8443/a/"), "https://host.dev:8443/a");
  assert.equal(identityOf({ kind: "http", url: "https://X.dev/m/" }), "url:https://x.dev/m");
  assert.equal(defFromRaw({ command: "x", args: [1, 2] })?.args?.join(), "1,2");
  assert.equal(defFromRaw({}), null);
});

test("policy file: bad entries are rejected, never widened", () => {
  const r = parseMcpPolicy(
    [
      "mode: enforce",
      "allow:",
      "  - name: github",
      "  - command: '*'",
      "  - url: '**'",
      "  - command: npx -y pkg",
      "    url: https://x.dev",
      "  - {}",
      "  - command: uvx mcp-server-time",
      "    label: time",
    ].join("\n"),
  );
  assert.equal(r.policy.mode, "enforce");
  assert.equal(r.policy.allow.length, 1);
  assert.equal(r.policy.allow[0].command, "uvx mcp-server-time");
  assert.equal(r.problems.length, 5);
  assert.match(r.problems[0], /matching by name is not supported/);
  assert.match(r.problems.join("\n"), /every server/);
  assert.equal(parseMcpPolicy("mode: nonsense").policy.mode, "audit");
  assert.equal(parseMcpPolicy(": : :\n- [").problems.length, 1);
});

test("matching is by command/URL: the name or label never matters", () => {
  const p = policy(
    ["mode: enforce", "allow:", '  - command: "npx -y @modelcontextprotocol/server-github"', "    label: totally-different-name", '  - url: "https://api.example.com/*"', '  - command: "node /srv/tools/*"'].join("\n"),
  );
  assert.ok(matchAllow(p, { kind: "stdio", command: "C:\\x\\NPX.cmd", args: ["-y", "@modelcontextprotocol/server-github"] }));
  assert.ok(matchAllow(p, { kind: "stdio", command: "cmd", args: ["/c", "npx", "-y", "@modelcontextprotocol/server-github"] }));
  assert.equal(matchAllow(p, { kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github", "--extra"] }), undefined, "extra args are a different command");
  assert.equal(matchAllow(p, { kind: "stdio", command: "node", args: ["evil.js"] }), undefined);
  assert.ok(matchAllow(p, { kind: "stdio", command: "node", args: ["/srv/tools/a.js", "--x"] }));
  assert.ok(matchAllow(p, { kind: "http", url: "https://API.example.com:443/v1/mcp?token=1" }));
  assert.equal(matchAllow(p, { kind: "http", url: "https://api.example.com.evil.dev/mcp" }), undefined);
  assert.equal(matchAllow(p, { kind: "http", url: "http://api.example.com/mcp" }), undefined, "scheme matters");
});

test("tool names: double and single underscore forms, plugin servers", () => {
  assert.deepEqual(parseMcpToolName("mcp__github__create_issue"), { server: "github", tool: "create_issue", plugin: false });
  assert.deepEqual(parseMcpToolName("mcp__my_api__a__b"), { server: "my_api", tool: "a__b", plugin: false });
  assert.equal(parseMcpToolName("mcp__plugin_db_x__query")?.plugin, true);
  assert.deepEqual(parseMcpToolName("mcp_my_api_query_data", ["my-api", "other"]), { server: "my_api", tool: "query_data", plugin: false });
  assert.equal(parseMcpToolName("Bash"), null);
  assert.equal(parseMcpToolName("mcp__"), null);
});

test("server discovery: Claude local > project > user, Hermes disabled skipped", () => {
  const f = fixture();
  try {
    const cl = listClaudeServers({ home: f.home, cwd: f.cwd });
    assert.deepEqual(cl.map((s) => `${s.source}:${s.name}`), ["claude-local:github", "claude-project:files", "claude-user:github", "claude-user:remote"]);
    const hm = listHermesServers({ hermesFile: f.hermes });
    assert.deepEqual(hm.map((s) => s.name), ["my-api", "time"]);
    assert.equal(listAllServers({ home: f.home, cwd: f.cwd, hermesFile: f.hermes }).length, 6);
    const github = candidatesFor({ server: "github", tool: "x", plugin: false }, cl);
    assert.equal(github.length, 1, "only the highest-precedence definition is live");
    assert.equal(github[0].identity, "cmd:node evil.js");
    assert.equal(cl.find((s) => s.name === "files")!.identity, 'cmd:npx -y @modelcontextprotocol/server-filesystem /data');
    assert.equal(cl.find((s) => s.name === "remote")!.identity, "url:https://api.example.com/mcp");
    assert.deepEqual(listClaudeServers({ home: path.join(f.dir, "nope"), cwd: f.dir }), []);
  } finally {
    rm(f.dir);
  }
});

test("checkMcpCall: audit logs, enforce blocks by identity, a renamed or swapped server does not slip through", () => {
  const f = fixture();
  try {
    const base = { home: f.home, cwd: f.cwd, hermesFile: f.hermes };
    // Allowlist approves the REAL github server command, but the local-scope definition swapped it for evil.js
    const pol = policy(['mode: enforce', 'allow:', '  - command: "npx -y @modelcontextprotocol/server-github"', '  - url: "https://api.example.com/mcp"'].join("\n"));
    const swapped = checkMcpCall("claude", "mcp__github__create_issue", { ...base, policy: pol })!;
    assert.equal(swapped.decision, "block");
    assert.equal(swapped.rule?.id, "mcp-not-allowed");
    assert.match(swapped.rule!.description, /cmd:node evil\.js/);

    // Without the local override the same name resolves to the approved command and passes
    const clean = checkMcpCall("claude", "mcp__github__create_issue", { ...base, cwd: f.dir, policy: pol })!;
    assert.equal(clean.decision, "allow");
    assert.equal(clean.verified, true);
    assert.equal(clean.identity, "cmd:npx -y @modelcontextprotocol/server-github");

    // url server allowed regardless of query/port
    assert.equal(checkMcpCall("claude", "mcp__remote__search", { ...base, policy: pol })!.decision, "allow");
    // Hermes: sanitized names resolve to the hyphenated server; not on the list -> blocked
    const h = checkMcpCall("hermes", "mcp__my_api__query", { ...base, policy: pol })!;
    assert.equal(h.decision, "block");
    assert.match(h.rule!.description, /hermes\.example\.com/);
    // single underscore Hermes form
    assert.equal(checkMcpCall("hermes", "mcp_my_api_query", { ...base, policy: pol })!.decision, "block");
    // unknown + plugin servers cannot be verified
    assert.equal(checkMcpCall("claude", "mcp__ghost__x", { ...base, policy: pol })!.rule?.id, "mcp-unverifiable");
    assert.equal(checkMcpCall("claude", "mcp__plugin_p_db__q", { ...base, policy: pol })!.rule?.id, "mcp-unverifiable");

    // audit mode: nothing is blocked but unverified calls are noted
    const aud = checkMcpCall("claude", "mcp__github__create_issue", { ...base, policy: policy("mode: audit") })!;
    assert.equal(aud.decision, "allow");
    assert.equal(aud.verified, false);
    assert.match(aud.note!, /audit mode/);
    assert.equal(checkMcpCall("claude", "Bash", { ...base, policy: pol }), null);
  } finally {
    rm(f.dir);
  }
});

test("runHook: MCP calls are blocked with the agent's JSON, and logged with params, user and time", () => {
  const f = fixture();
  const audit = path.join(f.dir, "audit.jsonl");
  try {
    const pol = policy("mode: enforce\nallow:\n  - command: 'uvx mcp-server-time'\n");
    const mcp = { policy: pol, home: f.home, hermesFile: f.hermes };
    const payload = (tool: string, input: unknown) => JSON.stringify({ tool_name: tool, tool_input: input, cwd: f.cwd });

    const out = runHook("claude", payload("mcp__github__create_issue", { title: "hi", api_key: "supersecret", body: "x".repeat(1500) }), { mcp, auditFile: audit, rules: [] });
    const j = JSON.parse(out);
    assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
    assert.match(j.hookSpecificOutput.permissionDecisionReason, /mcp-not-allowed/);

    const hout = JSON.parse(runHook("hermes", payload("mcp__my_api__query", { q: "select" }), { mcp, auditFile: audit, rules: [] }));
    assert.equal(hout.action, "block");

    const ok = runHook("hermes", payload("mcp__time__now", { tz: "UTC" }), { mcp, auditFile: audit, rules: [] });
    assert.equal(ok, "{}");

    const entries = readAudit({ limit: 0 }, audit);
    assert.equal(entries.length, 3);
    const e = entries[0];
    assert.equal(e.decision, "block");
    assert.equal(e.rule, "mcp-not-allowed");
    assert.equal(e.server, "github");
    assert.equal(e.serverId, "cmd:node evil.js");
    assert.equal(e.user, os.userInfo().username);
    assert.ok(!Number.isNaN(Date.parse(e.ts)));
    const params = e.params as Record<string, string>;
    assert.equal(params.api_key, "[redacted]");
    assert.equal(params.title, "hi");
    assert.ok(params.body.includes("…(+500 chars)"));
    assert.equal(entries[2].decision, "allow");
    assert.equal(entries[2].serverId, "cmd:uvx mcp-server-time");
    assert.match(formatAudit(e), /claude\/mcp__github__create_issue \[mcp-not-allowed\]  \{"title":"hi"/);
    assert.match(formatAudit(e), new RegExp(`\\(${os.userInfo().username.replace(/[\\.$]/g, "\\$&")}\\)`));
    // built-in tools also carry the user
    runHook("claude", JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), { auditFile: audit, rules: [] });
    assert.equal(readAudit({ limit: 1 }, audit)[0].user, os.userInfo().username);
  } finally {
    rm(f.dir);
  }
});

test("redaction: secret keys, token-shaped values, size limits", () => {
  const r = redactParams({
    password: "hunter2",
    nested: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz", note: "ok", list: ["sk-abcdefghijklmnopqrstuv", "fine"] },
    token: "",
    big: Array.from({ length: 60 }, (_, i) => i),
    gh: "ghp_abcdefghijklmnopqrstuvwxyz0123",
    n: 5,
    z: null,
  }) as any;
  assert.equal(r.password, "[redacted]");
  assert.equal(r.nested.Authorization, "[redacted]");
  assert.equal(r.nested.note, "ok");
  assert.deepEqual(r.nested.list, ["[redacted]", "fine"]);
  assert.equal(r.token, "", "empty secret field is left as is");
  assert.equal(r.big.length, 51);
  assert.equal(r.gh, "[redacted]");
  assert.equal(r.n, 5);
  assert.equal(r.z, null);
});

test("agents cannot approve their own MCP servers or edit the allowlist", () => {
  for (const id of ["win32", "darwin", "linux"]) {
    const p = getPlatform(id);
    const rules = [...DEFAULT_RULES, ...activePlatformRules(DEFAULT_RULES, p)];
    const w = (x: string) => evaluate({ path: x, access: "write" }, rules, p);
    assert.equal(w("/home/a/.cephalo/mcp.yml").rule?.id, "protect-cephalo-policy", id);
    assert.equal(w("C:\\Users\\a\\.cephalo\\mcp-tools.json").rule?.id, "protect-cephalo-policy", id);
    assert.equal(evaluate({ path: "/home/a/.cephalo/mcp.yml", access: "read" }, rules, p).decision, "allow", "reading is fine");
    // the rules file and the audit log are the user's: an agent that could edit them could lift its own limits or erase its trail
    assert.equal(w("/home/a/.cephalo/rules.yml").rule?.id, "protect-audit-log");
    assert.equal(w("/home/a/.cephalo/audit.jsonl").rule?.id, "protect-audit-log");
    assert.equal(evaluate({ path: "/home/a/.cephalo/rules.yml", access: "read" }, rules, p).decision, "allow", "reading them is fine");
    for (const c of ["cephalo mcp allow github --yes", "cephalo.cmd mcp mode audit", "node C:/x/cephalo/dist/cli.js mcp allow --url https://x.dev"]) {
      assert.equal(evaluate({ command: c }, rules, p).rule?.id, "no-self-approve", `${id}: ${c}`);
    }
    for (const c of ["cephalo mcp list", "cephalo mcp path", "cephalo doctor"]) assert.equal(evaluate({ command: c }, rules, p).decision, "allow", c);
  }
});

test("cephalo mcp: list, allow (plan + apply + idempotent + backup), mode", () => {
  const f = fixture();
  const file = path.join(f.dir, "mcp.yml");
  const o = { home: f.home, cwd: f.cwd, hermesFile: f.hermes, policyFile: file };
  try {
    let out = listMcp(o).lines.join("\n");
    assert.match(out, /Mode: audit/);
    assert.match(out, /github\s+claude\/local\s+not listed\s+cmd:node evil\.js/);
    assert.match(out, /6 configured server\(s\) are not on the allowlist|[0-9]+ configured server\(s\) are not on the allowlist/);

    assert.equal(planAllow({}, o).ok, false);
    assert.equal(planAllow({ name: "nope" }, o).ok, false);
    const p1 = planAllow({ name: "time" }, o);
    assert.ok(p1.ok);
    assert.deepEqual(p1.entry, { command: "uvx mcp-server-time", label: "time" });
    assert.match(p1.lines.join("\n"), /name "time" is only recorded as a label/);
    assert.equal(fs.existsSync(file), false, "planning changes nothing");

    assert.match(applyAllow(p1, o).join("\n"), /Added to/);
    assert.match(applyAllow(p1, o).join("\n"), /Already on the allowlist/);
    assert.equal(loadMcpPolicy(file).allow.length, 1);
    const url = planAllow({ url: "https://API.example.com/mcp/" }, o);
    const second = applyAllow(url, o).join("\n");
    assert.match(second, /Backup: /);
    assert.equal(loadMcpPolicy(file).allow.length, 2);
    assert.ok(fs.readdirSync(f.dir).some((n) => n.startsWith("mcp.yml.cephalo-backup-")));

    out = listMcp(o).lines.join("\n");
    assert.match(out, /time\s+hermes\s+allowed\s+cmd:uvx mcp-server-time/);
    assert.match(out, /remote\s+claude\/user\s+allowed/);

    // a name defined twice with different commands needs disambiguation
    const amb = planAllow({ name: "github" }, { ...o, cwd: f.dir });
    assert.ok(amb.ok, "only one definition visible outside the project");
    const dup = tmp();
    try {
      fs.writeFileSync(path.join(dup, "h.yaml"), "mcp_servers:\n  github:\n    command: other\n");
      const both = planAllow({ name: "github" }, { home: f.home, cwd: f.dir, hermesFile: path.join(dup, "h.yaml") });
      assert.equal(both.ok, false);
      assert.match(both.lines.join("\n"), /defined more than once/);
      assert.ok(planAllow({ name: "github", source: "hermes" }, { home: f.home, cwd: f.dir, hermesFile: path.join(dup, "h.yaml") }).ok);
    } finally {
      rm(dup);
    }

    const m = planMode("enforce", o);
    assert.ok(m.ok);
    assert.match(m.lines.join("\n"), /NOT on the allowlist/);
    assert.equal(planMode("loud", o).ok, false);
    assert.match(applyMode("enforce", o).join("\n"), /now enforce/);
    assert.match(applyMode("enforce", o).join("\n"), /Already in enforce/);
    assert.equal(loadMcpPolicy(file).mode, "enforce");
    assert.match(fs.readFileSync(file, "utf8"), /^# Cephalo MCP allowlist/);
    assert.equal(setMcpMode("audit", file).changed, true);
  } finally {
    rm(f.dir);
  }
});

test("an invalid mcp.yml is never overwritten", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "mcp.yml");
    fs.writeFileSync(file, "mode: [unclosed\n");
    assert.throws(() => addAllowEntry({ command: "x y" }, file), /not valid YAML/);
    assert.equal(fs.readFileSync(file, "utf8"), "mode: [unclosed\n");
  } finally {
    rm(dir);
  }
});

test("installer matchers route MCP tools to Cephalo", () => {
  assert.match(CLAUDE_MATCHER, /\|mcp__\.\*$/);
  assert.match(HERMES_MATCHER, /\|mcp_\.\*$/);
  assert.ok(new RegExp(`^(${CLAUDE_MATCHER})$`).test("mcp__github__create_issue"));
  assert.ok(new RegExp(`^(${HERMES_MATCHER})$`).test("mcp__github__create_issue"));
  assert.ok(new RegExp(`^(${HERMES_MATCHER})$`).test("mcp_github_create_issue"));
  assert.ok(new RegExp(`^(${CLAUDE_MATCHER})$`).test("Glob"), "Glob is guarded since 0.2.0 (it could list .env files)");
  assert.ok(!new RegExp(`^(${CLAUDE_MATCHER})$`).test("TodoWrite"));
});

// keep the unused-import checker honest
void ({} as ConfiguredServer);
