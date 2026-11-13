import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluate } from "../engine.js";
import { getPlatform } from "../platform.js";
import { DEFAULT_RULES, activePlatformRules } from "../rules.js";
import { compareVersions, isGlobalNpmInstall, parseUpdateArgs, parseVersion, updateCommand, type NpmOut, type UpdateDeps } from "../updatecmd.js";

/** A fake npm that records what it was asked to run. Nothing in these tests installs a package or touches the network. */
function fakeNpm(root: string, installStatus = 0) {
  const calls: string[][] = [];
  const runNpm = (args: string[]): NpmOut => {
    calls.push(args);
    if (args[0] === "root") return { status: 0, stdout: root + "\n", stderr: "" };
    return { status: installStatus, stdout: "", stderr: installStatus ? "npm ERR! EACCES permission denied" : "" };
  };
  return { calls, runNpm };
}

function globalLayout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-update-"));
  const pkg = path.join(root, "@nomajorconcerns", "cephalo", "dist");
  fs.mkdirSync(pkg, { recursive: true });
  const self = path.join(pkg, "updatecmd.js");
  fs.writeFileSync(self, "");
  return { root, self };
}

const base = (o: Partial<UpdateDeps>): UpdateDeps => ({ current: "0.1.1", fetchLatest: async () => "0.2.0", ...o });

test("versions: plain x.y.z only, compared by number", () => {
  assert.deepEqual(parseVersion("0.2.0"), [0, 2, 0]);
  assert.equal(parseVersion("0.2.0-beta.1"), null);
  assert.equal(parseVersion("latest"), null);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("0.2.0", "0.2.0") === 0);
  assert.ok(compareVersions("0.1.1", "0.2.0") < 0);
  assert.equal(compareVersions("junk", "0.2.0"), 0);
});

test("flags", () => {
  assert.deepEqual(parseUpdateArgs(["--check"]), { check: true, yes: false, unknown: [] });
  assert.deepEqual(parseUpdateArgs(["-y"]), { check: false, yes: true, unknown: [] });
  assert.deepEqual(parseUpdateArgs(["--force"]).unknown, ["--force"]);
});

test("up to date: says so and runs nothing", async () => {
  const n = fakeNpm("/x");
  const r = await updateCommand([], base({ current: "0.2.0", runNpm: n.runNpm }));
  assert.equal(r.exitCode, 0);
  assert.match(r.lines[0], /up to date/);
  assert.equal(n.calls.length, 0);
});

test("a newer local build is never 'updated' backwards", async () => {
  const n = fakeNpm("/x");
  const r = await updateCommand([], base({ current: "0.3.0", runNpm: n.runNpm }));
  assert.match(r.lines[0], /up to date/);
  assert.equal(n.calls.length, 0);
});

test("--check reports a newer version and installs nothing", async () => {
  const n = fakeNpm("/x");
  const r = await updateCommand(["--check"], base({ runNpm: n.runNpm }));
  assert.equal(r.exitCode, 0);
  assert.match(r.lines[0], /0\.1\.1 -> 0\.2\.0/);
  assert.equal(n.calls.length, 0);
});

test("registry unreachable: explains, offers the manual command, exits 1", async () => {
  const r = await updateCommand([], base({ fetchLatest: async () => { throw new Error("getaddrinfo ENOTFOUND"); } }));
  assert.equal(r.exitCode, 1);
  assert.match(r.lines.join("\n"), /Could not check.*ENOTFOUND/s);
  assert.match(r.lines.join("\n"), /npm install -g @nomajorconcerns\/cephalo@latest/);
});

test("a git checkout or npm link is never replaced", async () => {
  const { root } = globalLayout();
  const n = fakeNpm(root);
  const r = await updateCommand(["--yes"], base({ runNpm: n.runNpm, selfPath: path.join(os.tmpdir(), "somewhere-else", "dist", "updatecmd.js") }));
  assert.equal(r.exitCode, 1);
  assert.match(r.lines.join("\n"), /not installed with `npm install -g`/);
  assert.ok(!n.calls.some((c) => c[0] === "install"), "no install was run");
  assert.equal(isGlobalNpmInstall(path.join(os.tmpdir(), "x", "cli.js"), root), false);
});

test("--yes installs the exact newest version globally", async () => {
  const { root, self } = globalLayout();
  const n = fakeNpm(root);
  const r = await updateCommand(["--yes"], base({ runNpm: n.runNpm, selfPath: self }));
  assert.equal(r.exitCode, 0);
  assert.match(r.lines[0], /Updated Cephalo 0\.1\.1 -> 0\.2\.0/);
  const install = n.calls.find((c) => c[0] === "install")!;
  assert.deepEqual(install.slice(0, 3), ["install", "-g", "@nomajorconcerns/cephalo@0.2.0"]);
  assert.match(r.lines.join("\n"), /rules, audit log, settings and license were not touched/);
});

test("without --yes it asks; no answer means nothing is installed", async () => {
  const { root, self } = globalLayout();
  const no = fakeNpm(root);
  const declined = await updateCommand([], base({ runNpm: no.runNpm, selfPath: self, confirm: async () => false }));
  assert.equal(declined.exitCode, 0);
  assert.equal(declined.lines.at(-1), "Not installed.");
  assert.ok(!no.calls.some((c) => c[0] === "install"));

  const noTty = fakeNpm(root);
  const r = await updateCommand([], base({ runNpm: noTty.runNpm, selfPath: self }));
  assert.equal(r.exitCode, 1);
  assert.match(r.lines.join("\n"), /cephalo update --yes/);
  assert.ok(!noTty.calls.some((c) => c[0] === "install"));

  const yes = fakeNpm(root);
  const ok = await updateCommand([], base({ runNpm: yes.runNpm, selfPath: self, confirm: async () => true }));
  assert.equal(ok.exitCode, 0);
  assert.ok(yes.calls.some((c) => c[0] === "install"));
});

test("a failed install reports the reason and the manual command", async () => {
  const { root, self } = globalLayout();
  const n = fakeNpm(root, 1);
  const r = await updateCommand(["--yes"], base({ runNpm: n.runNpm, selfPath: self }));
  assert.equal(r.exitCode, 1);
  assert.match(r.lines.join("\n"), /EACCES/);
  assert.match(r.lines.join("\n"), /npm install -g @nomajorconcerns\/cephalo@0\.2\.0/);
});

test("unknown options are refused", async () => {
  const r = await updateCommand(["--force"], base({}));
  assert.equal(r.exitCode, 1);
  assert.match(r.lines[0], /Unknown option: --force/);
});

test("agents cannot update Cephalo themselves", () => {
  for (const id of ["win32", "darwin", "linux"]) {
    const p = getPlatform(id);
    const rules = [...DEFAULT_RULES, ...activePlatformRules(DEFAULT_RULES, p)];
    for (const c of ["cephalo update", "cephalo update --yes", "cephalo.cmd update --yes", "node C:/x/cephalo/dist/cli.js update --yes"]) {
      assert.equal(evaluate({ command: c }, rules, p).rule?.id, "no-self-approve", `${id}: ${c}`);
    }
    assert.equal(evaluate({ command: "cephalo doctor" }, rules, p).decision, "allow");
  }
});
