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
  assert.match(html, /\.gc-buywrap:has\(a:focus-visible\) \.gc-tent/, "keyboard focus shows the tentacle too");
});

test("a plain click (or Enter) plays the snatch, then navigates exactly once to the exact URL", () => {
  const w = world();
  const e = w.click();
  assert.equal(e.defaultPrevented, true);
  assert.ok(w.card.classList.contains("snatched") && w.section.classList.contains("gc-snatching"));
  assert.equal(w.timers.length, 1, "a timeout fallback is armed");
  assert.ok(w.timers[0].ms >= 900 && w.timers[0].ms <= 1500);
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
  assert.match(html, /\.getcard\.snatched\{[^}]*animation:gc-snatch/);
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
