import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MODELS_CONFIG, isLoopbackHost, loadModelsConfig, parseModelsConfig, requiredTags, serializeModelsConfig } from "../models/config.js";
import { ollamaStatus, type FetchLike } from "../models/ollama.js";
import { applyModelsEnabled, modelsPullPlan, modelsStatus, modelsSummary, planModelsEnabled } from "../modelscmd.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-models-"));

/** A fake Ollama: serves /api/tags and /api/version, records every URL asked. */
function fakeOllama(names: string[], opts: { version?: string; down?: boolean; hang?: boolean } = {}) {
  const urls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    if (opts.down) throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    if (opts.hang) {
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    if (url.endsWith("/api/tags")) return { ok: true, status: 200, json: async () => ({ models: names.map((name) => ({ name })) }) };
    if (url.endsWith("/api/version")) return { ok: true, status: 200, json: async () => ({ version: opts.version ?? "0.12.0" }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch, urls };
}

test("defaults: off, local host, the four configured models in their roles", () => {
  const d = DEFAULT_MODELS_CONFIG;
  assert.equal(d.enabled, false);
  assert.equal(d.host, "http://127.0.0.1:11434");
  assert.deepEqual(d.roles.decider, ["d3:2b", "qwen3.5:4b"]);
  assert.deepEqual(d.roles.reviewer, ["d3:2b", "qwen3.5:9b"]);
  assert.deepEqual(d.roles.embedding, ["nomic-embed-text"]);
  assert.deepEqual(requiredTags(d).map((r) => r.tag), ["d3:2b", "qwen3.5:4b", "qwen3.5:9b", "nomic-embed-text"]);
});

test("a missing file gives defaults and does not create anything", () => {
  const dir = tmp();
  const file = path.join(dir, "models.yml");
  assert.deepEqual(loadModelsConfig(file), DEFAULT_MODELS_CONFIG);
  assert.equal(fs.existsSync(file), false);
});

test("serialize then parse round-trips", () => {
  const { config, problems } = parseModelsConfig(serializeModelsConfig({ ...DEFAULT_MODELS_CONFIG, enabled: true }));
  assert.deepEqual(problems, []);
  assert.deepEqual(config, { ...DEFAULT_MODELS_CONFIG, enabled: true });
});

test("loopback check accepts local addresses only", () => {
  for (const h of ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434", "http://127.1.2.3"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["http://example.com:11434", "http://192.168.1.5:11434", "http://127.0.0.1.evil.example", "not a url", ""]) assert.equal(isLoopbackHost(h), false, h);
});

test("bad values fall back to defaults with a message each", () => {
  const { config, problems } = parseModelsConfig(
    "enabled: yes please\nhost: http://evil.example:11434\ntimeout_ms: 5\nroles:\n  decider: []\n  judge: [x:1b]\n  reviewer: ['bad tag!']\n",
  );
  assert.deepEqual(config, DEFAULT_MODELS_CONFIG);
  assert.equal(problems.length, 6);
  assert.ok(problems.some((p) => /local Ollama/.test(p)));
  assert.ok(problems.some((p) => /unknown role "judge"/.test(p)));
});

test("invalid YAML and non-mappings give defaults", () => {
  assert.deepEqual(parseModelsConfig("a: [unclosed").config, DEFAULT_MODELS_CONFIG);
  assert.match(parseModelsConfig("- just\n- a list").problems[0], /mapping/);
});

test("a role may be one tag as a plain string, and duplicates collapse", () => {
  const { config } = parseModelsConfig("roles:\n  decider: d3:2b\n  reviewer: [a:1b, a:1b, b:2b]\n");
  assert.deepEqual(config.roles.decider, ["d3:2b"]);
  assert.deepEqual(config.roles.reviewer, ["a:1b", "b:2b"]);
});

test("ollamaStatus: lists installed models and version", async () => {
  const o = fakeOllama(["d3:2b", "nomic-embed-text:latest"]);
  const s = await ollamaStatus({ host: DEFAULT_MODELS_CONFIG.host, timeoutMs: 1000, fetch: o.fetch });
  assert.equal(s.reachable, true);
  assert.equal(s.version, "0.12.0");
  assert.deepEqual(s.installed, ["d3:2b", "nomic-embed-text:latest"]);
});

test("ollamaStatus: a down server and a hung server are reported, not thrown", async () => {
  const down = await ollamaStatus({ host: DEFAULT_MODELS_CONFIG.host, timeoutMs: 1000, fetch: fakeOllama([], { down: true }).fetch });
  assert.equal(down.reachable, false);
  assert.match(down.error!, /ECONNREFUSED/);
  const hung = await ollamaStatus({ host: DEFAULT_MODELS_CONFIG.host, timeoutMs: 50, fetch: fakeOllama([], { hang: true }).fetch });
  assert.equal(hung.reachable, false);
  assert.match(hung.error!, /no answer within 50 ms/);
});

test("ollamaStatus never contacts a non-local host", async () => {
  const o = fakeOllama(["x"]);
  const s = await ollamaStatus({ host: "http://example.com:11434", timeoutMs: 1000, fetch: o.fetch });
  assert.equal(s.reachable, false);
  assert.deepEqual(o.urls, []);
});

test("status: reports installed and missing per role, ':latest' counts as a match", async () => {
  const dir = tmp();
  const file = path.join(dir, "models.yml");
  const r = await modelsStatus({ file, fetch: fakeOllama(["d3:2b", "nomic-embed-text:latest"]).fetch });
  const text = r.lines.join("\n");
  assert.match(text, /d3:2b\s+installed/);
  assert.match(text, /qwen3\.5:4b\s+missing/);
  assert.match(text, /qwen3\.5:9b\s+missing/);
  assert.match(text, /nomic-embed-text\s+installed/);
  assert.match(text, /Missing: qwen3\.5:4b, qwen3\.5:9b/);
  assert.match(text, /judge is off/);
  assert.equal(r.exitCode, 0, "off means nothing to fix");
});

test("status: exit 1 when enabled and something is missing or Ollama is down", async () => {
  const dir = tmp();
  const file = path.join(dir, "models.yml");
  fs.writeFileSync(file, serializeModelsConfig({ ...DEFAULT_MODELS_CONFIG, enabled: true }));
  assert.equal((await modelsStatus({ file, fetch: fakeOllama(["d3:2b"]).fetch })).exitCode, 1);
  assert.equal((await modelsStatus({ file, fetch: fakeOllama([], { down: true }).fetch })).exitCode, 1);
  const ready = await modelsStatus({ file, fetch: fakeOllama(["d3:2b", "qwen3.5:4b", "qwen3.5:9b", "nomic-embed-text"]).fetch });
  assert.equal(ready.exitCode, 0);
  assert.match(ready.lines.join("\n"), /All configured models are installed/);
});

test("pull prints commands for missing models only and downloads nothing", async () => {
  const dir = tmp();
  const o = fakeOllama(["d3:2b"]);
  const r = await modelsPullPlan({ file: path.join(dir, "models.yml"), fetch: o.fetch });
  const text = r.lines.join("\n");
  assert.match(text, /ollama pull qwen3\.5:4b/);
  assert.match(text, /ollama pull qwen3\.5:9b/);
  assert.match(text, /ollama pull nomic-embed-text/);
  assert.doesNotMatch(text, /ollama pull d3:2b/);
  assert.ok(o.urls.every((u) => /\/api\/(tags|version)$/.test(u)), "only read-only endpoints were used");
  const all = await modelsPullPlan({ file: path.join(dir, "models.yml"), fetch: fakeOllama(["d3:2b", "qwen3.5:4b", "qwen3.5:9b", "nomic-embed-text"]).fetch });
  assert.match(all.lines[0], /Nothing to pull/);
});

test("pull with Ollama down lists every configured model", async () => {
  const r = await modelsPullPlan({ file: path.join(tmp(), "models.yml"), fetch: fakeOllama([], { down: true }).fetch });
  assert.equal(r.lines.filter((l) => /ollama pull/.test(l)).length, 4);
});

test("enable: creates the file; disable: backs the old one up first", () => {
  const dir = tmp();
  const file = path.join(dir, "models.yml");
  const plan = planModelsEnabled("enable", { file });
  assert.equal(plan.changed, true);
  assert.equal(fs.existsSync(file), false, "planning writes nothing");
  applyModelsEnabled("enable", { file, now: () => 1_700_000_000_000 });
  assert.equal(loadModelsConfig(file).enabled, true);
  assert.equal(planModelsEnabled("enable", { file }).changed, false);

  const before = fs.readFileSync(file, "utf8");
  const lines = applyModelsEnabled("disable", { file, now: () => 1_700_000_001_000 });
  assert.equal(loadModelsConfig(file).enabled, false);
  const backups = fs.readdirSync(dir).filter((f) => f.includes("cephalo-backup"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), before);
  assert.match(lines[0], /Backed up/);
});

test("enable keeps the user's own roles and host", () => {
  const dir = tmp();
  const file = path.join(dir, "models.yml");
  fs.writeFileSync(file, "host: http://localhost:12345\nroles:\n  decider: [mine:1b]\n");
  applyModelsEnabled("enable", { file });
  const c = loadModelsConfig(file);
  assert.equal(c.enabled, true);
  assert.equal(c.host, "http://localhost:12345");
  assert.deepEqual(c.roles.decider, ["mine:1b"]);
});

test("summary: off makes no network call; enabled reports missing tags", async () => {
  const dir = tmp();
  const file = path.join(dir, "models.yml");
  const o = fakeOllama([]);
  assert.deepEqual(await modelsSummary({ file, fetch: o.fetch }), { enabled: false, reachable: false, missing: [] });
  assert.deepEqual(o.urls, []);
  applyModelsEnabled("enable", { file });
  const s = await modelsSummary({ file, fetch: fakeOllama(["d3:2b"]).fetch });
  assert.equal(s.enabled, true);
  assert.deepEqual(s.missing, ["qwen3.5:4b", "qwen3.5:9b", "nomic-embed-text"]);
});
