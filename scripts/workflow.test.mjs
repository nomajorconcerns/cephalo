// Static checks on .github/workflows/release.yml. The workflow itself has NOT been run on GitHub; these tests only catch structural mistakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseArgs } from "./release.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
const wf = parse(text);
const jobs = wf.jobs;
const steps = (j) => jobs[j].steps ?? [];

test("workflow: triggers are tag pushes and a manual run; nothing else", () => {
  assert.deepEqual(Object.keys(wf.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(wf.on.push, { tags: ["v*"] });
  assert.equal(wf.on.workflow_dispatch.inputs.publish.default, false, "publish is off unless ticked");
  assert.deepEqual(Object.keys(jobs).sort(), ["build", "github-release", "publish", "test"]);
});

test("workflow: every third-party action is pinned to a full commit SHA", () => {
  const uses = [];
  for (const j of Object.keys(jobs)) for (const s of steps(j)) if (s.uses) uses.push(s.uses);
  assert.ok(uses.length >= 8);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
  assert.ok(new RegExp(String.raw`@[0-9a-f]{40} # v\d+\.\d+\.\d+`).test(text), "the readable version is kept in a comment");
});

test("workflow: least privilege. Only the draft-release job can write to the repo; id-token only where signing or provenance needs it", () => {
  assert.deepEqual(wf.permissions, { contents: "read" });
  const perms = (j) => jobs[j].permissions ?? {};
  assert.equal(perms("test")["id-token"], undefined);
  assert.equal(perms("build")["id-token"], "write");
  assert.equal(perms("build").contents, "read");
  assert.equal(perms("github-release").contents, "write");
  assert.equal(perms("github-release")["id-token"], undefined);
  assert.equal(perms("publish")["id-token"], "write");
  assert.equal(perms("publish").contents, "read");
  for (const j of Object.keys(jobs)) if (j !== "github-release") assert.notEqual(perms(j).contents, "write", j);
  for (const j of ["test", "build"]) for (const s of steps(j)) if (s.uses?.startsWith("actions/checkout")) assert.equal(s.with["persist-credentials"], false, "the checkout does not leave a token in the repo config");
});

test("workflow: publishing needs a manual run on a tag AND an approved environment, and uses the signed tarball", () => {
  const p = jobs.publish;
  assert.match(p.if, /github\.event_name == 'workflow_dispatch'/);
  assert.match(p.if, /inputs\.publish/);
  assert.match(p.if, /github\.ref_type == 'tag'/);
  assert.equal(p.environment, "npm-publish");
  assert.deepEqual(p.needs, "build");
  const pub = steps("publish").find((s) => /npm publish/.test(s.run ?? ""));
  assert.match(pub.run, /npm publish "\$tgz" --access public --provenance/);
  const names = steps("publish").map((s) => s.name ?? s.uses);
  assert.ok(names.findIndex((n) => /Re-verify/.test(n)) < names.findIndex((n) => /Publish the signed tarball/.test(n)), "checksums and signature are checked before publishing");
  for (const j of ["test", "build", "github-release"]) for (const s of steps(j)) assert.ok(!/npm publish/.test(s.run ?? ""), `${j} must not publish`);
  assert.equal(jobs.build.if, undefined);
  assert.match(jobs["github-release"].if, /ref_type == 'tag'/);
  assert.match(steps("github-release").at(-1).run, /--draft/, "a tag push only ever creates a DRAFT release");
});

test("workflow: no run block interpolates GitHub expressions directly (they go through env)", () => {
  for (const j of Object.keys(jobs)) for (const s of steps(j)) if (s.run) assert.ok(!s.run.includes("${{"), `${j}: ${s.name ?? s.run.slice(0, 40)}`);
});

test("workflow: the release script is called with options it actually accepts, and signing is required in CI", () => {
  const pack = steps("build").find((s) => s.id === "pack");
  assert.match(pack.run, /args=\(--sign required --skip-tests\)/);
  assert.match(pack.run, /args\+=\(--tag "\$TAG"\)/);
  const o = parseArgs(["pack", "--sign", "required", "--skip-tests", "--tag", "v0.1.0"]);
  assert.deepEqual([o.sign, o.skipTests, o.tag], ["required", true, "v0.1.0"]);
  const verify = steps("build").find((s) => /release\.mjs verify/.test(s.run ?? ""));
  assert.match(verify.run, /--issuer https:\/\/token\.actions\.githubusercontent\.com/);
  assert.match(verify.run, /release\\\\\.yml@refs\/\(tags\|heads\)\//, "the expected signer is this workflow file");
  assert.ok(fs.existsSync(path.join(ROOT, "scripts", "release.mjs")));
});

test("workflow: the test matrix covers the platforms and Node versions the package claims", () => {
  const m = jobs.test.strategy.matrix;
  assert.deepEqual(m.os, ["ubuntu-latest", "windows-latest", "macos-latest"]);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const min = Number(/>=\s*(\d+)/.exec(pkg.engines.node)[1]);
  assert.ok(m.node.includes(min), `the oldest supported Node (${min}) is in the matrix`);
  assert.equal(jobs.test.strategy["fail-fast"], false);
});
