import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { DEFAULT_RULES } from "../rules.js";
import { planPull, pushPolicy, readManifest, saveSyncDir } from "../sync/policy.js";
import { SIGNING_KEY_FILE, TRUST_FILE, addTrusted, generateKeypair, keyId, loadTrusted, signManifest, verifyManifest } from "../sync/sign.js";
import { runSync } from "../synccmd.js";
import { evaluate } from "../engine.js";
import { SYSTEM_RULES } from "../platform-rules.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-signed-"));
const yes = { confirm: async () => true, yes: true };

/** An admin dir (key + rules), a developer dir (trust file + own rules) and a shared folder. */
function world() {
  const d = tmp();
  const w = { d, shared: path.join(d, "shared"), admin: path.join(d, "admin"), dev: path.join(d, "dev"), adminRules: "", devRules: "", key: "", trust: "" };
  for (const x of [w.shared, w.admin, w.dev]) fs.mkdirSync(x);
  w.adminRules = path.join(w.admin, "rules.yml");
  w.devRules = path.join(w.dev, "rules.yml");
  fs.writeFileSync(w.adminRules, stringify({ rules: [...DEFAULT_RULES, { id: "no-prod-db", description: "prod", type: "command", pattern: "prod-db", action: "block" }] }));
  fs.writeFileSync(w.devRules, stringify({ rules: DEFAULT_RULES }));
  w.key = path.join(w.admin, SIGNING_KEY_FILE);
  w.trust = path.join(w.dev, TRUST_FILE);
  return w;
}

test("keygen makes a key pair; refuses to overwrite; the public key verifies a signature", () => {
  const w = world();
  const g = generateKeypair(w.key);
  assert.equal(g.ok, true);
  assert.ok(fs.existsSync(w.key) && fs.existsSync(path.join(w.admin, "policy-signing.pub")));
  if (process.platform !== "win32") assert.equal(fs.statSync(w.key).mode & 0o077, 0, "private key is owner-only");
  assert.equal(generateKeypair(w.key).ok, false);
  const m = { sha256: "ab".repeat(32), at: "2026-11-02T00:00:00.000Z", rules: 3, by: "zuri" };
  const s = signManifest(w.key, m);
  assert.equal(s.keyId, keyId(g.publicPem!));
  assert.equal(verifyManifest({ ...m, signature: s.signature }, [g.publicPem!]).ok, true);
  assert.equal(verifyManifest({ ...m, rules: 4, signature: s.signature }, [g.publicPem!]).ok, false, "any signed field changing breaks it");
});

test("signed push, trusted pull: signature is checked and the rules arrive", () => {
  const w = world();
  const g = generateKeypair(w.key);
  assert.equal(addTrusted(w.trust, g.publicPem!).ok, true);
  assert.equal(loadTrusted(w.trust).length, 1);
  assert.match(addTrusted(w.trust, g.publicPem!).lines[0]!, /already trusted/);
  const r = pushPolicy(w.shared, w.adminRules, new Date(), { keyFile: w.key });
  assert.equal(r.ok, true);
  assert.match(r.lines.join("\n"), /Signed with key/);
  assert.ok(readManifest(w.shared)?.signature);
  const plan = planPull(w.shared, w.devRules, { trustFile: w.trust });
  assert.equal(plan.ok, true, plan.lines.join("\n"));
  assert.match(plan.lines.join("\n"), /Signature OK/);
  assert.deepEqual(plan.diff?.added.map((x) => x.id), ["no-prod-db"]);
});

test("with a trust file, unsigned, tampered, replayed-edit and wrongly signed policy are all refused", () => {
  const w = world();
  const admin = generateKeypair(w.key);
  addTrusted(w.trust, admin.publicPem!);
  const manifestFile = path.join(w.shared, "policy", "MANIFEST.json");
  const refused = (why: RegExp) => {
    const p = planPull(w.shared, w.devRules, { trustFile: w.trust });
    assert.equal(p.ok, false);
    assert.match(p.lines.join("\n"), why);
  };

  // unsigned
  pushPolicy(w.shared, w.adminRules);
  refused(/not signed/);

  // signed by an attacker's key
  const evilKey = path.join(w.d, "evil", SIGNING_KEY_FILE);
  generateKeypair(evilKey);
  pushPolicy(w.shared, w.adminRules, new Date(), { keyFile: evilKey });
  refused(/does not match any trusted key/);

  // good signature, then the rules file is edited: the hash check catches it
  pushPolicy(w.shared, w.adminRules, new Date(), { keyFile: w.key });
  assert.equal(planPull(w.shared, w.devRules, { trustFile: w.trust }).ok, true);
  const rulesFile = path.join(w.shared, "policy", "rules.yml");
  fs.appendFileSync(rulesFile, "\n# sneaky\n");
  refused(/hash differs/);

  // attacker rewrites rules AND recomputes the hash in the manifest, keeping the old signature
  pushPolicy(w.shared, w.adminRules, new Date(), { keyFile: w.key });
  const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const weaker = stringify({ rules: DEFAULT_RULES.slice(0, 2) });
  fs.writeFileSync(rulesFile, weaker);
  m.sha256 = crypto.createHash("sha256").update(weaker).digest("hex");
  m.rules = 2;
  fs.writeFileSync(manifestFile, JSON.stringify(m));
  refused(/does not match any trusted key/);
});

test("without a trust file nothing changes: unsigned policy pulls as before, with the old hash-only notice", () => {
  const w = world();
  pushPolicy(w.shared, w.adminRules);
  const m = readManifest(w.shared)!;
  assert.deepEqual(Object.keys(m).sort(), ["at", "by", "rules", "sha256"].filter((k) => k in m).sort(), "no signature fields when unsigned");
  assert.equal(m.signature, undefined);
  const plan = planPull(w.shared, w.devRules, { trustFile: w.trust }); // trust file does not exist
  assert.equal(plan.ok, true);
  assert.match(plan.lines.join("\n"), /does not prove who wrote it/);
  // and a signed policy is still accepted by someone who trusts nobody
  const g = generateKeypair(w.key);
  assert.ok(g.ok);
  pushPolicy(w.shared, w.adminRules, new Date(), { keyFile: w.key });
  assert.equal(planPull(w.shared, w.devRules, { trustFile: w.trust }).ok, true);
});

test("sync commands: keygen, push signs, trust, status, pull verifies", async () => {
  const w = world();
  const adminCfg = path.join(w.admin, "sync.yml"), devCfg = path.join(w.dev, "sync.yml");
  saveSyncDir(w.shared, adminCfg);
  saveSyncDir(w.shared, devCfg);

  assert.equal((await runSync("keygen", undefined, { ...yes, configFile: adminCfg, rulesFile: w.adminRules })).exitCode, 0);
  assert.equal((await runSync("keygen", undefined, { ...yes, configFile: adminCfg, rulesFile: w.adminRules })).exitCode, 1, "no silent overwrite");
  const push = await runSync("push", undefined, { ...yes, configFile: adminCfg, rulesFile: w.adminRules });
  assert.match(push.lines.join("\n"), /Signed with key/);

  const before = await runSync("status", undefined, { ...yes, configFile: devCfg, rulesFile: w.devRules });
  assert.match(before.lines.join("\n"), /Signature check: off/);
  assert.match(before.lines.join("\n"), /Shared policy is signed/);

  const bad = await runSync("trust", path.join(w.d, "nope.pub"), { ...yes, configFile: devCfg });
  assert.equal(bad.exitCode, 1);
  const notPem = path.join(w.d, "junk.pub");
  fs.writeFileSync(notPem, "hello");
  assert.equal((await runSync("trust", notPem, { ...yes, configFile: devCfg })).exitCode, 1);
  assert.equal((await runSync("trust", path.join(w.admin, "policy-signing.pub"), { ...yes, configFile: devCfg })).exitCode, 0);

  const after = await runSync("status", undefined, { ...yes, configFile: devCfg, rulesFile: w.devRules });
  assert.match(after.lines.join("\n"), /Signature check: on \(1 trusted key\)/);
  const pull = await runSync("pull", undefined, { ...yes, configFile: devCfg, rulesFile: w.devRules });
  assert.equal(pull.exitCode, 0, pull.lines.join("\n"));
  assert.ok(fs.readFileSync(w.devRules, "utf8").includes("no-prod-db"));

  // an unsigned republish is now refused for this developer
  fs.unlinkSync(path.join(w.admin, SIGNING_KEY_FILE));
  pushPolicy(w.shared, w.adminRules);
  const refused = await runSync("pull", undefined, { ...yes, configFile: devCfg, rulesFile: w.devRules });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.lines.join("\n"), /not signed/);
});

test("the agent cannot read or write the signing key or trust file", () => {
  const rules = [...DEFAULT_RULES, ...SYSTEM_RULES];
  for (const p of ["/home/u/.cephalo/policy-signing.key", "C:\\Users\\u\\.cephalo\\policy-trusted.pub"]) {
    for (const access of ["read", "write"] as const) {
      assert.equal(evaluate({ path: p, access }, rules).rule?.id, "protect-policy-key", `${access} ${p}`);
    }
  }
  assert.equal(evaluate({ command: "cat ~/.cephalo/policy-signing.key" }, rules).rule?.id, "no-vault-extract");
  assert.equal(evaluate({ path: "/home/u/.cephalo/policy-signing.pub", access: "read" }, rules).decision, "allow", "the public half is not secret");
});
