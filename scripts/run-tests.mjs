#!/usr/bin/env node
// Runs the compiled unit tests (dist/tests/*.test.js) with node's test runner.
// The files are listed here rather than left to a shell glob: Windows PowerShell does not expand
// `dist/tests/*.test.js`, and Node 20's `--test` does not either (globs arrived in Node 21).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "tests");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort().map((f) => path.join(dir, f)) : [];
if (files.length === 0) {
  console.error(`No compiled tests in ${dir}. Run: npm run build`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
