#!/usr/bin/env node
// Keeps the rule data embedded in site/index.html (the live playground) identical to the built CLI.
//   node scripts/site-rules.mjs           rewrite the data between /*RULES_JSON*/ and /*END_RULES_JSON*/
//   node scripts/site-rules.mjs --check   exit 1 if the page is out of date (used by the tests)
// Needs `npm run build` first: the data is read from dist/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = path.join(root, "site", "index.html");
const START = "/*RULES_JSON*/";
const END = "/*END_RULES_JSON*/";

/** The data the page needs, built from the compiled CLI. Never retype patterns by hand. */
export async function buildRulesData() {
  const { DEFAULT_RULES } = await import(pathToFileURL(path.join(root, "dist", "rules.js")).href);
  const { getPlatform } = await import(pathToFileURL(path.join(root, "dist", "platform.js")).href);
  const { SYSTEM_RULES } = await import(pathToFileURL(path.join(root, "dist", "platform-rules.js")).href);
  const locked = new Set(SYSTEM_RULES.map((r) => r.id));
  // l: 1 marks Cephalo's own protections: an `allow` rule cannot exempt a call from them
  const slim = (r, extra) => ({ id: r.id, d: r.description, t: r.type, ...(r.type === "path" ? { on: r.on ?? "any" } : {}), p: r.pattern, ...(locked.has(r.id) ? { l: 1 } : {}), ...extra });
  const data = { defaults: DEFAULT_RULES.map((r) => slim(r, { o: "default" })) };
  // These rules are built from the folder Cephalo is installed in (an absolute path on the machine that built them), so the page leaves them out.
  const installBound = new Set(["protect-cephalo-install", "no-install-tamper", "no-protected-write-code", "no-protected-symlink"]);
  for (const os of ["win32", "darwin", "linux"]) data[os] = getPlatform(os).rules().filter((r) => !installBound.has(r.id)).map((r) => slim(r, { o: "platform", os }));
  return data;
}

export function embedded(html) {
  const i = html.indexOf(START);
  const j = html.indexOf(END);
  if (i < 0 || j < i) throw new Error("rule data markers not found in site/index.html");
  return { before: html.slice(0, i + START.length), json: html.slice(i + START.length, j), after: html.slice(j) };
}

export async function main(argv = process.argv.slice(2)) {
  const html = fs.readFileSync(page, "utf8");
  const crlf = html.includes("\r\n");
  const { before, json, after } = embedded(html);
  const next = JSON.stringify(await buildRulesData());
  if (json === next) {
    console.log("site/index.html rule data is current.");
    return 0;
  }
  if (argv.includes("--check")) {
    console.log("site/index.html rule data is out of date. Run: node scripts/site-rules.mjs");
    return 1;
  }
  fs.writeFileSync(page, before + next + after, "utf8");
  console.log(`Updated the rule data in site/index.html${crlf ? " (the page uses CRLF line endings; the data is one line, so none were changed)" : ""}.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
