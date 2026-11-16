// The Agensi links (the Cephalo agent guard skill and SentryKit) and the SentryKit section: links only to Agensi skill
// pages, the prices and buttons the listings show, a separate card that never reads as Pro, WAI-ARIA tabs, the real
// transcript, and every new file deployed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = (f) => fs.readFileSync(path.join(root, "site", f), "utf8");
const html = site("index.html");
const sandbox = { module: { exports: {} }, URL };
vm.runInNewContext(site("checkout.js"), sandbox);
const C = sandbox.module.exports;
const ctx = { window: {} };
vm.runInNewContext(site("checkout.config.js"), ctx);
const cfg = ctx.window.CEPHALO_CHECKOUT;

const AGENSI = {
  "cephalo-agent-guard": "https://www.agensi.io/skills/cephalo-agent-guard",
  "sentrykit-lite": "https://www.agensi.io/skills/sentrykit-lite",
  "sentrykit-core": "https://www.agensi.io/skills/sentrykit-core",
  "sentrykit-pro": "https://www.agensi.io/skills/sentrykit-pro",
};
const sk = html.slice(html.indexOf('<section id="sentrykit"'), html.indexOf("</section>", html.indexOf('<section id="sentrykit"')));
const panel = (t) => {
  const i = sk.indexOf(`<div class="skpanel" role="tabpanel" id="sk-panel-${t}"`);
  const next = sk.indexOf('<div class="skpanel"', i + 1);
  return sk.slice(i, next > 0 ? next : sk.indexOf('<div class="skdemo">'));
};

test("skill links: only https Agensi skill pages on agensi.io / www.agensi.io; look-alikes are rejected", () => {
  assert.equal(C.skillUrl(AGENSI["sentrykit-pro"]), AGENSI["sentrykit-pro"]);
  assert.equal(C.skillUrl("https://agensi.io/skills/sentrykit-core"), "https://agensi.io/skills/sentrykit-core");
  for (const bad of ["", undefined, null, 7, "http://www.agensi.io/skills/x", "https://agensi.io.evil.com/skills/x", "https://www.agensi.io.evil.com/skills/x",
    "https://evil-agensi.io/skills/x", "https://agensi.io-evil.com/skills/x", "https://evil.agensi.io/skills/x", "https://user:pw@www.agensi.io/skills/x",
    "https://www.agensi.io:8443/skills/x", "https://www.agensi.io/terms", "https://www.agensi.io/skills/../login", "https://www.agensi.io/skills/a/b",
    "javascript:alert(1)", "//www.agensi.io/skills/x", "https://buy.polar.sh/polar_cl_x", "not a url"]) {
    assert.equal(C.skillUrl(bad), null, String(bad));
  }
  assert.equal(C.checkoutUrl, undefined, "there is no plan checkout any more, so nothing else can turn into a buy link");
});

test("applySkills points each skill link at its configured Agensi page and switches off anything else", () => {
  const mk = (skill, href) => ({ attrs: { "data-skill": skill, href }, getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } });
  const links = [mk("sentrykit-pro", "https://www.agensi.io/skills/sentrykit-pro"), mk("sentrykit-core", "https://evil.example/x"), mk("unknown", "https://agensi.io.evil.com/skills/x")];
  C.applySkills({ querySelectorAll: () => links }, { skills: { "sentrykit-pro": AGENSI["sentrykit-pro"], "sentrykit-core": AGENSI["sentrykit-core"] } });
  assert.equal(links[0].attrs.href, AGENSI["sentrykit-pro"]);
  assert.equal(links[1].attrs.href, AGENSI["sentrykit-core"], "the config wins over a wrong href");
  assert.equal(links[2].attrs.href, undefined);
  assert.equal(links[2].attrs["aria-disabled"], "true");
});

test("the shipped config and the page hold the same four Agensi links, and nothing else", () => {
  assert.deepEqual({ ...cfg.skills }, AGENSI);
  for (const [name, url] of Object.entries(AGENSI)) {
    const links = [...html.matchAll(new RegExp(`<a [^>]*data-skill="${name}"[^>]*>`, "g"))].map((m) => m[0]);
    assert.equal(links.length, 1, `one ${name} button`);
    assert.match(links[0], new RegExp(`href="${url.replace(/[./]/g, "\\$&")}"`));
    assert.match(links[0], /rel="noopener"/);
  }
  assert.deepEqual(Object.keys(cfg), ["skills"]);
});

test("SentryKit tabs follow the WAI-ARIA tabs pattern", () => {
  const list = sk.slice(sk.indexOf('role="tablist"') - 40, sk.indexOf("</div>", sk.indexOf('role="tablist"')));
  assert.match(list, /role="tablist" aria-label="SentryKit editions"/);
  const tabs = [...list.matchAll(/<button\b[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tabs.length, 3);
  const attr = (t, a) => (new RegExp(`${a}="([^"]*)"`).exec(t) || [])[1];
  assert.deepEqual(tabs.map((t) => attr(t, "id")), ["sk-tab-lite", "sk-tab-core", "sk-tab-pro"]);
  assert.deepEqual(tabs.map((t) => attr(t, "aria-selected")), ["false", "true", "false"], "exactly one selected");
  assert.deepEqual(tabs.map((t) => attr(t, "tabindex")), ["-1", "0", "-1"], "roving tabindex");
  for (const t of tabs) {
    assert.match(t, /type="button"/);
    const pid = attr(t, "aria-controls");
    const p = new RegExp(`<div class="skpanel" role="tabpanel" id="${pid}" aria-labelledby="${attr(t, "id")}" tabindex="0"( hidden)?>`).exec(sk);
    assert.ok(p, `${pid} is a tabpanel labelled by its tab`);
    assert.equal(Boolean(p[1]), attr(t, "aria-selected") === "false", `${pid} is hidden unless selected`);
  }
  const js = site("sentrykit.js");
  for (const k of ["ArrowRight", "ArrowLeft", "Home", "End", "aria-selected", "tabIndex"]) assert.ok(js.includes(k), `sentrykit.js handles ${k}`);
});

test("SentryKit prices and buttons match the Agensi listings (Lite free, Core $12, Pro $19.99)", () => {
  const want = { lite: ["Free", "Get free"], core: ["$12<small> one-time</small>", "Buy Core, $12"], pro: ["$19.99<small> one-time</small>", "Buy Pro, $19.99"] };
  for (const [t, [price, label]] of Object.entries(want)) {
    const p = panel(t);
    assert.ok(p.includes(`<div class="skprice">${price}</div>`), `${t} price`);
    assert.ok(p.includes(`data-skill="sentrykit-${t}">${label}</a>`), `${t} button`);
    assert.ok(p.includes(`src="sentrykit/${t}.svg"`), `${t} logo`);
  }
  assert.match(sk, /<span class="skn">Lite<\/span><span class="skp">Free<\/span>/);
  assert.match(sk, /<span class="skn">Core<\/span><span class="skp">\$12<\/span>/);
  assert.match(sk, /<span class="skn">Pro<\/span><span class="skp">\$19\.99<\/span>/);
  assert.doesNotMatch(sk, /\$24|CodeRabbit/, "not the old listing price, and no comparison");
});

test("honest edition contents: Lite has no skill audit or screenshots of one; the required lines are there", () => {
  const lite = panel("lite");
  assert.doesNotMatch(lite, /<img [^>]*\.webp/, "no screenshots for Lite (the generic set was taken with the Pro zip)");
  assert.match(lite, /Not in Lite:<\/b> the code-pattern and dependency scanners, patch files, the skill malware audit and SARIF export/);
  assert.doesNotMatch(panel("core"), /skill-malware-audit|sarif-export/);
  assert.match(sk, /assists review, not a replacement for a professional audit or pentest/);
  assert.match(sk, /Runs in your agent, uses your model tokens/);
  for (const m of sk.matchAll(/<img [^>]*\.webp"[^>]*>/g)) {
    assert.match(m[0], /width="1280" height="800" loading="lazy"/, "explicit size, lazy");
    assert.match(m[0], /alt="[^"]{20,}"/);
  }
});

test("the scan demo: real transcript with masked secrets, a code finding and a Pro-only skill audit; never autoplays", () => {
  const script = sk.slice(sk.indexOf('id="skScript"'), sk.indexOf('<p class="skcap">'));
  assert.match(script, /AWS_ACCESS_KEY_ID = &quot;AKIA\*\*\*\*&quot;/);
  assert.doesNotMatch(script, /AKIA[A-Z0-9]{16}/, "no full key anywhere");
  assert.match(script, /SK-CMD-SHELL-TRUE/);
  assert.match(script, /3\. Skill malware audit<\/span> <span class="skscope pro">Pro only<\/span>/);
  assert.match(script, /audit_skills\.py --path/);
  assert.match(sk, /<button type="button" id="skRun" hidden>Run scan<\/button>/);
  const js = site("sentrykit.js");
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /btn\.addEventListener\('click'/);
  assert.match(js, /'Replay'/);
  assert.doesNotMatch(js.replace(/btn\.addEventListener\('click', function \(\) \{ play\(\); \}\);/, ""), /(?<!function )\bplay\(\)/, "play() runs only from the button");
});

test("lazy loading and deploy: the loader reads data-src, and every SentryKit file is published by pages.yml", () => {
  assert.match(html, /<section id="sentrykit" aria-labelledby="skTitle" data-src="sentrykit\.js">/);
  assert.doesNotMatch(html, /<script src="sentrykit\.js"/, "not loaded up front");
  const yml = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  assert.ok(yml.includes('- "site/sentrykit.js"') && yml.includes('- "site/sentrykit/**"'));
  const files = fs.readdirSync(path.join(root, "site", "sentrykit"));
  for (const f of files) assert.match(yml, new RegExp(`cp [^\\n]*site/sentrykit/${f.replace(/\./g, "\\.")}[^\\n]* _site/sentrykit/`), `pages.yml copies ${f}`);
  for (const m of sk.matchAll(/src="(sentrykit\/[^"]+)"/g)) assert.ok(files.includes(m[1].slice(10)), `${m[1]} exists`);
  assert.match(yml, /cp [^\n]*site\/sentrykit\.js[^\n]* _site\//);
});

test("refunds and terms: skills bought on Agensi follow Agensi's refund policy and terms", () => {
  for (const f of ["refunds.html", "terms.html"]) {
    const page = site(f);
    assert.match(page, /<h2 id="agensi">Skills (bought|sold) on Agensi<\/h2>/, f);
    assert.ok(page.includes('href="https://www.agensi.io/terms#refunds"'), `${f} links Agensi's refund section`);
    assert.ok(page.includes('href="https://www.agensi.io/terms"'), `${f} links Agensi's terms`);
    assert.match(page, /does not include a Cephalo license key or any paid Cephalo feature/);
    assert.doesNotMatch(page, /Pro and Team|Pro or Team|Polar|14 days|CEPHALOG/, `${f}: no terms for plans that are not sold`);
  }
});
