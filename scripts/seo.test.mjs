// Search-engine markup on the website: the JSON-LD says only what the page says, the head tags are complete and not
// duplicated, the page has one h1, and the sitemap lists real, deployed pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildJsonLd, embedded, faqEntries, freeOffer, render, SITE_URL } from "./site-seo.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

test("the JSON-LD in the page is exactly what the page's own content generates (run: node scripts/site-seo.mjs)", () => {
  assert.equal(embedded(html).inner, render(buildJsonLd(html, version)));
  assert.deepEqual(ld.map((o) => o["@type"]), ["SoftwareApplication", "FAQPage"], "every block is valid JSON");
});

test("SoftwareApplication: Cephalo is free ($0, one offer), the current version, npm download; no plan offers", () => {
  const app = ld[0];
  assert.equal(app.applicationCategory, "DeveloperApplication");
  assert.equal(app.softwareVersion, version);
  assert.equal(app.operatingSystem, "Windows, macOS, Linux");
  assert.equal(app.downloadUrl, "https://www.npmjs.com/package/@nomajorconcerns/cephalo");
  assert.equal(app.isAccessibleForFree, true);
  assert.deepEqual(app.offers, [{ "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD", url: `${SITE_URL}#install` }]);
  assert.doesNotMatch(JSON.stringify(ld), /Not on sale|"Pro"|"Team"|dev per month|"price":"3"/, "no removed plans, and the $3 skill is not a Cephalo offer");
  // the offer exists only because the page says Cephalo is free; if that sentence goes, generating fails
  assert.throws(() => freeOffer(html.replace("Cephalo is free and open source (MIT) on npm", "Cephalo is on npm")), /no longer says Cephalo is free/);
});

test("FAQPage holds every FAQ entry on the page, word for word", () => {
  const faq = ld[1].mainEntity;
  const onPage = faqEntries(html);
  assert.equal(faq.length, (html.slice(html.indexOf('<section id="faq">')).match(/<details\b/g) || []).length);
  assert.deepEqual(faq.map((q) => [q.name, q.acceptedAnswer.text]), onPage.map((e) => [e.q, e.a]));
  assert.ok(faq.every((q) => q.name.endsWith("?") && q.acceptedAnswer.text.length > 20));
  assert.doesNotMatch(JSON.stringify(ld), /<\/script/i, "nothing in the data can close the script tag");
});

test("head: one title and description of search-friendly length, canonical, Open Graph, Twitter card, theme-color, lang", () => {
  const one = (re, what) => assert.equal((html.match(re) || []).length, 1, `exactly one ${what}`);
  one(/<title>/g, "title");
  one(/<meta name="description"/g, "description");
  one(/<link rel="canonical"/g, "canonical");
  const title = /<title>([^<]*)<\/title>/.exec(html)[1];
  const desc = /<meta name="description" content="([^"]*)"/.exec(html)[1];
  assert.ok([...title].length >= 50 && [...title].length <= 65, `title is ${[...title].length} characters`);
  assert.ok([...desc].length >= 120 && [...desc].length <= 160, `description is ${[...desc].length} characters`);
  assert.match(html, /<html lang="en">/);
  assert.match(html, new RegExp(`<link rel="canonical" href="${SITE_URL}">`));
  for (const p of ["og:title", "og:description", "og:url", "og:image", "og:image:alt", "og:type", "og:site_name"]) one(new RegExp(`property="${p}"`, "g"), p);
  for (const n of ["twitter:card", "twitter:title", "twitter:description", "twitter:image", "twitter:image:alt"]) one(new RegExp(`name="${n}"`, "g"), n);
  assert.match(html, /<meta property="og:image" content="https:\/\/nomajorconcerns\.github\.io\/cephalo\/og\.png">/);
  assert.ok(fs.existsSync(path.join(root, "site", "og.png")));
  assert.equal((html.match(/name="theme-color"/g) || []).length, 2, "one for dark, one for light");
});

test("headings: exactly one h1, and no level is skipped going down", () => {
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  assert.equal(levels.filter((l) => l === 1).length, 1);
  assert.equal(levels[0], 1, "the h1 comes first");
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] <= levels[i - 1] + 1, `h${levels[i - 1]} is followed by h${levels[i]}`);
});

test("sitemap.xml lists the home page and the legal pages, each a real deployed file; robots.txt points to it", () => {
  const sm = fs.readFileSync(path.join(root, "site", "sitemap.xml"), "utf8");
  assert.match(sm, /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, [SITE_URL, ...["privacy", "terms", "refunds", "contact"].map((p) => `${SITE_URL}${p}.html`)]);
  assert.equal((sm.match(/<url>/g) || []).length, (sm.match(/<\/url>/g) || []).length);
  for (const d of sm.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) assert.match(d[1], /^\d{4}-\d{2}-\d{2}$/);
  const wf = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  for (const loc of locs) {
    const file = loc === SITE_URL ? "index.html" : loc.slice(SITE_URL.length);
    assert.ok(fs.existsSync(path.join(root, "site", file)), `${file} exists`);
    assert.ok(wf.includes(`site/${file}`), `pages.yml deploys site/${file}`);
  }
  for (const f of ["sitemap.xml", "robots.txt"]) {
    assert.ok(new RegExp(`cp [^\\n]*site/${f.replace(".", "\\.")}[^\\n]* _site/`).test(wf), `pages.yml copies site/${f}`);
    assert.ok(wf.includes(`- "site/${f}"`), `pages.yml paths lists site/${f}`);
  }
  assert.match(fs.readFileSync(path.join(root, "site", "robots.txt"), "utf8"), new RegExp(`^Sitemap: ${SITE_URL}sitemap\\.xml$`, "m"));
});

test("the Google Search Console verification file is exactly what Google issued, deployed, LF, and not in the sitemap", () => {
  const name = "googlecc7b0a59e198f98b.html";
  const bytes = fs.readFileSync(path.join(root, "site", name));
  assert.equal(bytes.toString("utf8"), `google-site-verification: ${name}\n`, "one line, no markup, LF");
  const wf = fs.readFileSync(path.join(root, ".github", "workflows", "pages.yml"), "utf8");
  assert.ok(new RegExp(`cp [^\\n]*site/${name.replace(".", "\\.")}[^\\n]* _site/`).test(wf), "pages.yml copies it");
  assert.ok(wf.includes(`- "site/${name}"`), "pages.yml paths lists it");
  assert.match(fs.readFileSync(path.join(root, ".gitattributes"), "utf8"), /^site\/google\*\.html text eol=lf$/m, "kept LF on every checkout");
  assert.ok(!fs.readFileSync(path.join(root, "site", "sitemap.xml"), "utf8").includes(name), "a verification file is not a page to index");
});
