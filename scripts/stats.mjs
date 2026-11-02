#!/usr/bin/env node
/**
 * Builds stats.json for the website: public numbers about Cephalo, collected from public sources.
 *
 *   npm registry      release history (versions and dates)
 *   npm downloads     installs, as counted by npm (includes mirrors and CI installs; stats appear about a day after a release)
 *   GitHub API        stars, forks, releases, and the success rate of the site's own deploy runs
 *   GoatCounter       site visitors, countries and regions. Only when GOATCOUNTER_SITE and GOATCOUNTER_TOKEN are set.
 *
 * The Cephalo command sends nothing anywhere, so none of this is a count of people using it. Every section says where
 * its numbers come from, and a source that fails is reported as not ok instead of being filled in. When a source fails
 * and a previous snapshot had good numbers for it, the old numbers are kept and marked stale.
 *
 * Usage: node scripts/stats.mjs --out _site/stats.json [--prev https://.../stats.json | path]
 * Env:   GITHUB_TOKEN (optional, raises the rate limit), GOATCOUNTER_SITE, GOATCOUNTER_TOKEN
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG = "@nomajorconcerns/cephalo";
export const REPO = "nomajorconcerns/cephalo";
const DAY = 86400000;

const day = (t) => new Date(t).toISOString().slice(0, 10);
const hour = (t) => new Date(Math.floor(t / 3600000) * 3600000).toISOString().replace(/\.\d+Z$/, "Z");
const sum = (a) => a.reduce((n, x) => n + x, 0);

async function getJson(f, url, headers = {}) {
  const r = await f(url, { headers: { accept: "application/json", "user-agent": "cephalo-stats", ...headers } });
  if (!r.ok) {
    let body = "";
    try { body = (await r.text()).slice(0, 120); } catch { /* ignore */ }
    const e = new Error(`HTTP ${r.status}`);
    e.status = r.status;
    e.body = body;
    try { e.where = new URL(url).pathname.replace(/^\/api\/v0/, ""); } catch { /* ignore */ }
    throw e;
  }
  return r.json();
}

const fail = (e, hint) => ({ ok: false, error: hint ?? (e && e.status ? `HTTP ${e.status}` : "request failed") });

export async function npmRegistry(f) {
  try {
    const j = await getJson(f, `https://registry.npmjs.org/${PKG.replace("/", "%2f")}`);
    const versions = Object.entries(j.time ?? {})
      .filter(([v]) => v !== "created" && v !== "modified" && j.versions?.[v] && !j.versions[v].stub)
      .map(([version, date]) => ({ version, date, deprecated: Boolean(j.versions[version].deprecated) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    // maintainers (with their email addresses) are deliberately not copied
    return { ok: true, name: PKG, latest: j["dist-tags"]?.latest ?? null, versions };
  } catch (e) {
    return fail(e, e.status === 404 ? "the package is not on npm yet" : undefined);
  }
}

export async function npmDownloads(f, since, now) {
  try {
    const from = since ? since.slice(0, 10) : day(now - 30 * DAY);
    const j = await getJson(f, `https://api.npmjs.org/downloads/range/${from}:${day(now)}/${PKG}`);
    const daily = (j.downloads ?? []).map((d) => ({ day: d.day, count: d.downloads }));
    const cut = (n) => day(now - n * DAY);
    return {
      ok: true,
      total: sum(daily.map((d) => d.count)),
      week: sum(daily.filter((d) => d.day > cut(7)).map((d) => d.count)),
      month: sum(daily.filter((d) => d.day > cut(30)).map((d) => d.count)),
      daily,
      note: "npm download counts include mirrors, bots and CI installs, and show up about a day after a release.",
    };
  } catch (e) {
    return fail(e, e.status === 404 ? "npm has not published download counts for this package yet (they appear about a day after the first release)" : undefined);
  }
}

export async function github(f, token, now) {
  const h = token ? { authorization: `Bearer ${token}` } : {};
  const out = { ok: false };
  try {
    const r = await getJson(f, `https://api.github.com/repos/${REPO}`, h);
    Object.assign(out, { ok: true, stars: r.stargazers_count, forks: r.forks_count, openIssues: r.open_issues_count, createdAt: r.created_at, pushedAt: r.pushed_at });
  } catch (e) { return fail(e); }
  try {
    const rel = await getJson(f, `https://api.github.com/repos/${REPO}/releases?per_page=30`, h);
    out.releases = rel.filter((x) => !x.draft).map((x) => ({ tag: x.tag_name, name: x.name || x.tag_name, date: x.published_at, url: x.html_url }));
  } catch { out.releases = []; }
  try {
    const stars = [];
    for (let p = 1; p <= 5; p++) {
      const page = await getJson(f, `https://api.github.com/repos/${REPO}/stargazers?per_page=100&page=${p}`, { ...h, accept: "application/vnd.github.star+json" });
      stars.push(...page.map((s) => s.starred_at).filter(Boolean));
      if (page.length < 100) break;
    }
    out.starDates = stars.sort();
  } catch { out.starDates = []; }
  try {
    const runs = await getJson(f, `https://api.github.com/repos/${REPO}/actions/runs?per_page=100&status=completed`, h);
    const deploys = (runs.workflow_runs ?? []).filter((x) => x.name === "pages" && (x.conclusion === "success" || x.conclusion === "failure")).slice(0, 50);
    out.deploys = {
      runs: deploys.length,
      succeeded: deploys.filter((x) => x.conclusion === "success").length,
      lastAt: deploys[0]?.updated_at ?? null,
      lastConclusion: deploys[0]?.conclusion ?? null,
    };
  } catch { out.deploys = null; }
  return out;
}

export async function goatcounter(f, site, token, now) {
  if (!site || !token) return { ok: false, configured: false, error: "visitor analytics is not connected yet" };
  const base = `https://${site}.goatcounter.com/api/v0`;
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const range = (days) => `start=${encodeURIComponent(hour(now - days * DAY))}&end=${encodeURIComponent(hour(now + 3600000))}`;
  try {
    const all = await getJson(f, `${base}/stats/total?${range(365)}`, h);
    const w = await getJson(f, `${base}/stats/total?${range(7)}`, h);
    const m = await getJson(f, `${base}/stats/total?${range(30)}`, h);
    let daily = (all.stats ?? []).map((s) => ({ day: s.day, count: s.daily ?? 0 })).filter((s) => s.day);
    // drop the long run of empty days before the first visit; the page fills gaps itself
    const firstSeen = daily.findIndex((s) => s.count > 0);
    daily = firstSeen < 0 ? daily.slice(-30) : daily.slice(firstSeen);
    const out = { ok: true, configured: true, week: w.total ?? 0, month: m.total ?? 0, total: all.total ?? 0, daily, countries: [], regions: [] };
    try {
      const loc = await getJson(f, `${base}/stats/locations?${range(30)}&limit=15`, h);
      out.countries = (loc.stats ?? []).map((s) => ({ id: s.id, name: s.name, count: s.count }));
      for (const c of out.countries.slice(0, 5)) {
        if (!c.id) continue;
        try {
          const det = await getJson(f, `${base}/stats/locations/${encodeURIComponent(c.id)}?${range(30)}&limit=6`, h);
          for (const r of det.stats ?? []) if (r.name) out.regions.push({ country: c.name, name: r.name, count: r.count });
        } catch { /* regions are optional */ }
      }
      out.regions.sort((a, b) => b.count - a.count);
      out.regions = out.regions.slice(0, 12);
    } catch { /* countries are optional */ }
    return out;
  } catch (e) {
    if (e.status === 401 || e.status === 403) return fail(e, "the analytics token was rejected");
    // the response body is GoatCounter's own error text; it never contains our token
    const text = String(e.body ?? "").replace(/\s+/g, " ").slice(0, 100);
    return fail(e, `GoatCounter answered HTTP ${e.status}${e.where ? ` for ${e.where}` : ""}${text ? `: ${text}` : ""}`);
  }
}

const STEPS = { downloads: [1, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000], visitors: [100, 500, 1000, 5000, 10000, 50000, 100000], stars: [1, 5, 10, 25, 50, 100, 250, 500, 1000] };

function reachedOn(dates, n) { return dates.length >= n ? dates[n - 1] : null; }

export function milestones(d) {
  const list = [];
  const first = d.registry.ok ? d.registry.versions[0] : null;
  if (first) list.push({ kind: "event", label: `First npm release (${first.version})`, date: first.date });
  if (d.github.ok && d.github.createdAt) list.push({ kind: "event", label: "Source published on GitHub", date: d.github.createdAt });
  const series = [];
  if (d.downloads.ok) {
    // cumulative download dates: the day each target was passed
    let run = 0;
    const cum = d.downloads.daily.map((x) => ({ day: x.day, n: (run += x.count) }));
    series.push({ key: "downloads", noun: "npm downloads", total: d.downloads.total, date: (t) => cum.find((c) => c.n >= t)?.day ?? null });
  }
  if (d.visitors.ok) {
    let run = 0;
    const cum = d.visitors.daily.map((x) => ({ day: x.day, n: (run += x.count) }));
    series.push({ key: "visitors", noun: "site visitors", total: d.visitors.total, date: (t) => cum.find((c) => c.n >= t)?.day ?? null });
  }
  if (d.github.ok) {
    const dates = d.github.starDates ?? [];
    series.push({ key: "stars", noun: "GitHub stars", total: d.github.stars, date: (t) => (reachedOn(dates, t) ? reachedOn(dates, t).slice(0, 10) : null) });
  }
  const targets = [];
  for (const s of series) {
    for (const t of STEPS[s.key]) if (s.total >= t) list.push({ kind: "reached", label: `${t.toLocaleString("en-US")} ${s.noun}`, date: s.date(t) });
    const next = STEPS[s.key].find((t) => t > s.total);
    if (next) targets.push({ label: `${next.toLocaleString("en-US")} ${s.noun}`, have: s.total, need: next });
  }
  list.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
  return { reached: list, next: targets };
}

export async function collect({ fetch: f = globalThis.fetch, now = Date.now(), env = {}, prev = null } = {}) {
  const registry = await npmRegistry(f);
  const since = registry.ok && registry.versions[0] ? registry.versions[0].date : null;
  const [downloads, gh, visitors] = [await npmDownloads(f, since, now), await github(f, env.GITHUB_TOKEN, now), await goatcounter(f, env.GOATCOUNTER_SITE, env.GOATCOUNTER_TOKEN, now)];
  const data = { generatedAt: new Date(now).toISOString(), registry, downloads, github: gh, visitors };
  // keep the last good numbers when a source fails now
  for (const k of ["registry", "downloads", "github", "visitors"]) {
    if (!data[k].ok && prev?.[k]?.ok) data[k] = { ...prev[k], stale: true, staleSince: prev[k].staleSince ?? prev.generatedAt, error: data[k].error };
  }
  data.milestones = milestones(data);
  data.sources = {
    registry: "registry.npmjs.org",
    downloads: "api.npmjs.org",
    github: "api.github.com",
    visitors: data.visitors.configured === false ? null : "GoatCounter",
  };
  return data;
}

async function loadPrev(src) {
  if (!src) return null;
  try {
    if (/^https?:/.test(src)) {
      const r = await fetch(src, { headers: { "user-agent": "cephalo-stats" } });
      return r.ok ? await r.json() : null;
    }
    return JSON.parse(fs.readFileSync(src, "utf8"));
  } catch { return null; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const a = process.argv.slice(2);
  const val = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const out = val("--out") ?? "stats.json";
  const prev = await loadPrev(val("--prev"));
  const data = await collect({ env: process.env, prev });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data) + "\n", "utf8");
  const okc = ["registry", "downloads", "github", "visitors"].map((k) => `${k}:${data[k].ok ? (data[k].stale ? "stale" : "ok") : "no"}`).join(" ");
  console.log(`Wrote ${out} (${okc})`);
  for (const k of ["registry", "downloads", "github", "visitors"]) if (!data[k].ok) console.log(`  ${k}: ${data[k].error}`);
}
