// The 0.3.0 page: no countdown or pre-launch wording left, the 0.3.0 announcement, install/update commands that are
// exact, an update section that claims only what `cephalo update` does, honest labels, plans exactly as specified,
// and limits and FAQ that match.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
const homeJs = fs.readFileSync(path.join(root, "site", "home.js"), "utf8");

test("the pre-launch page is gone, and the bar announces 0.3.0 with the update command", () => {
  assert.ok(!fs.existsSync(path.join(root, "site", "countdown.js")), "countdown.js is deleted");
  assert.doesNotMatch(html, /countdown\.js|id="cdBox"|data-launch=|class="cd"/);
  assert.doesNotMatch(html, /Coming Nov 10|Launching Nov 10|launches Nov 10|None of this is released yet|not released yet|from launch day/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8"), /countdown\.js/, "the Pages workflow no longer copies it");
  const bar = html.slice(html.indexOf('<aside class="released" id="released"'), html.indexOf("</aside>", html.indexOf('id="released"')));
  assert.match(bar, /<span class="rel-pill">v0\.3\.0<\/span>/);
  assert.match(bar, /<b>Cephalo now updates itself\.<\/b> Released /);
  assert.match(bar, /data-copy="cephalo update"/, "the cephalo update chip has a Copy button");
  assert.match(bar, /CHANGELOG\.md#030/, "What's new links to the 0.3.0 changelog");
  assert.match(html, /<span class="vtag">v0\.3\.0<\/span>/, "the footer shows the version");
});

test("install and update: the hero tabs hold the exact commands; the update section claims only what the CLI does", async () => {
  const tabs = html.slice(html.indexOf('<div class="cmdbox">'), html.indexOf('<div class="hero-actions">'));
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /id="tab-new"[^>]*aria-selected="true"/);
  assert.match(tabs, /id="tab-upd"[^>]*aria-selected="false"[^>]*>Update <span class="badge new">New<\/span>/);
  const copies = (s) => [...s.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1]);
  const panel = (id) => tabs.slice(tabs.indexOf(`id="${id}"`), tabs.indexOf("</div>", tabs.indexOf(`id="${id}"`)));
  assert.deepEqual(copies(panel("panel-new")), ["npm install -g @nomajorconcerns/cephalo", "cephalo init"]);
  assert.deepEqual(copies(panel("panel-upd")), ["cephalo update", "npm i -g @nomajorconcerns/cephalo@latest"]);
  assert.match(panel("panel-upd"), /Coming from 0\.2\.x\? Run <code>npm i -g @nomajorconcerns\/cephalo@latest<\/code>.* once\. After that, <code>cephalo update<\/code> handles it\./s);

  const upd = html.slice(html.indexOf('<section id="update"'), html.indexOf("<!-- WHAT'S NEW IN 0.2.0 -->"));
  assert.match(upd, /Updating used to be a chore\./);
  assert.match(upd, /Before &middot; 0\.2\.x and older/);
  assert.match(upd, /Now &middot; 0\.3\.0 and newer/);
  // each claim maps to src/updatecmd.ts: the registry lookup and current -> newest (60-66, 107-112), --check (112),
  // asks then installs (129-135), rules, audit log, settings and license untouched (19, 143), no git checkout or npm link (118),
  // Pro not updated (21); agents cannot run it: no-self-approve, checked below and in src/tests/update.test.ts.
  const checks = [...upd.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]).filter((l) => !l.includes("<span>"));
  assert.deepEqual(checks, [
    "Looks up the newest version on npm and shows <code>current -&gt; newest</code>. <code>--check</code> only looks.",
    "Asks, then runs the npm install for you.",
    "Leaves your rules, audit log, settings and license alone.",
  ]);
  assert.doesNotMatch(upd, /rollback|roll back|verif(y|ies) the download|re-?links? (the )?hooks/i, "nothing the updater does not do");
  assert.match(upd, /href="https:\/\/github\.com\/nomajorconcerns\/cephalo#update"/, "links to the updater docs");

  const { evaluate } = await import(pathToFileURL(path.join(root, "dist", "engine.js")).href);
  const { getPlatform } = await import(pathToFileURL(path.join(root, "dist", "platform.js")).href);
  const { DEFAULT_RULES } = await import(pathToFileURL(path.join(root, "dist", "rules.js")).href);
  const p = getPlatform("linux");
  assert.equal(evaluate({ command: "cephalo update" }, [...DEFAULT_RULES, ...p.rules()], p).rule?.id, "no-self-approve", "agents cannot run it");
});

test("the typed cephalo update session on the page is what the CLI prints", async () => {
  const m = /const SESSION = (\[[\s\S]*?\n\]);/.exec(homeJs);
  assert.ok(m, "SESSION found in site/home.js");
  const session = JSON.parse(JSON.stringify(vm.runInNewContext(m[1]))); // plain objects from this realm
  assert.deepEqual(session[0], { cmd: "cephalo update" });
  const { updateCommand } = await import(pathToFileURL(path.join(root, "dist", "updatecmd.js")).href);
  let asked = "";
  const r = await updateCommand([], {
    current: "0.3.0",
    fetchLatest: async () => "0.3.1",
    runNpm: (args) => ({ status: 0, stdout: args[0] === "root" ? "/usr/lib/node_modules\n" : "", stderr: "" }),
    selfPath: "/usr/lib/node_modules/@nomajorconcerns/cephalo/dist/cli.js",
    confirm: (q) => { asked = q; return Promise.resolve(true); },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(session[1].out, asked, "the prompt is the CLI's question");
  assert.equal(session[1].answer, "y");
  assert.deepEqual(session.slice(2).map((s) => s.out), r.lines, "the lines after the answer are the CLI's lines");
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

test("every local file the page loads is copied by the Pages workflow and listed in its paths filter", () => {
  const yml = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  const collect = yml.slice(yml.indexOf("Collect the site files"), yml.indexOf("Build the public numbers"));
  const filter = yml.slice(yml.indexOf("paths:"), yml.indexOf("schedule:"));
  const main = fs.readFileSync(path.join(root, "site", "main.js"), "utf8");
  const refs = new Set([
    ...[...html.matchAll(/\b(?:src|href)="([^"#:?]+\.(?:js|json|css|woff2|png|svg|ico|html))"/g)].map((m) => m[1]),
    ...[...html.matchAll(/url\(([^)"':]+\.woff2)\)/g)].map((m) => m[1]),
    ...[...main.matchAll(/(?:import\(|from |fetch\()"\.?\/?([^"]+)"/g)].map((m) => m[1]),
  ]);
  refs.delete("stats.json"); // built by the workflow itself (scripts/stats.mjs), not a file in site/
  for (const r of [...refs]) if (r.startsWith("//")) refs.delete(r); // protocol-relative: another host (GoatCounter)
  for (const ref of refs) {
    const file = ref.replace(/^\.\//, "");
    assert.ok(fs.existsSync(path.join(root, "site", file)), `site/${file} exists`);
    assert.ok(collect.includes(`site/${file}`), `pages.yml copies site/${file}`);
    const dir = file.includes("/") ? `site/${file.split("/")[0]}/**` : null;
    assert.ok(filter.includes(`"site/${file}"`) || (dir && filter.includes(`"${dir}"`)), `pages.yml paths lists site/${file}`);
  }
  assert.ok(refs.has("rules.json") && refs.has("home.js") && refs.has("fonts/inter-800-latin.woff2"));
});
