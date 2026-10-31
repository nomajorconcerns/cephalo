#!/usr/bin/env node
/**
 * Release preparation for Cephalo. It builds a verifiable release folder; it NEVER publishes anything.
 *
 *   node scripts/release.mjs check [--quick] [--allow-dirty] [--tag vX.Y.Z]
 *   node scripts/release.mjs pack  [--sign auto|required|off] [--out DIR] [--allow-dirty] [--skip-tests] [--tag vX.Y.Z]
 *   node scripts/release.mjs verify DIR [--identity RE --issuer URL]
 *
 * pack writes release/<name>-<version>/ with the .tgz, SHA256SUMS (sha256sum -c compatible) and, when cosign is
 * available, SHA256SUMS.sigstore.json (a keyless Sigstore signature of the checksum file). It then PRINTS the publish
 * command for you to run with your own login.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SUMS = "SHA256SUMS";
export const BUNDLE = "SHA256SUMS.sigstore.json";
export const REPO_URL_RE = /^git\+https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/;

/* ------------------------------------------------------------------ small helpers */

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

/** One line per file in the format `sha256sum -c` reads: "<hex>  <name>" (two spaces, name without a directory). */
export function sumsText(entries) {
  return entries
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((e) => `${e.hash}  ${e.name}\n`)
    .join("");
}

export function parseSums(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`not a SHA256SUMS line: ${JSON.stringify(line.slice(0, 80))}`);
    if (/[\\/]/.test(m[2]) || m[2] === ".." || m[2] === ".") throw new Error(`SHA256SUMS names must be plain file names, got ${JSON.stringify(m[2])}`);
    out.push({ hash: m[1], name: m[2] });
  }
  if (!out.length) throw new Error("SHA256SUMS is empty");
  return out;
}

/** Re-hash every file named in SHA256SUMS. Returns one result per line; nothing is trusted from the file but the expected hashes. */
export function verifySums(dir) {
  const entries = parseSums(fs.readFileSync(path.join(dir, SUMS), "utf8"));
  return entries.map((e) => {
    const f = path.join(dir, e.name);
    if (!fs.existsSync(f)) return { ...e, ok: false, reason: "file is missing" };
    const actual = sha256File(f);
    return actual === e.hash ? { ...e, ok: true } : { ...e, ok: false, reason: `hash is ${actual}` };
  });
}

/** Run a program with fixed arguments. On Windows npm is a .cmd shim, which needs a shell; arguments here are never user text. */
export function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { cwd: o.cwd, encoding: "utf8", shell: process.platform === "win32" && ["npm", "npx"].includes(cmd), stdio: o.inherit ? "inherit" : "pipe", env: process.env, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

/* ------------------------------------------------------------------ checks on what would be packed */

const FORBIDDEN = [
  [/^src\//, "source files (only the built dist/ should ship)"],
  [/^site\//, "the website"],
  [/^dist\/tests\//, "compiled tests"],
  [/(^|\/)\.env(\.|$)/i, "an environment file"],
  [/(^|\/)(id_rsa|id_ed25519)(\.pub)?$|\.pem$|\.key$/i, "key material"],
  [/\.(map)$/i, "source maps"],
  [/(^|\/)(audit\.jsonl|vault\.json|vault\.key)$/i, "Cephalo user data"],
  [/^tsconfig\.json$/, "build config"],
  [/^release\//, "a release folder"],
];
const REQUIRED = ["package.json", "README.md", "LICENSE", "dist/cli.js"];

export function checkPackList(paths) {
  const problems = [];
  for (const p of paths) for (const [re, why] of FORBIDDEN) if (re.test(p)) problems.push(`the package would include ${p}: ${why}`);
  for (const r of REQUIRED) if (!paths.includes(r)) problems.push(`the package is missing ${r}`);
  return problems;
}

/** Look for credentials in the files that would ship, using the same detector the vault uses. Needs a built dist/. */
export async function scanForSecrets(root, paths) {
  const patternsFile = path.join(root, "dist", "vault", "patterns.js");
  if (!fs.existsSync(patternsFile)) return { problems: ["dist/ is not built, so the secret scan could not run (npm run build)"], scanned: 0 };
  const { findLeaks } = await import(pathToFileURL(patternsFile).href);
  const problems = [];
  let scanned = 0;
  for (const p of paths) {
    const f = path.join(root, p);
    if (!fs.statSync(f).isFile() || fs.statSync(f).size > 5_000_000) continue;
    scanned++;
    const text = fs.readFileSync(f, "utf8");
    for (const leak of findLeaks(text, 3)) problems.push(`${p} contains what looks like a credential (${leak.type})`);
  }
  return { problems, scanned };
}

/* ------------------------------------------------------------------ preflight */

export function readPkg(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

/**
 * Everything that must be true before a release folder is worth building. `deps.run` is injectable for tests.
 * Returns { problems, notes }. Problems block the release; notes are things the maintainer should know.
 */
export async function preflight(root, o = {}, deps = { run }) {
  const problems = [];
  const notes = [];
  let pkg;
  try {
    pkg = readPkg(root);
  } catch (e) {
    return { problems: [`package.json cannot be read: ${e.message}`], notes, pkg: undefined };
  }
  if (!pkg.name) problems.push("package.json has no name");
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version ?? "")) problems.push(`version ${JSON.stringify(pkg.version)} is not a semantic version`);
  if (!pkg.license) problems.push("package.json has no license");
  else if (!fs.existsSync(path.join(root, "LICENSE"))) problems.push(`license is ${pkg.license} but there is no LICENSE file`);
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!repo) problems.push("package.json has no repository (npm provenance requires it to match the GitHub repository)");
  else if (!REPO_URL_RE.test(repo)) problems.push(`repository url ${JSON.stringify(repo)} should look like git+https://github.com/OWNER/REPO.git`);
  if (!pkg.bin?.cephalo) problems.push("package.json has no bin entry for cephalo");
  if (!Array.isArray(pkg.files)) problems.push("package.json has no files whitelist, so the tarball would include everything not ignored");
  if (pkg.private) problems.push("package.json has private: true, which makes npm refuse to publish");
  if (pkg.scripts?.postinstall || pkg.scripts?.preinstall || pkg.scripts?.install) problems.push("the package defines an install-time script; Cephalo should not run code on install");

  if (o.tag) {
    const want = `v${pkg.version}`;
    if (o.tag !== want) problems.push(`the tag is ${o.tag} but package.json says ${pkg.version} (expected ${want})`);
  }

  const cli = path.join(root, "dist", "cli.js");
  if (!fs.existsSync(cli)) problems.push("dist/cli.js does not exist (npm run build)");
  else if (!fs.readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node")) problems.push("dist/cli.js has no #!/usr/bin/env node line, so the cephalo command would not run on macOS or Linux");

  if (!o.allowDirty) {
    const g = deps.run("git", ["status", "--porcelain"], { cwd: root });
    if (g.status !== 0) problems.push("git status failed, so a clean working tree could not be confirmed");
    else if (g.stdout.trim()) problems.push(`the working tree has uncommitted changes (${g.stdout.trim().split("\n").length} paths); commit them, or pass --allow-dirty for a trial run`);
  } else notes.push("--allow-dirty: the tarball may contain changes that are not committed, so it must not be published");

  const pack = deps.run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root });
  let paths = [];
  if (pack.status !== 0) problems.push(`npm pack --dry-run failed: ${pack.stderr.trim().split("\n").slice(-2).join(" ")}`);
  else {
    try {
      paths = JSON.parse(pack.stdout)[0].files.map((f) => f.path.replace(/\\/g, "/"));
      problems.push(...checkPackList(paths));
      const scan = await scanForSecrets(root, paths);
      problems.push(...scan.problems);
      notes.push(`${paths.length} files would be packed; ${scan.scanned} were scanned for credentials`);
    } catch (e) {
      problems.push(`could not read the npm pack file list: ${e.message}`);
    }
  }

  if (!o.quick && !o.skipTests) {
    const t = deps.run("npm", ["test"], { cwd: root });
    if (t.status !== 0) problems.push(`npm test failed (exit ${t.status}); last lines: ${(t.stdout + t.stderr).trim().split("\n").slice(-3).join(" | ")}`);
    else notes.push("npm test passed");
  } else notes.push(o.skipTests ? "tests were skipped (--skip-tests)" : "tests were not run (--quick)");
  return { problems, notes, pkg, paths };
}

/* ------------------------------------------------------------------ signing */

export function cosignAvailable(deps = { run }) {
  const r = deps.run("cosign", ["version"]);
  return r.status === 0;
}

/** Keyless Sigstore signature of the checksum file. In CI the identity is the workflow; locally cosign opens a browser login. */
export function signSums(dir, deps = { run }) {
  const bundle = path.join(dir, BUNDLE);
  const r = deps.run("cosign", ["sign-blob", "--yes", "--bundle", bundle, path.join(dir, SUMS)]);
  if (r.status !== 0 || !fs.existsSync(bundle)) return { ok: false, detail: (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ") };
  return { ok: true, bundle };
}

export function verifySignature(dir, identity, issuer, deps = { run }) {
  const args = ["verify-blob", "--bundle", path.join(dir, BUNDLE)];
  if (identity.startsWith("^") || identity.includes(".*")) args.push("--certificate-identity-regexp", identity);
  else args.push("--certificate-identity", identity);
  args.push("--certificate-oidc-issuer", issuer, path.join(dir, SUMS));
  const r = deps.run("cosign", args);
  return { ok: r.status === 0, detail: (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ") };
}

/* ------------------------------------------------------------------ pack */

export async function pack(root, o = {}, deps = { run }) {
  const out = [];
  // fail before creating anything: a half-built folder would block the retry, because releases are never overwritten
  if (o.sign === "required" && !cosignAvailable(deps)) return { ok: false, lines: ["cosign is required (--sign required) but was not found on PATH. Nothing was built. Install cosign (see docs/RELEASING.md), or use --sign auto for an unsigned trial."] };
  const pf = await preflight(root, o, deps);
  out.push(...pf.notes.map((n) => `  note: ${n}`));
  if (pf.problems.length) return { ok: false, lines: ["Release checks failed. Nothing was built:", ...pf.problems.map((p) => `  - ${p}`), ...out] };
  const { name, version } = pf.pkg;
  const dir = path.resolve(o.out ?? path.join(root, "release", `${name.replace(/^@/, "").replace("/", "-")}-${version}`));
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) return { ok: false, lines: [`${dir} already exists and is not empty. Releases are never overwritten; move it away or choose --out.`] };
  fs.mkdirSync(dir, { recursive: true });

  const p = deps.run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", dir], { cwd: root });
  if (p.status !== 0) return { ok: false, lines: [`npm pack failed: ${p.stderr.trim().split("\n").slice(-3).join(" | ")}`] };
  const info = JSON.parse(p.stdout)[0];
  const tgz = path.join(dir, info.filename);
  if (!fs.existsSync(tgz)) return { ok: false, lines: [`npm pack reported ${info.filename} but it is not in ${dir}`] };

  // the same sources must give the same bytes, otherwise a rebuilt tarball could never be compared with the signed one
  const tmp = fs.mkdtempSync(path.join(path.dirname(dir), ".repack-"));
  try {
    const again = deps.run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tmp], { cwd: root });
    const f2 = again.status === 0 ? path.join(tmp, JSON.parse(again.stdout)[0].filename) : null;
    if (!f2 || sha256File(f2) !== sha256File(tgz)) return { ok: false, lines: ["Packing twice gave different tarballs, so the release is not reproducible. Nothing was signed; the folder was left for inspection: " + dir] };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  fs.writeFileSync(path.join(dir, SUMS), sumsText([{ name: info.filename, hash: sha256File(tgz) }]), "utf8");
  const lines = [`Built ${info.filename} (${info.size} bytes, ${info.entryCount ?? info.files.length} files)`, `  sha256     ${sha256File(tgz)}`, `  npm integrity ${info.integrity}`, `Wrote ${path.join(dir, SUMS)}`, ...out];

  let signed = false;
  if (o.sign !== "off") {
    if (!cosignAvailable(deps)) {
      if (o.sign === "required") return { ok: false, lines: [...lines, "cosign is required (--sign required) but was not found on PATH. The folder is NOT signed; do not publish it as a signed release."] };
      lines.push("cosign was not found, so the checksum file is NOT signed. Install cosign, then run: cosign sign-blob --yes --bundle " + path.join(dir, BUNDLE) + " " + path.join(dir, SUMS));
    } else {
      const s = signSums(dir, deps);
      if (!s.ok) {
        if (o.sign === "required") return { ok: false, lines: [...lines, `Signing failed: ${s.detail}`] };
        lines.push(`Signing failed, so the checksum file is NOT signed: ${s.detail}`);
      } else {
        signed = true;
        lines.push(`Signed ${SUMS} -> ${s.bundle}`);
      }
    }
  } else lines.push("Signing was turned off (--sign off).");

  const bad = verifySums(dir).filter((r) => !r.ok);
  if (bad.length) return { ok: false, lines: [...lines, ...bad.map((b) => `Self-check failed for ${b.name}: ${b.reason}`)] };
  lines.push("Self-check: SHA256SUMS matches the files in the folder.");
  lines.push("", "Nothing has been published. To publish this exact tarball with your own npm login:", `  npm publish "${tgz}" --access public`, "(npm provenance is only added when publishing from the GitHub Actions workflow; see docs/RELEASING.md)");
  if (!signed) lines.push("", "Reminder: this folder is unsigned.");
  return { ok: true, lines, dir, signed };
}

/* ------------------------------------------------------------------ command line */

export function parseArgs(argv) {
  const o = { sub: argv[0], sign: "auto", rest: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--quick") o.quick = true;
    else if (a === "--allow-dirty") o.allowDirty = true;
    else if (a === "--skip-tests") o.skipTests = true;
    else if (a === "--tag") o.tag = need();
    else if (a === "--out") o.out = need();
    else if (a === "--identity") o.identity = need();
    else if (a === "--issuer") o.issuer = need();
    else if (a === "--sign") {
      o.sign = need();
      if (!["auto", "required", "off"].includes(o.sign)) throw new Error("--sign must be auto, required or off");
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else o.rest.push(a);
  }
  return o;
}

const USAGE = `Usage:
  node scripts/release.mjs check  [--quick] [--allow-dirty] [--tag vX.Y.Z]
  node scripts/release.mjs pack   [--sign auto|required|off] [--out DIR] [--allow-dirty] [--skip-tests] [--tag vX.Y.Z]
  node scripts/release.mjs verify DIR [--identity RE_OR_ID --issuer URL]

This script prepares and verifies a release. It never runs npm publish.`;

export async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(`release: ${e.message}\n\n${USAGE}`);
    return 1;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (o.sub === "check") {
    const r = await preflight(root, o);
    for (const n of r.notes) console.log(`note: ${n}`);
    if (r.problems.length) {
      console.log("Release checks failed:");
      for (const p of r.problems) console.log(`  - ${p}`);
      return 1;
    }
    console.log(`OK: ${r.pkg.name}@${r.pkg.version} passes the release checks.`);
    return 0;
  }
  if (o.sub === "pack") {
    const r = await pack(root, o);
    for (const l of r.lines) console.log(l);
    return r.ok ? 0 : 1;
  }
  if (o.sub === "verify") {
    const dir = o.rest[0];
    if (!dir) {
      console.error(USAGE);
      return 1;
    }
    let code = 0;
    try {
      for (const r of verifySums(dir)) {
        console.log(`${r.ok ? "OK    " : "FAILED"} ${r.name}${r.ok ? "" : ` (${r.reason})`}`);
        if (!r.ok) code = 1;
      }
    } catch (e) {
      console.log(`FAILED ${e.message}`);
      return 1;
    }
    if (fs.existsSync(path.join(dir, BUNDLE))) {
      if (!o.identity || !o.issuer) {
        console.log(`A signature bundle is present, but it was not checked: pass --identity and --issuer (who you expect to have signed). Checksums alone prove the files match SHA256SUMS, not who made it.`);
        return code || 2;
      }
      if (!cosignAvailable()) {
        console.log("cosign was not found on PATH, so the signature was not checked.");
        return code || 2;
      }
      const v = verifySignature(dir, o.identity, o.issuer);
      console.log(`${v.ok ? "OK    " : "FAILED"} signature on ${SUMS}${v.ok ? "" : ` (${v.detail})`}`);
      if (!v.ok) code = 1;
    } else console.log(`No ${BUNDLE} in this folder: the release is not signed.`);
    return code;
  }
  console.error(USAGE);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => {
    console.error(`release: ${e.stack || e}`);
    process.exit(1);
  });
}
