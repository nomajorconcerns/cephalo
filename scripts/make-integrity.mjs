#!/usr/bin/env node
// Writes dist/integrity.json: a SHA-256 for every compiled file the hook runs (dist/tests is left out).
// `cephalo doctor` and the hook's first call in a session compare the installed files against it.
// It is a check for accidents and for an agent that edited dist/ some way the path rules missed; someone who can edit
// dist/ as you can also edit this file, so it is not a signature. It runs as the last step of `npm run build`.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const MANIFEST = "integrity.json";

function walk(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (r === "tests") continue;
      out.push(...walk(path.join(dir, e.name), r));
    } else if (e.isFile() && r !== MANIFEST) out.push(r);
  }
  return out;
}

export function buildManifest() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const files = {};
  for (const rel of walk(dist).sort()) files[rel] = crypto.createHash("sha256").update(fs.readFileSync(path.join(dist, rel))).digest("hex");
  return { name: pkg.name, version: pkg.version, algorithm: "sha256", files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = buildManifest();
  fs.writeFileSync(path.join(dist, MANIFEST), JSON.stringify(m, null, 2) + "\n");
  console.log(`integrity: ${Object.keys(m.files).length} files hashed into dist/${MANIFEST}`);
}
