#!/usr/bin/env node
// Keeps the structured data (JSON-LD) in site/index.html identical to what the page itself says.
//   node scripts/site-seo.mjs           rewrite the JSON-LD between <!--JSONLD--> and <!--END_JSONLD-->
//   node scripts/site-seo.mjs --check   exit 1 if it is out of date (used by the tests)
// The FAQPage comes from the page's FAQ section, the offers from its plan cards, the version from package.json.
// Nothing is typed in by hand, so the markup cannot claim more than the page does.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PAGE = path.join(root, "site", "index.html");
export const SITE_URL = "https://nomajorconcerns.github.io/cephalo/";
const START = "<!--JSONLD-->";
const END = "<!--END_JSONLD-->";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "\u2019", lsquo: "\u2018", ldquo: "\u201c",
  rdquo: "\u201d", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", middot: "\u00b7", rarr: "\u2192", times: "\u00d7" };

/** Visible text of an HTML fragment: tags removed, entities decoded, whitespace collapsed. */
export function text(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

export function section(html, id) {
  const i = html.indexOf(`<section id="${id}"`);
  if (i < 0) throw new Error(`section #${id} not found in site/index.html`);
  return html.slice(i, html.indexOf("</section>", i));
}

/** [{q, a}] from the FAQ section's <details><summary>…</summary><div class="ans">…</div></details>. */
export function faqEntries(html) {
  return [...section(html, "faq").matchAll(/<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>\s*<div class="ans">([\s\S]*?)<\/div>\s*<\/details>/g)]
    .map((m) => ({ q: text(m[1]), a: text(m[2]) }));
}

/** {Free: "$0", Pro: "$15 / dev / month", ...} as the plan cards show them, plus each card's button text. */
export function plans(html) {
  const out = {};
  for (const m of section(html, "pricing").matchAll(/<div class="tier(?: hl)?">([\s\S]*?)(?=<div class="tier|<div class="calc|$)/g)) {
    const name = text((m[1].match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1] || "");
    const price = text((m[1].match(/class="price[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|span)>/) || [])[1] || "");
    const soon = /<span class="btn soon"[^>]*>([\s\S]*?)<\/span>/.exec(m[1]);
    if (name) out[name] = { price, note: soon ? text(soon[1]) : "" };
  }
  return out;
}

function offer(name, p) {
  const m = /^\$(\d+(?:\.\d+)?)\s*(?:\/\s*dev\s*\/\s*month)?$/.exec(p.price);
  if (!m) return null; // "Annual contract" has no list price: left out rather than guessed
  const perDevMonth = /\/\s*dev\s*\/\s*month/.test(p.price);
  return {
    "@type": "Offer",
    name,
    price: m[1],
    priceCurrency: "USD",
    ...(perDevMonth
      ? { priceSpecification: { "@type": "UnitPriceSpecification", price: m[1], priceCurrency: "USD", unitText: "per developer per month", billingDuration: "P1M" } }
      : {}),
    ...(p.note ? { description: p.note } : {}),
    url: `${SITE_URL}#pricing`,
  };
}

export function buildJsonLd(html, version) {
  const p = plans(html);
  const app = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Cephalo",
    description: text((/<meta name="description" content="([^"]*)"/.exec(html) || [])[1] || ""),
    url: SITE_URL,
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Security",
    operatingSystem: "Windows, macOS, Linux",
    softwareVersion: version,
    softwareRequirements: "Node.js 20 or newer",
    downloadUrl: "https://www.npmjs.com/package/@nomajorconcerns/cephalo",
    installUrl: "https://www.npmjs.com/package/@nomajorconcerns/cephalo",
    license: "https://opensource.org/licenses/MIT",
    isAccessibleForFree: true,
    image: `${SITE_URL}og.png`,
    sameAs: ["https://github.com/nomajorconcerns/cephalo", "https://www.npmjs.com/package/@nomajorconcerns/cephalo"],
    offers: Object.entries(p).map(([name, v]) => offer(name, v)).filter(Boolean),
  };
  const faq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqEntries(html).map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };
  return [app, faq];
}

/** The exact markup placed between the markers: one script tag per object, "<" escaped so it cannot close the tag.
 *  All on one line: a line break here would become CRLF in a Windows checkout (core.autocrlf) and the byte check
 *  against the generated markup would fail there while passing on Linux. */
export function render(objects) {
  return objects.map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`).join("");
}

export function embedded(html) {
  const i = html.indexOf(START);
  const j = html.indexOf(END);
  if (i < 0 || j < i) throw new Error("JSON-LD markers not found in site/index.html");
  return { before: html.slice(0, i + START.length), inner: html.slice(i + START.length, j), after: html.slice(j) };
}

export function main(argv = process.argv.slice(2)) {
  const html = fs.readFileSync(PAGE, "utf8");
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const { before, inner, after } = embedded(html);
  const next = render(buildJsonLd(html, version));
  if (inner === next) {
    console.log("site/index.html JSON-LD is current.");
    return 0;
  }
  if (argv.includes("--check")) {
    console.log("site/index.html JSON-LD is out of date. Run: node scripts/site-seo.mjs");
    return 1;
  }
  fs.writeFileSync(PAGE, before + next + after, "utf8");
  console.log("Updated the JSON-LD in site/index.html.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
