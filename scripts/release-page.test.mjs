// The released-0.2.0 page: no countdown or pre-launch wording left, an install/update section with the exact commands,
// honest labels, plans exactly as specified, and limits and FAQ that match.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");

test("the pre-launch page is gone: no countdown, no 'coming Nov 10' wording, no countdown script", () => {
  assert.ok(!fs.existsSync(path.join(root, "site", "countdown.js")), "countdown.js is deleted");
  assert.doesNotMatch(html, /countdown\.js|id="cdBox"|data-launch=|class="cd"/);
  assert.doesNotMatch(html, /Coming Nov 10|Launching Nov 10|launches Nov 10|None of this is released yet|not released yet|from launch day/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8"), /countdown\.js/, "the Pages workflow no longer copies it");
  assert.match(html, /<aside class="released" id="released"[\s\S]*Cephalo 0\.2\.0 is out\./);
});

test("install and update: one section with the exact commands, honest about cephalo update", () => {
  const upd = html.slice(html.indexOf('<section id="update"'), html.indexOf("<!-- WHAT'S NEW IN 0.2.0 -->"));
  assert.ok(upd.length > 500, "the section exists and sits before What's new");
  assert.ok(upd.includes("npm install -g @nomajorconcerns/cephalo\ncephalo init") || upd.includes("npm install -g @nomajorconcerns/cephalo\r\ncephalo init"));
  const lines = (id) => (upd.match(new RegExp(`id="${id}">([^]*?)</pre>`)) || [])[1]?.split(/\r?\n/);
  assert.deepEqual(lines("updNew"), ["npm install -g @nomajorconcerns/cephalo", "cephalo init"]);
  assert.deepEqual(lines("updOld"), ["npm install -g @nomajorconcerns/cephalo@latest", "cephalo install claude", "cephalo install hermes", "cephalo doctor"]);
  assert.deepEqual(lines("updCmd"), ["cephalo update --check", "cephalo update"]);
  assert.match(upd, /<b>Not in 0\.2\.0\.<\/b>/, "the built-in updater is not claimed for 0.2.0");
  assert.match(upd, /Agents cannot run it/);
  assert.match(upd, /npm ls -g @nomajorconcerns\/cephalo/, "how to see the installed version");
  assert.ok(html.split('href="#update"').length > 5, "linked from the strip, nav, menu, hero, footer and install steps");
  for (const id of ["updNew", "updOld", "updCmd"]) assert.match(html, new RegExp(`data-copy-from="${id}"`), `${id} has a Copy button`);
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
  assert.equal((free.match(/New in 0\.2\.0/g) || []).length, 8);
  assert.equal((paid.match(/New in 0.2.0/g) || []).length, 3);
  assert.equal((paid.match(/<span class="badge">Pro<\/span>/g) || []).length, 3, "the three paid cards sit under Pro");
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
  assert.deepEqual(items(free), ["Everything from 0.1.1 (the full list)", "Every free 0.2.0 feature New in 0.2.0 (list)"]);
  assert.match(pro, /\$15/);
  assert.deepEqual(items(pro), ["Everything in Free", "Network egress allowlist New in 0.2.0", "Tamper-evident audit log New in 0.2.0", "Bypass benchmark New in 0.2.0"]);
  assert.match(team, /\$25/);
  assert.deepEqual(items(team), ["Everything in Pro", "Dashboard (a local HTML file)", "Shared policy through a shared folder", "Audit log sync with user and time, through a shared folder", "Hosted dashboard Planned"]);
  assert.deepEqual(items(ent), ["Everything in Team", "Single sign-on Planned", "On-prem deployment Planned", "Support SLA Planned", "Signed policy bundles"], "Enterprise is unchanged");
  for (const t of [pro, team]) {
    assert.match(t, /20% off your first year with code <code>CEPHALOG<\/code>/);
    assert.match(t, /<span class="btn soon" data-plan="(pro|team)">Not on sale yet<\/span>/);
    assert.doesNotMatch(t, /<a class="btn primary"/);
  }
  assert.doesNotMatch(free + ent.split('<div class="calc">')[0], /CEPHALOG/);
  assert.doesNotMatch(pricing, /Email support|Updates first/);
  assert.match(fs.readFileSync(path.join(root, "site", "checkout.config.js"), "utf8"), /mode: "off"/);
});

test("the limits table and FAQ match the new plans", () => {
  const limits = html.slice(html.indexOf('<section id="limits">'), html.indexOf("<!-- FAQ -->"));
  assert.match(limits, /what 0\.2\.0 added/);
  assert.match(limits, /fail-closed mode/);
  assert.match(limits, /Chain each audit line/);
  const faq = html.slice(html.indexOf('<section id="faq">'));
  assert.match(faq, /Will version 0\.1\.1 stay free\?/);
  assert.match(faq, /What is the CEPHALOG code\?/);
  assert.match(faq, /There is no checkout on this page yet/);
  assert.match(faq, /How do I update Cephalo\?/);
});
