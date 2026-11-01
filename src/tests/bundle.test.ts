import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildBundle } from "../replay/bundle.js";
import { buildReplay } from "../replay/collect.js";
import { renderHtml } from "../replay/html.js";
import { parseReplayArgs, render } from "../replaycmd.js";
import type { AuditEntry } from "../audit.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-bundle-"));
const entry = (o: Partial<AuditEntry>): AuditEntry => ({ ts: "2026-10-30T10:00:00.000Z", agent: "claude", tool: "Bash", command: "ls", decision: "allow", session: "sess-1", cwd: "C:/work/app", ...o });

function setup() {
  const d = tmp();
  const proj = path.join(d, "projects", "p");
  fs.mkdirSync(proj, { recursive: true });
  const usage = (id: string, model: string) => JSON.stringify({ sessionId: "sess-1", cwd: "C:/work/app", gitBranch: "feat/a", timestamp: "2026-10-30T10:00:00Z", message: { id, model, usage: { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  fs.writeFileSync(path.join(proj, "sess-1.jsonl"), usage("m1", "claude-opus-5-5") + "\n");
  fs.writeFileSync(path.join(proj, "other.jsonl"), JSON.stringify({ sessionId: "other", cwd: "C:/work/app", timestamp: "2026-10-30T10:00:00Z", message: { id: "x", model: "claude-opus-5-5", usage: { input_tokens: 9_000_000, output_tokens: 0 } } }) + "\n");
  const replay = buildReplay([entry({}), entry({ ts: "2026-10-30T10:05:00.000Z", command: "DROP TABLE x", decision: "block", rule: "sql-drop" })], { cwd: "C:/work/app", allProjects: true, since: new Date("2026-10-30T09:00:00Z"), git: () => ({ status: 1, stdout: "" }) });
  return { d, replay, env: { now: new Date("2026-10-31T00:00:00Z"), claudeDir: path.join(d, "projects"), hermesDb: path.join(d, "none.db"), pricesFile: path.join(d, "p.yml"), cwd: "C:/work/app" } };
}

test("bundle: costs only the sessions in the replay, and records the outcome and when it was checked", async () => {
  const { replay, env } = setup();
  replay.meta.repo = { root: "C:/work/app", branch: "feat/a" };
  const b = await buildBundle(replay, { ...env, lookup: () => [{ number: 12, url: "https://example.test/pr/12", state: "MERGED", ci: "pass" }] });
  assert.equal(b.cost.sessions.length, 1);
  assert.equal(b.cost.sessions[0]!.id, "sess-1");
  assert.ok(Math.abs(b.cost.totalUsd! - 4) < 1e-9, "the other session's 9M tokens are not counted");
  assert.equal(b.outcome.status, "shipped");
  assert.equal(b.outcome.pr!.number, 12);
  assert.equal(b.checkedAt, "2026-10-31T00:00:00.000Z");
  assert.match(b.cost.note, /estimate/);
});

test("bundle: no branch, no GitHub, or no usage are said plainly, never guessed", async () => {
  const { replay, env } = setup();
  assert.equal((await buildBundle(replay, { ...env, lookup: () => null })).outcome.status, "no-branch");
  replay.meta.repo = { root: "C:/work/app", branch: "feat/a" };
  assert.equal((await buildBundle(replay, { ...env, lookup: () => null })).outcome.status, "unknown");
  assert.equal((await buildBundle(replay, { ...env, noGithub: true })).outcome.status, "not-checked");
  const none = await buildBundle(replay, { ...env, claudeDir: path.join(env.claudeDir, "missing"), lookup: () => [] });
  assert.equal(none.cost.totalUsd, null);
  assert.match(none.cost.note, /No token usage/);
  assert.equal(none.outcome.status, "no-pr");
});

test("bundle html: one file with the replay and the bundle, no network, hostile text stays inert; plain html is unchanged", async () => {
  const { replay, env } = setup();
  replay.meta.repo = { root: "C:/work/app", branch: "</script><b>x" };
  const b = await buildBundle(replay, { ...env, noGithub: true });
  const html = renderHtml(replay, b);
  assert.match(html, /id="b"/);
  assert.match(html, /id="bundle"/);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 4, "data x2 + script x2, nothing injected");
  assert.match(html, /default-src 'none'/);
  const plain = renderHtml(replay);
  assert.ok(!plain.includes('id="bundle"') && !plain.includes('id="b"'));
});

test("replay --format bundle is accepted; the bundle goes through render()", async () => {
  const p = parseReplayArgs(["--format", "bundle", "--no-github"]);
  assert.ok("args" in p && p.args.format === "bundle");
  assert.ok(!("args" in parseReplayArgs(["--format", "zip"])));
  const { replay, env } = setup();
  const b = await buildBundle(replay, { ...env, noGithub: true });
  assert.match(render(replay, (p as any).args, b), /id="bundle"/);
});
