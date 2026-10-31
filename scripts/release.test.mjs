// Tests for scripts/release.mjs. Run: npm run test:release   (needs `npm run build` first for the secret-scan and real-pack tests)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { BUNDLE, SUMS, checkPackList, cosignAvailable, pack, parseArgs, parseSums, preflight, run, scanForSecrets, sha256, signSums, sumsText, verifySignature, verifySums } from "./release.mjs";

const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = fs.existsSync(path.join(REAL_ROOT, "dist", "vault", "patterns.js"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-rel-"));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const GOOD_PKG = { name: "demo", version: "1.2.3", license: "MIT", repository: { type: "git", url: "git+https://github.com/o/r.git" }, bin: { cephalo: "dist/cli.js" }, files: ["dist", "README.md", "LICENSE"] };

/** A throwaway project that passes every check, plus injectable command results. */
function project(over = {}) {
  const root = tmp();
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...GOOD_PKG, ...over }, null, 2));
  fs.writeFileSync(path.join(root, "LICENSE"), "MIT");
  fs.writeFileSync(path.join(root, "README.md"), "# demo");
  fs.writeFileSync(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\nconsole.log(1)\n");
  // the secret scan imports the project's own detector; a stub that finds nothing keeps these tests independent of a build
  fs.mkdirSync(path.join(root, "dist", "vault"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "vault", "patterns.js"), "export function findLeaks() { return []; }\n");
  return root;
}
const PACK_LIST = ["package.json", "README.md", "LICENSE", "dist/cli.js"];
function fakeRun(o = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === "git") return { status: 0, stdout: o.dirty ? " M src/a.ts\n" : "", stderr: "" };
    if (cmd === "npm" && args[0] === "pack") {
      const di = args.indexOf("--pack-destination");
      const dest = di >= 0 ? args[di + 1] : null;
      if (!dest) return { status: 0, stdout: JSON.stringify([{ files: (o.list ?? PACK_LIST).map((p) => ({ path: p })) }]), stderr: "" };
      const name = "demo-1.2.3.tgz";
      const n = (fn.packs = (fn.packs ?? 0) + 1);
      fs.writeFileSync(path.join(dest, name), o.nonDeterministic ? `bytes-${n}` : "bytes");
      return { status: 0, stdout: JSON.stringify([{ filename: name, size: 5, integrity: "sha512-x", files: [{ path: "dist/cli.js" }], entryCount: 1 }]), stderr: "" };
    }
    if (cmd === "npm" && args[0] === "test") return { status: o.testsFail ? 1 : 0, stdout: "", stderr: o.testsFail ? "1 failing" : "" };
    if (cmd === "cosign") return o.cosign ? o.cosign(args) : { status: 127, stdout: "", stderr: "not found" };
    return { status: 1, stdout: "", stderr: `unexpected ${cmd}` };
  };
  fn.calls = calls;
  return { run: fn };
}

/* ------------------------------------------------------------------ checksums */

test("SHA256SUMS: format, sorting, parsing, and rejection of anything but plain names", () => {
  const text = sumsText([{ name: "b.tgz", hash: sha256("b") }, { name: "a.tgz", hash: sha256("a") }]);
  assert.equal(text, `${sha256("a")}  a.tgz\n${sha256("b")}  b.tgz\n`);
  assert.deepEqual(parseSums(text).map((e) => e.name), ["a.tgz", "b.tgz"]);
  assert.deepEqual(parseSums(`${sha256("a")} *bin.tgz\n`)[0].name, "bin.tgz", "binary-mode marker is accepted");
  for (const bad of ["", "nonsense\n", `${sha256("a")}  ../escape.tgz\n`, `${sha256("a")}  sub/dir.tgz\n`, `${sha256("a")}  ..\n`, `${"g".repeat(64)}  x\n`, `${sha256("a").slice(0, 60)}  x\n`]) assert.throws(() => parseSums(bad), undefined, JSON.stringify(bad));
});

test("verifySums catches a changed file and a missing file; sha256sum -c agrees when it is available", () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, "a.tgz"), "one");
    fs.writeFileSync(path.join(d, "b.tgz"), "two");
    fs.writeFileSync(path.join(d, SUMS), sumsText([{ name: "a.tgz", hash: sha256("one") }, { name: "b.tgz", hash: sha256("two") }]));
    assert.ok(verifySums(d).every((r) => r.ok));
    const sc = run("sha256sum", ["-c", SUMS], { cwd: d });
    if (sc.status !== 127) assert.equal(sc.status, 0, "the file is in the format sha256sum -c reads: " + sc.stderr);
    fs.writeFileSync(path.join(d, "a.tgz"), "tampered");
    fs.rmSync(path.join(d, "b.tgz"));
    const r = verifySums(d);
    assert.deepEqual(r.map((x) => [x.name, x.ok, x.reason?.startsWith("hash is") ? "hash" : x.reason]), [["a.tgz", false, "hash"], ["b.tgz", false, "file is missing"]]);
    if (sc.status !== 127) assert.notEqual(run("sha256sum", ["-c", SUMS], { cwd: d }).status, 0);
  } finally {
    rm(d);
  }
});

/* ------------------------------------------------------------------ what would ship */

test("pack list: required files, and everything that must never ship", () => {
  assert.deepEqual(checkPackList(PACK_LIST), []);
  const bad = checkPackList([...PACK_LIST, "src/cli.ts", "site/index.html", "dist/tests/a.test.js", ".env", "config/.env.local", "keys/id_rsa", "x/server.pem", "dist/a.js.map", "audit.jsonl", "tsconfig.json", "release/a/b.tgz"]);
  assert.equal(bad.length, 11);
  assert.ok(bad.every((p) => p.startsWith("the package would include")));
  assert.deepEqual(checkPackList(["package.json"]).sort(), ["the package is missing LICENSE", "the package is missing README.md", "the package is missing dist/cli.js"]);
  assert.deepEqual(checkPackList([...PACK_LIST, ".env.example"]), ["the package would include .env.example: an environment file"], "even an example env file is flagged for a human to confirm");
});

test("secret scan: a credential inside a file that would ship is found, and its value is not repeated", { skip: !built && "run npm run build first" }, async () => {
  const root = project();
  try {
    fs.mkdirSync(path.join(root, "dist", "vault"), { recursive: true });
    fs.copyFileSync(path.join(REAL_ROOT, "dist", "vault", "patterns.js"), path.join(root, "dist", "vault", "patterns.js"));
    const fake = "ghp_" + crypto.randomBytes(30).toString("base64").replace(/[^A-Za-z0-9]/g, "").padEnd(36, "x").slice(0, 36);
    fs.writeFileSync(path.join(root, "dist", "oops.js"), `const t = "${fake}";\n`);
    const r = await scanForSecrets(root, [...PACK_LIST, "dist/oops.js"]);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /^dist\/oops\.js contains what looks like a credential \(GitHub token\)$/);
    assert.ok(!r.problems[0].includes(fake));
    assert.deepEqual((await scanForSecrets(root, PACK_LIST)).problems, []);
    assert.match((await scanForSecrets(tmp(), PACK_LIST)).problems[0], /not built/);
  } finally {
    rm(root);
  }
});

/* ------------------------------------------------------------------ preflight */

test("preflight: a good project passes; each defect is reported on its own", async () => {
  const ok = project();
  try {
    const r = await preflight(ok, { quick: true }, fakeRun());
    assert.deepEqual(r.problems, [], r.problems.join("\n"));
  } finally {
    rm(ok);
  }
  const cases = [
    [{ license: undefined }, /no license/],
    [{ version: "1.2" }, /not a semantic version/],
    [{ repository: undefined }, /no repository/],
    [{ repository: { url: "https://example.com/x.git" } }, /should look like git\+https:\/\/github\.com/],
    [{ bin: undefined }, /no bin entry/],
    [{ files: undefined }, /no files whitelist/],
    [{ private: true }, /private: true/],
    [{ scripts: { postinstall: "node x.js" } }, /install-time script/],
  ];
  for (const [over, re] of cases) {
    const root = project(over);
    try {
      const r = await preflight(root, { quick: true }, fakeRun());
      assert.ok(r.problems.some((p) => re.test(p)), `${JSON.stringify(over)} -> ${r.problems.join(" | ")}`);
    } finally {
      rm(root);
    }
  }
});

test("preflight: tag mismatch, dirty tree, missing licence file, bad shebang, failing tests, bad pack list", async () => {
  const root = project();
  try {
    const has = async (o, deps, re) => assert.ok((await preflight(root, o, deps)).problems.some((p) => re.test(p)), re.source);
    await has({ quick: true, tag: "v9.9.9" }, fakeRun(), /tag is v9\.9\.9 but package\.json says 1\.2\.3/);
    assert.deepEqual((await preflight(root, { quick: true, tag: "v1.2.3" }, fakeRun())).problems, []);
    await has({ quick: true }, fakeRun({ dirty: true }), /uncommitted changes/);
    const d = await preflight(root, { quick: true, allowDirty: true }, fakeRun({ dirty: true }));
    assert.deepEqual(d.problems, []);
    assert.ok(d.notes.some((n) => /must not be published/.test(n)));
    await has({}, fakeRun({ testsFail: true }), /npm test failed \(exit 1\)/);
    await has({ quick: true }, fakeRun({ list: [...PACK_LIST, "src/x.ts"] }), /would include src\/x\.ts/);
    const calls = fakeRun();
    await preflight(root, { quick: true }, calls);
    assert.ok(!calls.run.calls.some((c) => c[0] === "npm" && c[1] === "test"), "--quick does not run the tests");
    fs.writeFileSync(path.join(root, "dist", "cli.js"), "console.log(1)\n");
    await has({ quick: true }, fakeRun(), /no #!\/usr\/bin\/env node line/);
    fs.rmSync(path.join(root, "LICENSE"));
    await has({ quick: true }, fakeRun(), /no LICENSE file/);
  } finally {
    rm(root);
  }
});

/* ------------------------------------------------------------------ pack (fake npm and cosign) */

test("pack: builds the folder, writes SHA256SUMS, refuses to overwrite, and never calls publish", async () => {
  const root = project();
  try {
    const out = path.join(root, "rel");
    const deps = fakeRun();
    const r = await pack(root, { skipTests: true, sign: "off", out }, deps);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.deepEqual(fs.readdirSync(out).sort(), [SUMS, "demo-1.2.3.tgz"]);
    assert.ok(verifySums(out).every((x) => x.ok));
    assert.match(r.lines.join("\n"), /Nothing has been published\. To publish this exact tarball with your own npm login:\s+npm publish ".*demo-1\.2\.3\.tgz" --access public/);
    assert.match(r.lines.join("\n"), /Signing was turned off[\s\S]*this folder is unsigned/);
    assert.ok(!deps.run.calls.some((c) => c.includes("publish")), "the script never runs npm publish");
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith(".repack-")), [], "temporary folders are cleaned up");
    const again = await pack(root, { skipTests: true, sign: "off", out }, fakeRun());
    assert.equal(again.ok, false);
    assert.match(again.lines[0], /already exists and is not empty\. Releases are never overwritten/);
    assert.equal(fs.readdirSync(out).length, 2);
  } finally {
    rm(root);
  }
});

test("pack: failed checks build nothing; a non-reproducible tarball is rejected before signing", async () => {
  const root = project({ license: undefined });
  try {
    const out = path.join(root, "rel");
    const r = await pack(root, { quick: true, skipTests: true, sign: "off", out }, fakeRun());
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /Release checks failed\. Nothing was built/);
    assert.ok(!fs.existsSync(out));
  } finally {
    rm(root);
  }
  const root2 = project();
  try {
    const cos = fakeRun({ nonDeterministic: true, cosign: () => ({ status: 0, stdout: "", stderr: "" }) });
    const r = await pack(root2, { skipTests: true, sign: "auto", out: path.join(root2, "rel") }, cos);
    assert.equal(r.ok, false);
    assert.match(r.lines[0], /not reproducible/);
    assert.ok(!cos.run.calls.some((c) => c[0] === "cosign"), "nothing is signed when the bytes are not stable");
    assert.ok(!fs.existsSync(path.join(root2, "rel", SUMS)));
  } finally {
    rm(root2);
  }
});

test("pack: signing modes. auto without cosign warns, required without cosign fails, a working cosign signs the checksum file", async () => {
  const mk = async (o, deps) => {
    const root = project();
    try {
      const out = path.join(root, "rel");
      return { ...(await pack(root, { skipTests: true, out, ...o }, deps)), out, files: fs.existsSync(out) ? fs.readdirSync(out).sort() : [] };
    } finally {
      rm(root);
    }
  };
  const auto = await mk({ sign: "auto" }, fakeRun());
  assert.equal(auto.ok, true);
  assert.equal(auto.signed, false);
  assert.match(auto.lines.join("\n"), /cosign was not found, so the checksum file is NOT signed\. Install cosign, then run: cosign sign-blob --yes --bundle/);
  assert.match(auto.lines.join("\n"), /Reminder: this folder is unsigned/);

  const req = await mk({ sign: "required" }, fakeRun());
  assert.equal(req.ok, false);
  assert.match(req.lines.join("\n"), /cosign is required .* Nothing was built/);
  assert.deepEqual(req.files, [], "nothing is left behind, so a retry is not blocked");

  let seen;
  const good = await mk({ sign: "required" }, fakeRun({ cosign: (args) => {
    if (args[0] === "version") return { status: 0, stdout: "v2", stderr: "" };
    seen = args;
    fs.writeFileSync(args[args.indexOf("--bundle") + 1], "{}");
    return { status: 0, stdout: "", stderr: "" };
  } }));
  assert.equal(good.ok, true, good.lines.join("\n"));
  assert.equal(good.signed, true);
  assert.deepEqual(good.files, [BUNDLE, SUMS, "demo-1.2.3.tgz"].sort());
  assert.deepEqual([seen[0], seen[1], seen[2]], ["sign-blob", "--yes", "--bundle"]);
  assert.ok(seen.at(-1).endsWith(SUMS), "what is signed is the checksum file, which covers the tarball by hash");

  const failing = await mk({ sign: "auto" }, fakeRun({ cosign: (args) => (args[0] === "version" ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "", stderr: "OIDC login cancelled" }) }));
  assert.equal(failing.ok, true);
  assert.equal(failing.signed, false);
  assert.match(failing.lines.join("\n"), /Signing failed, so the checksum file is NOT signed: OIDC login cancelled/);
  const failReq = await mk({ sign: "required" }, fakeRun({ cosign: (args) => (args[0] === "version" ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "", stderr: "boom" }) }));
  assert.equal(failReq.ok, false);
});

test("cosign command lines match the documented flags", () => {
  const d = tmp();
  try {
    fs.writeFileSync(path.join(d, SUMS), "x");
    const calls = [];
    const deps = { run: (cmd, args) => (calls.push([cmd, ...args]), { status: 0, stdout: "", stderr: "" }) };
    verifySignature(d, "me@example.com", "https://accounts.google.com", deps);
    verifySignature(d, "^https://github\\.com/o/r/\\.github/workflows/release\\.yml@refs/tags/v", "https://token.actions.githubusercontent.com", deps);
    assert.deepEqual(calls[0], ["cosign", "verify-blob", "--bundle", path.join(d, BUNDLE), "--certificate-identity", "me@example.com", "--certificate-oidc-issuer", "https://accounts.google.com", path.join(d, SUMS)]);
    assert.equal(calls[1][4], "--certificate-identity-regexp", "an anchored pattern is passed as a regexp, never as an exact identity");
    assert.equal(signSums(d, { run: () => ({ status: 0, stdout: "", stderr: "" }) }).ok, false, "success without a bundle file is a failure");
    assert.equal(cosignAvailable({ run: () => ({ status: 0 }) }), true);
  } finally {
    rm(d);
  }
});

/* ------------------------------------------------------------------ real npm pack on this repository */

test("real pack of this repository: reproducible, small, no source or tests, tamper is detected", { skip: !built && "run npm run build first", timeout: 120000 }, async () => {
  const out = path.join(tmp(), "rel");
  try {
    const r = await pack(REAL_ROOT, { allowDirty: true, skipTests: true, sign: "off", out });
    assert.equal(r.ok, true, r.lines.join("\n"));
    const tgz = fs.readdirSync(out).find((n) => n.endsWith(".tgz"));
    assert.match(tgz, /^cephalo-\d+\.\d+\.\d+.*\.tgz$/);
    const list = run("tar", ["-tzf", path.join(out, tgz)]);
    if (list.status === 0) {
      const names = list.stdout.split(/\r?\n/).filter(Boolean).map((n) => n.replace(/^package\//, ""));
      assert.ok(names.includes("dist/cli.js") && names.includes("LICENSE") && names.includes("package.json"));
      assert.deepEqual(names.filter((n) => /^(src|site|scripts|docs|\.github)\/|^dist\/tests\/|tsconfig/.test(n)), []);
      assert.ok(names.length < 100, `${names.length} files`);
    }
    assert.ok(verifySums(out).every((x) => x.ok));
    fs.appendFileSync(path.join(out, tgz), "x");
    assert.ok(verifySums(out).some((x) => !x.ok), "a one-byte change is detected");
  } finally {
    rm(path.dirname(out));
  }
});

test("argument parsing", () => {
  assert.deepEqual(parseArgs(["pack", "--sign", "required", "--out", "x", "--allow-dirty", "--skip-tests", "--tag", "v1.0.0"]), { sub: "pack", sign: "required", rest: [], out: "x", allowDirty: true, skipTests: true, tag: "v1.0.0" });
  assert.deepEqual(parseArgs(["verify", "dir", "--identity", "a", "--issuer", "b"]), { sub: "verify", sign: "auto", rest: ["dir"], identity: "a", issuer: "b" });
  assert.throws(() => parseArgs(["pack", "--sign", "maybe"]), /--sign must be/);
  assert.throws(() => parseArgs(["pack", "--out"]), /--out needs a value/);
  assert.throws(() => parseArgs(["pack", "--out", "--sign"]), /--out needs a value/);
  assert.throws(() => parseArgs(["pack", "--publish"]), /unknown option --publish/);
});
