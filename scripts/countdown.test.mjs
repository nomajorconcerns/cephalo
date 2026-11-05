// The 0.2.0 countdown and announcement on the site: correct maths, a safe zero state, and nothing that would make a screen reader chatty.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
const sandbox = { module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(path.join(root, "site", "countdown.js"), "utf8"), sandbox);
const C = sandbox.module.exports;
const LAUNCH = "2026-11-10T13:00:00-05:00";
const L = Date.parse(LAUNCH);

test("the launch instant is 1:00 PM Eastern on Nov 10, 2026 (18:00 UTC, since Eastern is on standard time then)", () => {
  assert.equal(new Date(L).toISOString(), "2026-11-10T18:00:00.000Z");
  assert.equal(C.parseLaunch(LAUNCH), L);
});

test("remaining(): days, hours, minutes, seconds, floored, and never negative", () => {
  const r = (ms) => JSON.parse(JSON.stringify(C.remaining(L, L - ms)));
  assert.deepEqual(r(0), { done: true, days: 0, hours: 0, minutes: 0, seconds: 0 });
  assert.deepEqual(r(1), { done: false, days: 0, hours: 0, minutes: 0, seconds: 0 }, "under a second left still counts as not launched");
  assert.deepEqual(r(1000), { done: false, days: 0, hours: 0, minutes: 0, seconds: 1 });
  assert.deepEqual(r(59_000), { done: false, days: 0, hours: 0, minutes: 0, seconds: 59 });
  assert.deepEqual(r(3_661_000), { done: false, days: 0, hours: 1, minutes: 1, seconds: 1 });
  assert.deepEqual(r(5 * 86400_000 + 3 * 3600_000 + 4 * 60_000 + 5_000), { done: false, days: 5, hours: 3, minutes: 4, seconds: 5 });
  assert.deepEqual(JSON.parse(JSON.stringify(C.remaining(L, L + 86400_000))), { done: true, days: 0, hours: 0, minutes: 0, seconds: 0 }, "after launch: zero, not negative");
});

test("parseLaunch refuses dates without an explicit offset, and garbage", () => {
  for (const bad of ["2026-11-10T13:00:00", "2026-11-10", "soon", "", null, undefined, 5, "2026-13-45T99:00:00-05:00"]) assert.equal(C.parseLaunch(bad), null, String(bad));
  assert.equal(C.parseLaunch("2026-11-10T18:00:00Z"), L);
});

function fakeDom(launch) {
  const els = {};
  const mk = (id, hidden = false) => (els[id] = { id, hidden, textContent: "--", attrs: {}, getAttribute(k) { return this.attrs[k] ?? null; } });
  mk("cdBox").attrs["data-launch"] = launch;
  mk("cdOut", true);
  for (const id of ["cdLabel", "cdD", "cdH", "cdM", "cdS"]) mk(id);
  const doc = { getElementById: (id) => els[id] ?? null };
  const timers = [];
  const win = { setInterval: (f, ms) => (timers.push({ f, ms }), timers.length), clearInterval: (n) => { timers[n - 1].cleared = true; } };
  return { els, doc, win, timers };
}

test("init(): fills the digits, ticks once a second, and swaps to 'is out' at zero, then stops ticking", () => {
  {
    let t = L - (2 * 86400_000 + 3 * 3600_000 + 4 * 60_000 + 5_000);
    const d = fakeDom(LAUNCH);
    const ctl = C.init(d.doc, d.win, () => t);
    assert.ok(ctl);
    assert.deepEqual([d.els.cdD.textContent, d.els.cdH.textContent, d.els.cdM.textContent, d.els.cdS.textContent], ["2", "03", "04", "05"]);
    assert.equal(d.els.cdLabel.textContent, "Cephalo 0.2.0 launches in");
    assert.equal(d.timers.length, 1);
    assert.equal(d.timers[0].ms, 1000);
    assert.equal(d.els.cdBox.hidden, false);
    assert.equal(d.els.cdOut.hidden, true);
    t = L;
    ctl.tick();
    assert.equal(d.els.cdBox.hidden, true);
    assert.equal(d.els.cdOut.hidden, false);
    assert.equal(d.timers[0].cleared, true);
  }
});

test("init(): already past launch shows 'is out' at once without starting a timer; a bad date does nothing", () => {
  {
    const d = fakeDom(LAUNCH);
    C.init(d.doc, d.win, () => L + 1000);
    assert.equal(d.els.cdOut.hidden, false);
    assert.equal(d.timers.length, 0);
    const bad = fakeDom("tomorrow");
    assert.equal(C.init(bad.doc, bad.win), null);
    assert.equal(bad.els.cdOut.hidden, true);
  }
});

test("the page: one launch date, quiet to screen readers, and the announcement says what was asked", () => {
  assert.equal((html.match(/data-launch="/g) || []).length, 1);
  assert.match(html, /data-launch="2026-11-10T13:00:00-05:00"/);
  const cd = /<div class="cd" id="cd"[^>]*>([\s\S]*?)<\/div>\s*<p class="cd-when"/.exec(html);
  assert.ok(cd);
  assert.match(html, /<div class="cd" id="cd" role="timer"[^>]*aria-live="off"/);
  for (const id of ["cdD", "cdH", "cdM", "cdS"]) assert.match(html, new RegExp(`<b id="${id}" aria-hidden="true">`), `${id} is hidden from assistive tech`);
  assert.doesNotMatch(html.slice(html.indexOf('id="announce"'), html.indexOf("<!-- HERO -->")), /aria-live="(polite|assertive)"/, "no live region in the announcement");
  assert.match(html, /Cephalo 0\.2\.0 launches Nov 10, 2026 at 1:00 PM ET/);
  assert.match(html, /Version 0\.1\.1 keeps working\. It is MIT licensed and stays free and open source forever\./);
  assert.match(html, /20% off Pro or Team for the first year with code <span class="chip">CEPHALOG<\/span>/);
  assert.match(html, /<p class="cd-out">Cephalo 0\.2\.0 is out<\/p>\s*<a class="btn primary" href="#install">/);
  assert.match(html, /<script src="countdown\.js" defer><\/script>/);
  assert.match(fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8"), /site\/countdown\.js/, "the Pages workflow publishes the script");
});

test("honest labels: ONE free card holds everything in 0.1.1; the new work is under the tiers and never called Built", () => {
  const feat = html.slice(html.indexOf('<div class="feat" id="feat">'), html.indexOf('<p class="subhead">Planned, not built</p>'));
  assert.equal((feat.match(/<div class="fcard/g) || []).length, 1, "a single card for everything in 0.1.1");
  assert.match(feat, /<span class="badge built">Built<\/span><span class="badge free">Free &middot; since 0\.1\.1<\/span>/);
  assert.equal((feat.match(/<div class="sub">/g) || []).length, 11, "all eleven shipped features are inside it");
  assert.equal((feat.match(/<p class="lim"><b>Limit:<\/b>/g) || []).length, 11, "each says what it cannot do");
  assert.doesNotMatch(feat, /<span class="badge">(Pro|Team|Enterprise)<\/span>/);
  const whatsnew = html.slice(html.indexOf('id="whatsnew"'), html.indexOf("<!-- WITHOUT / WITH -->"));
  assert.doesNotMatch(whatsnew, /badge built/, "unreleased work is never labelled Built");
  const free = whatsnew.slice(whatsnew.indexOf('id="newfree"'), whatsnew.indexOf('id="newpaid"'));
  const paid = whatsnew.slice(whatsnew.indexOf('id="newpaid"'), whatsnew.indexOf('id="themes"'));
  assert.equal((free.match(/Coming Nov 10 in 0\.2\.0/g) || []).length, 8);
  assert.equal((paid.match(/Coming Nov 10 in 0\.2\.0/g) || []).length, 3, "every card is labelled");
  assert.equal((paid.match(/<span class="badge">Pro and Team<\/span>/g) || []).length, 3, "the three paid cards say Pro and Team");
  assert.equal((free.match(/<p class="lim"><b>Limit:<\/b>/g) || []).length, 8);
  assert.equal((paid.match(/<p class="lim"><b>Limit:<\/b>/g) || []).length, 3);
  for (const name of ["reef", "abyss", "coral", "glow", "ink"]) assert.match(whatsnew, new RegExp(`class="theme th-${name}"`));
  assert.match(whatsnew, /preview drawn for this page, not output from the CLI/);
});

test("plans hold exactly what was specified and nothing invented", () => {
  const pricing = html.slice(html.indexOf('<section id="pricing">'), html.indexOf("<!-- INSTALL -->"));
  const tiers = pricing.split(/<div class="tier(?: hl)?">/).slice(1);
  assert.equal(tiers.length, 4);
  const items = (t) => [...t.matchAll(/<li[^>]*><span>(.*?)<\/span><\/li>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
  const [free, pro, team, ent] = tiers;
  assert.match(free, /\$0/);
  assert.deepEqual(items(free), ["Everything from 0.1.1 (the full list)", "Every free 0.2.0 feature Launching Nov 10 (list)"]);
  assert.match(pro, /\$15/);
  assert.deepEqual(items(pro), ["Everything in Free", "Network egress allowlist Launching Nov 10", "Tamper-evident audit log Launching Nov 10", "Bypass benchmark Launching Nov 10"]);
  assert.match(team, /\$25/);
  assert.deepEqual(items(team), ["Everything in Pro", "Dashboard (a local HTML file)", "Shared policy through a shared folder", "Audit log sync with user and time, through a shared folder", "Hosted dashboard Planned"]);
  assert.deepEqual(items(ent), ["Everything in Team", "Single sign-on Planned", "On-prem deployment Planned", "Support SLA Planned", "Signed policy bundles"], "Enterprise is unchanged");
  for (const t of [pro, team]) {
    assert.match(t, /20% off your first year with code <code>CEPHALOG<\/code>/);
    assert.match(t, /<span class="btn soon" data-plan="(pro|team)">Launching Nov 10<\/span>/);
    assert.doesNotMatch(t, /<a class="btn primary"/);
  }
  assert.doesNotMatch(free + ent.split('<div class="calc">')[0], /CEPHALOG/);
  assert.doesNotMatch(pricing, /Email support|Updates first/);
  assert.match(fs.readFileSync(path.join(root, "site", "checkout.config.js"), "utf8"), /mode: "off"/);
});

test("the limits table and FAQ match the new plans", () => {
  const limits = html.slice(html.indexOf('<section id="limits">'), html.indexOf("<!-- FAQ -->"));
  // The site is published ahead of the release: the limits still describe 0.1.1, which is what npm installs.
  assert.doesNotMatch(limits, /0\.2\.0|Coming Nov 10|Launching Nov 10|fail-closed mode|Chain each audit line/);
  assert.match(limits, /Everything here comes from how the code behaves today/);
  const faq = html.slice(html.indexOf('<section id="faq">'));
  assert.match(faq, /Will version 0\.1\.1 stay free\?/);
  assert.match(faq, /What is the CEPHALOG code\?/);
  assert.match(faq, /There is no checkout yet/);
});
