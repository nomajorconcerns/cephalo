import test from "node:test";
import assert from "node:assert/strict";
import { collect, milestones } from "./stats.mjs";

const NOW = Date.parse("2026-11-20T12:00:00Z");

function res(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** a fake fetch: routes are [substring, body | status | function], first match wins; anything else is a 404 */
function fakeFetch(routes, seen = []) {
  return async (url, init = {}) => {
    seen.push({ url, init });
    for (const [needle, out] of routes) {
      if (url.includes(needle)) {
        if (typeof out === "number") return res({ error: "x" }, out);
        return res(typeof out === "function" ? out(url, init) : out);
      }
    }
    return res({ error: "not found" }, 404);
  };
}

const REGISTRY = {
  "dist-tags": { latest: "0.2.0" },
  time: { created: "2026-11-02T02:00:00Z", modified: "2026-11-15T00:00:00Z", "0.0.0-stage": "2026-11-02T01:00:00Z", "0.1.0": "2026-11-02T02:03:20Z", "0.2.0": "2026-11-15T09:00:00Z" },
  versions: { "0.0.0-stage": { stub: true }, "0.1.0": {}, "0.2.0": { deprecated: false } },
  maintainers: [{ name: "someone", email: "private.person@example.com" }],
};
const DOWNLOADS = { downloads: Array.from({ length: 19 }, (_, i) => ({ day: new Date(Date.parse("2026-11-02") + i * 86400000).toISOString().slice(0, 10), downloads: 10 })) };
const GH = (url) => {
  if (url.includes("/stargazers")) return [{ starred_at: "2026-11-05T00:00:00Z" }, { starred_at: "2026-11-09T00:00:00Z" }];
  if (url.includes("/releases")) return [{ tag_name: "v0.2.0", name: "0.2.0", published_at: "2026-11-15T09:00:00Z", html_url: "https://example.test/r", draft: false }, { tag_name: "v0.3.0", draft: true }];
  if (url.includes("/actions/runs")) return { workflow_runs: [{ name: "pages", conclusion: "success", updated_at: "2026-11-20T11:00:00Z" }, { name: "pages", conclusion: "failure", updated_at: "2026-11-19T11:00:00Z" }, { name: "pages", conclusion: "cancelled" }, { name: "other", conclusion: "failure" }] };
  return { stargazers_count: 2, forks_count: 1, open_issues_count: 3, created_at: "2026-11-02T00:59:10Z", pushed_at: "2026-11-20T00:00:00Z" };
};
const GC = (url) => {
  if (url.includes("/stats/total")) return { total: url.includes("start=2025") ? 900 : 40, stats: [{ day: "2026-11-18", daily: 5 }, { day: "2026-11-19", daily: 7 }] };
  if (url.includes("/stats/locations/US")) return { stats: [{ name: "California", count: 9 }, { name: "Texas", count: 4 }] };
  if (url.includes("/stats/locations/DE")) return { stats: [{ name: "Berlin", count: 3 }] };
  if (url.includes("/stats/locations")) return { stats: [{ id: "US", name: "United States", count: 30 }, { id: "DE", name: "Germany", count: 10 }] };
  return {};
};

const ROUTES = [["registry.npmjs.org", REGISTRY], ["api.npmjs.org", DOWNLOADS], ["api.github.com", GH], ["goatcounter.com", GC]];

test("collects every section from the public sources", async () => {
  const seen = [];
  const d = await collect({ fetch: fakeFetch(ROUTES, seen), now: NOW, env: { GOATCOUNTER_SITE: "demo", GOATCOUNTER_TOKEN: "SECRET-TOKEN-123" } });
  assert.equal(d.registry.ok, true);
  assert.deepEqual(d.registry.versions.map((v) => v.version), ["0.1.0", "0.2.0"], "the stub version is not a release");
  assert.equal(d.registry.latest, "0.2.0");
  assert.equal(d.downloads.ok, true);
  assert.equal(d.downloads.total, 190);
  assert.equal(d.downloads.week, 70);
  assert.equal(d.downloads.month, 190);
  assert.equal(d.github.stars, 2);
  assert.equal(d.github.releases.length, 1, "draft releases are not listed");
  assert.deepEqual(d.github.deploys, { runs: 2, succeeded: 1, lastAt: "2026-11-20T11:00:00Z", lastConclusion: "success" }, "only finished pages runs with a pass or fail count");
  assert.equal(d.visitors.ok, true);
  assert.equal(d.visitors.week, 40);
  assert.equal(d.visitors.total, 900);
  assert.equal(d.visitors.countries[0].name, "United States");
  assert.equal(d.visitors.regions[0].name, "California");
  assert.equal(d.visitors.regions[0].country, "United States");
  assert.ok(seen.some((s) => s.init.headers?.authorization === "Bearer SECRET-TOKEN-123"), "the token goes to GoatCounter in a header");
  const text = JSON.stringify(d);
  assert.ok(!text.includes("SECRET-TOKEN-123"), "the token is never written to the output");
  assert.ok(!text.includes("private.person@example.com"), "maintainer email addresses are never copied");
});

test("a failing or missing source is reported, never invented", async () => {
  const d = await collect({ fetch: fakeFetch([["registry.npmjs.org", 404], ["api.npmjs.org", 404], ["api.github.com", 500]]), now: NOW, env: {} });
  assert.equal(d.registry.ok, false);
  assert.match(d.registry.error, /not on npm yet/);
  assert.equal(d.downloads.ok, false);
  assert.match(d.downloads.error, /download counts/);
  assert.equal(d.github.ok, false);
  assert.equal(d.visitors.ok, false);
  assert.equal(d.visitors.configured, false);
  assert.equal(d.sources.visitors, null);
  assert.deepEqual(d.milestones.reached, []);
});

test("a source that fails now keeps the last good numbers, marked stale", async () => {
  const good = await collect({ fetch: fakeFetch(ROUTES), now: NOW, env: {} });
  const later = await collect({ fetch: fakeFetch([["registry.npmjs.org", REGISTRY], ["api.npmjs.org", 503], ["api.github.com", GH]]), now: NOW + 3600000, env: {}, prev: good });
  assert.equal(later.downloads.ok, true);
  assert.equal(later.downloads.stale, true);
  assert.equal(later.downloads.total, 190);
  assert.equal(later.downloads.staleSince, good.generatedAt);
  assert.match(later.downloads.error, /503/);
  assert.equal(later.registry.stale, undefined, "fresh sections are not marked stale");
});

test("a rejected analytics token says so and exposes nothing", async () => {
  const d = await collect({ fetch: fakeFetch([["goatcounter.com", 401], ["registry.npmjs.org", REGISTRY], ["api.npmjs.org", DOWNLOADS], ["api.github.com", GH]]), now: NOW, env: { GOATCOUNTER_SITE: "demo", GOATCOUNTER_TOKEN: "tok" } });
  assert.equal(d.visitors.ok, false);
  assert.match(d.visitors.error, /token was rejected/);
});

test("milestones: dates come from the data, and the next target is the next step up", () => {
  const daily = [{ day: "2026-11-02", count: 40 }, { day: "2026-11-03", count: 70 }, { day: "2026-11-04", count: 5 }];
  const m = milestones({
    registry: { ok: true, versions: [{ version: "0.1.0", date: "2026-11-02T02:00:00Z" }] },
    github: { ok: true, createdAt: "2026-11-01T00:00:00Z", stars: 3, starDates: ["2026-11-05T00:00:00Z", "2026-11-06T00:00:00Z", "2026-11-07T00:00:00Z"] },
    downloads: { ok: true, total: 115, daily },
    visitors: { ok: false },
  });
  const by = Object.fromEntries(m.reached.map((r) => [r.label, r.date]));
  assert.equal(by["10 npm downloads"], "2026-11-02");
  assert.equal(by["100 npm downloads"], "2026-11-03", "passed on the day the running total crossed 100");
  assert.equal(by["1 GitHub stars"], "2026-11-05");
  assert.equal(by["First npm release (0.1.0)"], "2026-11-02T02:00:00Z");
  assert.ok(!("500 npm downloads" in by));
  assert.deepEqual(m.next.find((n) => /downloads/.test(n.label)), { label: "500 npm downloads", have: 115, need: 500 });
  assert.deepEqual(m.next.find((n) => /stars/.test(n.label)), { label: "5 GitHub stars", have: 3, need: 5 });
});

test("an unexpected analytics answer names the endpoint and GoatCounter's message, without the token", async () => {
  const f = async (url) => (url.includes("goatcounter.com") ? { ok: false, status: 404, text: async () => "no such thing", json: async () => ({}) } : res(url.includes("registry") ? REGISTRY : url.includes("api.npmjs") ? DOWNLOADS : GH(url)));
  const d = await collect({ fetch: f, now: NOW, env: { GOATCOUNTER_SITE: "demo", GOATCOUNTER_TOKEN: "SECRET-TOKEN-123" } });
  assert.equal(d.visitors.ok, false);
  assert.match(d.visitors.error, /HTTP 404 for \/stats\/total: no such thing/);
  assert.ok(!JSON.stringify(d).includes("SECRET-TOKEN-123"));
});
