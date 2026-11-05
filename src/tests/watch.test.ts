import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatWatchLine, readNewEntries, runWatch, sanitize, type TailState } from "../watch.js";
import type { AuditEntry } from "../audit.js";

const entry = (o: Partial<AuditEntry> = {}): AuditEntry => ({ ts: "2026-10-30T12:34:56.000Z", agent: "hermes", tool: "terminal", decision: "allow", command: "ls", ...o });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-watch-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("formatWatchLine: colors ALLOW green and BLOCK red, plain when color is off", () => {
  const a = formatWatchLine(entry(), { color: true });
  const b = formatWatchLine(entry({ decision: "block", rule: "no-rm-rf", command: "rm -rf x" }), { color: true });
  assert.match(a, /\x1b\[92mALLOW\x1b\[0m/, "bright green in the default scheme at 16 colors");
  assert.match(b, /\x1b\[1;91mBLOCK\x1b\[0m/, "bold bright red");
  assert.match(b, /\[no-rm-rf\]/);
  const plain = formatWatchLine(entry({ decision: "block", rule: "r" }), { color: false });
  assert.ok(!plain.includes("\x1b"));
  assert.match(plain, /BLOCK {2}hermes\/terminal \[r\] {2}ls/);
});

test("formatWatchLine: strips control characters and truncates to width", () => {
  const evil = formatWatchLine(entry({ command: "echo \x1b[2J\x07hi\nnext" }), { color: false });
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(evil), "no control characters survive");
  assert.equal(sanitize("a\r\nb"), "a \u21b5 b");
  const long = formatWatchLine(entry({ command: "x".repeat(300) }), { color: false, width: 60 });
  assert.ok(long.length <= 60, `got ${long.length}`);
  assert.ok(long.endsWith("\u2026"));
});

test("readNewEntries: partial lines, truncation, missing file, corrupt lines", () => {
  const dir = tmp();
  try {
    const f = path.join(dir, "audit.jsonl");
    const st: TailState = { offset: 0, carry: "" };
    assert.deepEqual(readNewEntries(f, st), []);
    const l1 = JSON.stringify(entry({ command: "one" }));
    const l2 = JSON.stringify(entry({ command: "two" }));
    fs.writeFileSync(f, l1 + "\n" + l2.slice(0, 10));
    assert.deepEqual(readNewEntries(f, st).map((e) => e.command), ["one"]);
    fs.appendFileSync(f, l2.slice(10) + "\nnot json\n");
    assert.deepEqual(readNewEntries(f, st).map((e) => e.command), ["two"]);
    assert.deepEqual(readNewEntries(f, st), []);
    // rotated / truncated: shorter than offset, starts over
    fs.writeFileSync(f, JSON.stringify(entry({ command: "fresh" })) + "\n");
    assert.deepEqual(readNewEntries(f, st).map((e) => e.command), ["fresh"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runWatch: shows last N, follows appended entries, filters --blocked, stops on abort", async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, "audit.jsonl");
    fs.writeFileSync(f, [entry({ command: "old1" }), entry({ command: "old2", decision: "block", rule: "x" })].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const lines: string[] = [];
    const ac = new AbortController();
    const done = runWatch({ file: f, last: 1, color: false, intervalMs: 20, write: (l) => lines.push(l), signal: ac.signal });
    await sleep(80);
    fs.appendFileSync(f, JSON.stringify(entry({ command: "new-allow" })) + "\n" + JSON.stringify(entry({ command: "new-block", decision: "block", rule: "y" })) + "\n");
    await sleep(120);
    ac.abort();
    await done;
    const text = lines.join("\n");
    assert.match(lines[0], /^Watching .*Ctrl\+C to stop$/);
    assert.ok(!text.includes("old1"), "only the last 1 old entry is shown");
    assert.ok(text.includes("old2") && text.includes("new-allow") && text.includes("new-block"));
    assert.equal(text.split("new-allow").length, 2, "no duplicates");

    const blockedOnly: string[] = [];
    const ac2 = new AbortController();
    const done2 = runWatch({ file: f, blocked: true, last: 5, color: false, intervalMs: 20, write: (l) => blockedOnly.push(l), signal: ac2.signal });
    await sleep(50);
    fs.appendFileSync(f, JSON.stringify(entry({ command: "later-allow" })) + "\n" + JSON.stringify(entry({ command: "later-block", decision: "block" })) + "\n");
    await sleep(100);
    ac2.abort();
    await done2;
    const t2 = blockedOnly.join("\n");
    assert.ok(t2.includes("later-block") && t2.includes("new-block") && !t2.includes("later-allow") && !t2.includes("new-allow"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
