// The buy buttons: inert unless the config says otherwise, and never a link to a host we did not intend.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// site/checkout.js is a browser script (the package is "type": "module"), so load it the way a browser would
const sandbox = { module: { exports: {} }, URL };
vm.runInNewContext(fs.readFileSync(path.join(root, "site", "checkout.js"), "utf8"), sandbox);
const C = sandbox.module.exports;
const plain = (x) => JSON.parse(JSON.stringify(x)); // objects made inside the vm have another Object prototype
const LIVE = "https://buy.polar.sh/polar_cl_aaaabbbb";
const TEST = "https://buy.polar.sh/polar_cl_test1111";
const cfg = (over = {}) => ({ mode: "off", provider: "Polar", plans: { pro: { test: TEST, live: LIVE }, team: { test: TEST, live: LIVE }, enterprise: { email: "" } }, billing: "", ...over });

test("only https links on Polar's own hosts (buy.polar.sh, polar.sh) are accepted", () => {
  assert.equal(C.checkoutUrl(LIVE), LIVE);
  assert.equal(C.checkoutUrl("https://polar.sh/nomajorconcerns/portal"), "https://polar.sh/nomajorconcerns/portal", "the customer portal");
  for (const bad of ["", undefined, null, 5, "http://buy.polar.sh/x", "https://evil-polar.sh/x", "https://buy.polar.sh.evil.com/x", "https://evil.polar.sh/x", "https://user:pw@buy.polar.sh/x", "https://buy.polar.sh:8443/x", "javascript:alert(1)", "//buy.polar.sh/x", "https://cephalo.lemonsqueezy.com/buy/x", "not a url"]) {
    assert.equal(C.checkoutUrl(bad), null, String(bad));
  }
});

test("off: every paid plan stays 'Not on sale yet', even with links filled in and ?checkout=test", () => {
  for (const plan of ["pro", "team"]) {
    assert.deepEqual(plain(C.resolve(cfg(), plan, "")), { kind: "inert", label: "Not on sale yet" });
    assert.equal(C.resolve(cfg(), plan, "?checkout=test").kind, "inert");
  }
});

test("test: visitors see nothing; ?checkout=test shows labelled test links", () => {
  const c = cfg({ mode: "test" });
  assert.equal(C.resolve(c, "pro", "").kind, "inert");
  assert.equal(C.resolve(c, "pro", "?ref=x").kind, "inert");
  const r = C.resolve(c, "pro", "?a=1&checkout=test");
  assert.deepEqual([r.kind, r.href, r.test], ["link", TEST, true]);
  assert.match(r.label, /no real charge/);
  assert.equal(C.resolve(cfg({ mode: "test", plans: { pro: { test: "", live: LIVE } } }), "pro", "?checkout=test").kind, "inert", "a missing test link never falls back to the live one");
});

test("live: working links; a missing or foreign link stays inert", () => {
  const c = cfg({ mode: "live" });
  assert.deepEqual([C.resolve(c, "pro", "").kind, C.resolve(c, "pro", "").href], ["link", LIVE]);
  assert.equal(C.resolve(c, "team", "").label, "Subscribe to Team");
  assert.equal(C.resolve(cfg({ mode: "live", plans: { pro: { live: "https://evil.example/x" } } }), "pro", "").kind, "inert");
  assert.equal(C.resolve(cfg({ mode: "live", plans: { pro: { live: "" } } }), "pro", "").kind, "inert");
  assert.equal(C.resolve(null, "pro", "").kind, "inert");
});

test("enterprise is a contact button in any mode once an email is set; a bad email is ignored", () => {
  for (const mode of ["off", "test", "live"]) {
    const r = C.resolve(cfg({ mode, plans: { enterprise: { email: "sales@example.com" } } }), "enterprise", "");
    assert.deepEqual([r.kind, r.label], ["mail", "Contact us"]);
    assert.match(r.href, /^mailto:sales@example\.com\?subject=Cephalo%20Enterprise$/);
  }
  for (const email of ["", "nope", "a b@c.d", 'x"@y.z', undefined]) assert.equal(C.resolve(cfg({ plans: { enterprise: { email } } }), "enterprise", "").kind, "inert", String(email));
});

test("page copy changes only when something is really for sale, and says plainly that paying unlocks nothing yet", () => {
  const inert = { kind: "inert" };
  assert.deepEqual(plain(C.copy(cfg(), [inert, inert])), { head: null, note: null });
  const live = C.copy(cfg({ mode: "live" }), [{ kind: "link" }, inert]);
  assert.match(live.head, /Everything in version 0\.1\.1 stays free/);
  assert.match(live.note, /Nothing checks a licence today/);
  assert.match(live.note, /CEPHALO/);
  assert.match(live.note, /Polar/);
    assert.match(C.copy(cfg({ mode: "test" }), [{ kind: "link", test: true }]).banner, /charges nothing|charge nothing/);
});

// a tiny DOM, enough for apply()
function fakeDoc(plans) {
  const mk = (tag) => ({ tag, attrs: {}, children: [], className: "", textContent: "", setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, appendChild(c) { this.children.push(c); c.parentNode = this; return c; }, replaceChild(n, o) { n.parentNode = this; this.children[this.children.indexOf(o)] = n; } });
  const parent = mk("div");
  const buttons = plans.map((p) => { const b = mk("span"); b.attrs["data-plan"] = p; b.textContent = "Not on sale yet"; parent.appendChild(b); return b; });
  const head = mk("p"), note = mk("p");
  note.parentNode = { insertBefore(n, ref) { (this.log ??= []).push(["before", n]); }, log: [] };
  return { parent, buttons, head, note, createElement: mk, createTextNode: (t) => ({ text: t }), querySelectorAll: () => buttons, querySelector: (q) => (q.includes("sec-head") ? head : q.includes("pricenote") ? note : null) };
}

test("apply: swaps only the buttons that resolve to a link, and rewrites the two sentences when live", () => {
  const d = fakeDoc(["pro", "team", "enterprise"]);
  C.apply(d, cfg({ mode: "live", plans: { pro: { live: LIVE }, team: { live: "" }, enterprise: { email: "" } } }), "");
  const [pro, team, ent] = d.parent.children;
  assert.deepEqual([pro.tag, pro.href, pro.className, pro.rel], ["a", LIVE, "btn primary", "noopener"]);
  assert.equal(team.tag, "span");
  assert.equal(team.textContent, "Not on sale yet");
  assert.equal(ent.tag, "span");
  assert.match(d.head.textContent, /Launching Nov 10/);
  assert.match(d.note.textContent, /Nothing checks a licence today/);
  const off = fakeDoc(["pro", "team", "enterprise"]);
  C.apply(off, cfg(), "");
  assert.ok(off.parent.children.every((c) => c.tag === "span"));
  assert.equal(off.head.textContent, "");
});

test("the shipped config is valid, and the page, workflow and config line up", () => {
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "site", "checkout.config.js"), "utf8"), ctx);
  const shipped = ctx.window.CEPHALO_CHECKOUT;
  assert.ok(["off", "test", "live"].includes(shipped.mode));
  for (const p of ["pro", "team"]) for (const k of ["test", "live"]) assert.ok(shipped.plans[p][k] === "" || C.checkoutUrl(shipped.plans[p][k]), `${p}.${k} must be empty or a Polar https link`);
  assert.equal(shipped.provider, "Polar");
  assert.equal(shipped.mode, "off", "nothing is on sale until the Polar store is set up");
  for (const p of ["pro", "team"]) assert.deepEqual([shipped.plans[p].test, shipped.plans[p].live], ["", ""], `${p} links stay empty for now`);
  assert.ok(shipped.billing === "" || C.checkoutUrl(shipped.billing));
  const html = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
  const inertText = { pro: "Launching Nov 10", team: "Launching Nov 10", enterprise: "Not on sale yet" };
  for (const p of ["pro", "team", "enterprise"]) assert.match(html, new RegExp(`class="btn soon" data-plan="${p}">${inertText[p]}</span>`), `${p} button default is inert`);
  assert.match(html, /<script src="checkout\.config\.js"><\/script>\s*<script src="checkout\.js" defer><\/script>/);
  const wf = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  assert.match(wf, /cp [^\n]*checkout\.config\.js[^\n]*checkout\.js[^\n]* _site\//, "the Pages workflow publishes the checkout files");
  if (shipped.mode === "off") assert.match(html, /Pro and Team are not for sale yet/);
});
