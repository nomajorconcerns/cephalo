// The buy links: Cephalo itself is free, so the only things for sale are skills on Agensi. checkout.js carries no plan
// checkout code, the config holds only the skill links, and the page loads both. (The Agensi allowlist and its
// look-alike rejection are tested in sentrykit-site.test.mjs.)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = (f) => fs.readFileSync(path.join(root, "site", f), "utf8");
const sandbox = { module: { exports: {} }, URL };
vm.runInNewContext(site("checkout.js"), sandbox);
const C = sandbox.module.exports;

test("checkout.js only checks skill links: no plan checkout, no Polar, no 'Not on sale' code left", () => {
  assert.deepEqual(Object.keys(C).sort(), ["applySkills", "skillUrl"]);
  const js = site("checkout.js");
  assert.doesNotMatch(js, /polar|data-plan|Not on sale|Subscribe|mailto|plans/i);
});

test("the shipped config holds only Agensi skill links, each one the allowlist accepts", () => {
  const ctx = { window: {} };
  vm.runInNewContext(site("checkout.config.js"), ctx);
  const cfg = ctx.window.CEPHALO_CHECKOUT;
  assert.deepEqual(Object.keys(cfg), ["skills"], "no mode, provider, plans or billing portal");
  for (const [name, url] of Object.entries(cfg.skills)) assert.equal(C.skillUrl(url), url, name);
  assert.doesNotMatch(site("checkout.config.js"), /polar|plans|billing/i);
});

test("the page loads the config before checkout.js, and the Pages workflow publishes both", () => {
  const html = site("index.html");
  assert.match(html, /<script src="checkout\.config\.js"><\/script>\s*<script src="checkout\.js" defer><\/script>/);
  assert.doesNotMatch(html, /data-plan=|Not on sale/);
  const wf = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  assert.match(wf, /cp [^\n]*checkout\.config\.js[^\n]*checkout\.js[^\n]* _site\//, "the Pages workflow publishes the checkout files");
});
