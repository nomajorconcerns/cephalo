import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PRICES, costOf, loadPrices, priceFor } from "../cost/prices.js";
import { readClaudeTranscript } from "../cost/usage.js";
import { ciOf, classify, shipStatuses, type PrInfo } from "../cost/ship.js";
import { costReport, parseCostArgs } from "../costcmd.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-cost-"));
const line = (o: object) => JSON.stringify(o);
const msg = (id: string, model: string, out: number, extra: object = {}) =>
  line({ sessionId: "S1", cwd: "C:/work/app", gitBranch: "feat/x", timestamp: "2026-10-30T10:00:00Z", message: { id, model, usage: { input_tokens: 1000, output_tokens: out, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000 } }, ...extra });

test("prices: longest prefix wins, dated names match, unknown models have no price, overrides load", () => {
  assert.equal(priceFor("claude-opus-5-5", DEFAULT_PRICES)!.input, 4);
  assert.equal(priceFor("claude-opus-5", DEFAULT_PRICES)!.input, 5);
  assert.equal(priceFor("claude-opus-4-5-20251101", DEFAULT_PRICES)!.output, 25);
  assert.equal(priceFor("claude-future-9", DEFAULT_PRICES), null);
  const f = path.join(tmp(), "prices.yml");
  fs.writeFileSync(f, "claude-future-9:\n  input: 1\n  output: 2\nbad:\n  input: x\n");
  const { prices, notes } = loadPrices(f);
  assert.equal(priceFor("claude-future-9", prices)!.cacheRead, 0.1);
  assert.equal(notes.length, 1);
  assert.equal(loadPrices(path.join(tmp(), "none.yml")).notes.length, 0);
});

test("costOf: tokens times per-million prices", () => {
  const c = costOf({ input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 }, DEFAULT_PRICES["claude-opus-5-5"]!);
  assert.ok(Math.abs(c - (4 + 20 + 5 + 0.2)) < 1e-9);
});

test("transcript: a streamed message is counted once (last copy wins), synthetic and unpriced models are handled", () => {
  const f = path.join(tmp(), "S1.jsonl");
  fs.writeFileSync(f, [msg("m1", "claude-opus-5-5", 10), msg("m1", "claude-opus-5-5", 500), msg("m2", "claude-opus-5-5", 100), msg("m3", "<synthetic>", 999), "not json"].join("\n"));
  const s = readClaudeTranscript(f, DEFAULT_PRICES)!;
  assert.equal(s.id, "S1");
  assert.equal(s.branch, "feat/x");
  assert.equal(s.tokens.output, 600);
  assert.equal(s.tokens.input, 2000);
  assert.equal(s.partial, undefined);
  const g = path.join(tmp(), "S2.jsonl");
  fs.writeFileSync(g, [msg("a", "claude-opus-5-5", 100), msg("b", "claude-unknown-1", 100)].join("\n"));
  const p = readClaudeTranscript(g, DEFAULT_PRICES)!;
  assert.equal(p.partial, true);
  const h = path.join(tmp(), "S3.jsonl");
  fs.writeFileSync(h, msg("a", "claude-unknown-1", 100));
  const u = readClaudeTranscript(h, DEFAULT_PRICES)!;
  assert.deepEqual([u.usd, u.basis], [null, "unpriced"]);
  assert.equal(readClaudeTranscript(path.join(tmp(), "missing.jsonl"), DEFAULT_PRICES), null);
});

test("ci state from a check rollup", () => {
  assert.equal(ciOf([]), "none");
  assert.equal(ciOf([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }]), "pass");
  assert.equal(ciOf([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }]), "fail");
  assert.equal(ciOf([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }]), "pending");
});

test("classify: shipped needs a merged PR with passing CI", () => {
  const pr = (state: PrInfo["state"], ci: PrInfo["ci"], number = 1): PrInfo => ({ number, state, ci });
  assert.equal(classify(null).status, "unknown");
  assert.equal(classify([]).status, "no-pr");
  assert.equal(classify([pr("MERGED", "pass")]).status, "shipped");
  assert.equal(classify([pr("MERGED", "fail")]).status, "merged-ci-failed");
  assert.equal(classify([pr("MERGED", "none")]).status, "merged-no-ci");
  assert.equal(classify([pr("OPEN", "pass")]).status, "open");
  assert.equal(classify([pr("CLOSED", "pass")]).status, "closed");
  assert.equal(classify([pr("CLOSED", "pass", 1), pr("MERGED", "pass", 2)]).pr!.number, 2);
});

test("shipStatuses: default branches and missing branches are not looked up; each branch is looked up once", () => {
  let calls = 0;
  const mk = (id: string, branch?: string) => ({ agent: "claude" as const, id, cwd: "C:/w", ...(branch ? { branch } : {}), start: "", end: "", models: [], tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, usd: 1, basis: "list-price estimate" as const });
  const a = mk("a", "master"), b = mk("b"), c = mk("c", "feat/x"), d = mk("d", "feat/x");
  const m = shipStatuses([a, b, c, d], () => (calls++, [{ number: 7, state: "MERGED", ci: "pass" }]));
  assert.deepEqual([a, b, c, d].map((s) => m.get(s)!.status), ["no-branch", "no-branch", "shipped", "shipped"]);
  assert.equal(calls, 1);
});

test("parseCostArgs", () => {
  assert.deepEqual((parseCostArgs([]) as any).args, { since: "7d", json: false, allProjects: false, noGithub: false, rows: 10 });
  assert.match((parseCostArgs(["--since"]) as any).error, /needs a value/);
  assert.match((parseCostArgs(["--wat"]) as any).error, /Unknown/);
  assert.match((parseCostArgs(["--rows", "x"]) as any).error, /whole number/);
});

test("costReport end to end: cost per shipped result counts a PR once, however many sessions built it", async () => {
  const dir = tmp();
  const proj = path.join(dir, "projects", "p");
  fs.mkdirSync(proj, { recursive: true });
  const mkSession = (sid: string, branch: string, ts: string) =>
    fs.writeFileSync(path.join(proj, `${sid}.jsonl`), line({ sessionId: sid, cwd: "C:/work/app", gitBranch: branch, timestamp: ts, message: { id: sid, model: "claude-opus-5-5", usage: { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }));
  mkSession("s1", "feat/a", "2026-10-30T10:00:00Z");
  mkSession("s2", "feat/a", "2026-10-30T12:00:00Z");
  mkSession("s3", "feat/b", "2026-10-30T13:00:00Z");
  const r = await costReport(
    { since: "30d", json: false, allProjects: false, noGithub: false, rows: 5 },
    { cwd: "C:/work/app", now: new Date("2026-11-01T00:00:00Z"), claudeDir: path.join(dir, "projects"), hermesDb: path.join(dir, "none.db"), pricesFile: path.join(dir, "p.yml"), lookup: (_c, b) => (b === "feat/a" ? [{ number: 5, state: "MERGED", ci: "pass" }] : []) },
  );
  assert.equal(r.report.sessions, 3);
  assert.ok(Math.abs(r.report.totalUsd - 12) < 1e-9);
  assert.equal(r.report.shippedResults, 1);
  assert.ok(Math.abs(r.report.costPerShipped! - 12) < 1e-9);
  assert.ok(Math.abs(r.report.otherUsd - 4) < 1e-9);
  assert.match(r.lines.join("\n"), /Cost per shipped result: \$12\.00/);
  assert.match(r.lines.join("\n"), /estimate/);
  const other = await costReport({ since: "30d", json: false, allProjects: false, noGithub: true, rows: 0 }, { cwd: "C:/elsewhere", now: new Date("2026-11-01T00:00:00Z"), claudeDir: path.join(dir, "projects"), hermesDb: path.join(dir, "none.db") });
  assert.equal(other.report.sessions, 0);
  assert.equal(other.report.costPerShipped, null);
});
