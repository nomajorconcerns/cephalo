// The Get Cephalo card's tentacle: the Buy link stays a real link, only a plain click (or Enter) plays the snatch, it
// navigates exactly once (animationend or the timeout), reduced motion goes straight there, and Back resets the card.
// Also: no Polar where the site talks about buying, refunds or who takes payment.
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
const URL_AG = "https://www.agensi.io/skills/cephalo-agent-guard";

// a small DOM and window, enough for tentacle()
function world({ reduce = false, attrs = {} } = {}) {
  const listeners = (o) => { o.on = {}; o.addEventListener = (t, f) => (o.on[t] ||= []).push(f); o.fire = (t, e) => (o.on[t] || []).forEach((f) => f(e)); return o; };
  const classes = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), has: s }; };
  const link = listeners({ href: URL_AG, attrs: { href: URL_AG, "data-skill": "cephalo-agent-guard", ...attrs }, getAttribute(k) { return this.attrs[k] ?? null; }, hasAttribute(k) { return k in this.attrs; } });
  const section = { classList: classes() };
  const card = listeners({ classList: classes(), parentNode: { parentNode: section }, querySelector: () => link });
  const timers = [];
  const win = listeners({
    navigations: [],
    location: { assign(u) { win.navigations.push(u); } },
    matchMedia: (q) => ({ matches: reduce && q.includes("reduce") }),
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].f = () => {}; },
  });
  const doc = { querySelector: (q) => (q === ".getcard" ? card : null) };
  const api = C.tentacle(doc, win);
  const click = (o = {}) => { const e = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...o, preventDefault() { this.defaultPrevented = true; } }; link.fire("click", e); return e; };
  return { api, link, card, section, win, timers, click };
}

test("the Buy link is a real <a href> to the Agensi page, inside the card, with the tentacle marked aria-hidden", () => {
  const card = html.slice(html.indexOf('<article class="getcard"'), html.indexOf("</article>", html.indexOf('<article class="getcard"')));
  assert.ok(card.includes(`<a class="btn primary" href="${URL_AG}" rel="noopener" data-skill="cephalo-agent-guard">Buy on Agensi</a>`));
  assert.doesNotMatch(card, /<a [^>]*data-skill[^>]*\b(target|onclick)=/);
  assert.match(card, /<span class="gc-sea" aria-hidden="true">/);
  assert.match(card, /<span class="gc-grab" aria-hidden="true">/);
  assert.match(html, /\.getcard:has\(\.gc-buywrap a:focus-visible\) \.gc-tent/, "keyboard focus shows the tentacle too");
});

test("a plain click (or Enter) plays the snatch, then navigates exactly once to the exact URL", () => {
  const w = world();
  const e = w.click();
  assert.equal(e.defaultPrevented, true);
  assert.ok(w.card.classList.contains("snatched") && w.section.classList.contains("gc-snatching"));
  assert.equal(w.timers.length, 1, "a timeout fallback is armed");
  assert.ok(w.timers[0].ms >= 1200 && w.timers[0].ms <= 1600, "about 1.5 s");
  w.click(); // a second click while it runs
  w.card.fire("animationend", { target: {}, animationName: "gc-grab" }); // a child's animation does not navigate
  assert.deepEqual(w.win.navigations, []);
  w.card.fire("animationend", { target: w.card, animationName: "gc-snatch" });
  w.timers[0].f();
  w.card.fire("animationend", { target: w.card, animationName: "gc-snatch" });
  assert.deepEqual(w.win.navigations, [URL_AG], "once, to the exact URL");
});

test("the timeout alone navigates if animationend never comes", () => {
  const w = world();
  w.click();
  w.timers[0].f();
  assert.deepEqual(w.win.navigations, [URL_AG]);
});

test("Ctrl/Cmd/Shift/Alt clicks, middle clicks, links with a target and already-handled clicks are left to the browser", () => {
  for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }]) {
    const w = world();
    const e = w.click(mod);
    assert.equal(mod.defaultPrevented ? true : e.defaultPrevented, mod.defaultPrevented ? true : false, JSON.stringify(mod));
    assert.ok(!w.card.classList.contains("snatched"), JSON.stringify(mod));
    assert.equal(w.timers.length, 0);
  }
  for (const attrs of [{ target: "_blank" }, { download: "" }]) {
    const w = world({ attrs });
    assert.equal(w.click().defaultPrevented, false, JSON.stringify(attrs));
  }
  assert.equal(C.shouldSnatch({ button: 0 }, { getAttribute: () => "https://agensi.io.evil.com/skills/x", hasAttribute: () => false }, false), false, "only Agensi skill links");
});

test("reduced motion: the click is not touched, so the browser navigates immediately with no animation", () => {
  const w = world({ reduce: true });
  const e = w.click();
  assert.equal(e.defaultPrevented, false);
  assert.ok(!w.card.classList.contains("snatched"));
  assert.equal(w.timers.length, 0);
  assert.match(html, /\.getcard\.snatched \.ac-stage\{[^}]*animation:gc-snatch/);
});

test("Back from Agensi (bfcache pageshow, persisted) resets the card, and it can snatch again", () => {
  const w = world();
  w.click();
  w.win.fire("pageshow", { persisted: false });
  assert.ok(w.card.classList.contains("snatched"), "a normal pageshow changes nothing");
  w.win.fire("pageshow", { persisted: true });
  assert.ok(!w.card.classList.contains("snatched") && !w.section.classList.contains("gc-snatching"));
  w.click();
  w.timers[1].f();
  assert.equal(w.win.navigations.length, 1);
});

test("no Polar where the site talks about buying, checkout, billing, refunds or who takes payment", () => {
  for (const f of ["index.html", "terms.html", "refunds.html", "privacy.html", "contact.html", "checkout.js", "checkout.config.js"]) {
    const t = site(f).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const s of t.split(/(?<=[.!?])\s/)) {
      if (!/polar/i.test(s)) continue;
      assert.doesNotMatch(s, /\b(buy|bought|purchase|checkout|billing|payment|pay|refund|merchant|order|plan)/i, `${f}: "${s}"`);
    }
    assert.doesNotMatch(site(f), /polar\.sh(?!\))|\(Pro and Team\)|Pro or Team/, f);
  }
  // what the released CLI does is still disclosed: activate/renew/deactivate send the key and the machine name to Polar
  assert.match(site("privacy.html"), /sends your license key and your computer's name to Polar's license-key service \(api\.polar\.sh\)/);
});

// ---- the collectible card (a rotating, decorative card; Buy stays outside it) ----
const getSec = html.slice(html.indexOf('<article class="getcard"'), html.indexOf("</article>", html.indexOf('<article class="getcard"')));
const stage = getSec.slice(getSec.indexOf('<div class="ac-stage"'), getSec.indexOf('<span class="gc-sea"'));

test("the turning card is decoration; Buy and Install sit below it, outside every rotating face", () => {
  assert.match(getSec, /<div class="ac-stage" aria-hidden="true">/);
  assert.doesNotMatch(stage, /<a\b|<button\b|tabindex/, "nothing clickable or focusable turns with the card");
  assert.ok(getSec.indexOf('<div class="gc-buy">') > getSec.indexOf('<span class="gc-sea"'), "the buttons come after the card and its water line");
  assert.match(getSec, /<p class="gc-price">\$3<\/p>/, "the price is plain text");
  assert.match(getSec, /<article class="getcard" aria-labelledby="getName">/);
  for (const face of ["ac-front", "ac-back"]) assert.ok(stage.includes(`ac-face ${face}`), face);
  assert.match(html, /\.ac-face\{[^}]*backface-visibility:hidden/, "each face hides its back");
  assert.match(html, /\.ac-back\{transform:rotateY\(180deg\)\}/, "the back is turned, so its text is not mirrored");
});

test("the card back holds only true facts, and they match the source", async () => {
  const { DEFAULT_RULES } = await import(new URL("../dist/rules.js", import.meta.url).href);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8").replace(/\s+/g, " ");
  const stats = (s) => Object.fromEntries([...s.matchAll(/<dt>([^<]+)<\/dt><dd>([^<]+)<\/dd>/g)].map((m) => [m[1], m[2]]));
  const back = stats(stage), list = stats(getSec.slice(getSec.indexOf('<details class="gc-stats">')));
  assert.deepEqual(back, list, "the card back and the readable stats list say the same");
  assert.equal(back["Default rules"], String(DEFAULT_RULES.length), "the default rule count is the built-in DEFAULT_RULES");
  assert.equal(back.License, pkg.license);
  assert.equal(back.Agents, "Claude Code &middot; Hermes");
  assert.match(readme, /in front of \*\*Claude Code\*\* and \*\*Hermes Agent\*\*/);
  assert.match(readme, /Everything runs on your machine/);
  assert.equal(back["This skill"], "$3");
  assert.ok(stage.includes("It helps your agent install, check and tune Cephalo, which is free and open source. It includes no Pro features or license key."));
  assert.match(stage, /v0\.3\.0 edition/);
  assert.equal(pkg.version, "0.3.0", "the edition label names the current version");
  assert.doesNotMatch(getSec, /NBA|All-?Star|limited|rare\b|#\d+\s*\/\s*\d+|serial/i, "no league names, no scarcity claims");
});

test("the turn: slow, paused off screen, never under reduced motion", () => {
  const H = html.replace(/\r\n/g, "\n");
  const motion = H.slice(H.indexOf("@media (prefers-reduced-motion:no-preference){\n  .ac-card{"));
  assert.match(motion, /^@media \(prefers-reduced-motion:no-preference\)\{\n  \.ac-card\{animation:ac-spin (\d+)s linear infinite;animation-play-state:var\(--octo-run\)\}/);
  const secs = Number(/ac-spin (\d+)s/.exec(motion)[1]);
  assert.ok(secs >= 8 && secs <= 12, `${secs} s per turn`);
  assert.doesNotMatch(H.replace(motion, ""), /animation:ac-spin/, "the spin is declared only for no-preference");
});

test("hover and focus turn the card to the front and hold it; leaving resumes the turn; a click turns it front first", () => {
  const ls = (o) => { o.on = {}; o.addEventListener = (t, f) => (o.on[t] ||= []).push(f); o.fire = (t, e) => (o.on[t] || []).forEach((f) => f(e)); return o; };
  const cls = () => { const s = new Set(); return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) }; };
  const props = {};
  const spin = { style: { setProperty(k, v) { props[k] = String(v); }, removeProperty(k) { delete props[k]; } }, offsetWidth: 0 };
  const link = ls({ href: URL_AG, getAttribute: (k) => ({ href: URL_AG })[k] ?? null, hasAttribute: () => false });
  const card = ls({ classList: cls(), parentNode: { parentNode: { classList: cls() } }, contains: () => false, querySelector: (q) => (q.includes("ac-card") ? spin : link) });
  let now = 0.8;
  const win = ls({ location: { assign() {} }, matchMedia: () => ({ matches: false }), setTimeout: () => 1, clearTimeout() {}, getComputedStyle: () => ({ getPropertyValue: () => String(now) }) });
  C.tentacle({ querySelector: () => card }, win);
  card.fire("mouseenter", {});
  assert.equal(props["--ac-t"], "1", "0.8 of a turn eases on to the front (a full turn)");
  assert.match(spin.style.transition, /--ac-t \d+ms/);
  assert.equal(spin.style.animation, "none", "the turn holds while hovered");
  card.fire("mouseleave", {});
  assert.equal(props["--ac-t"], undefined);
  assert.equal(spin.style.animation, "", "the turn resumes, from the front");
  now = 0.3;
  card.fire("focusin", {});
  assert.equal(props["--ac-t"], "0", "0.3 of a turn eases back to the front");
  card.fire("focusout", { relatedTarget: null });
  now = 1.6;
  link.fire("click", { button: 0, preventDefault() {} });
  assert.equal(props["--ac-t"], "1", "a snatch starts from the front (1.6 turns -> 0.6 -> the next front)");
  card.fire("mouseleave", {});
  assert.equal(props["--ac-t"], "1", "while snatched, leaving does not restart the turn");
});
