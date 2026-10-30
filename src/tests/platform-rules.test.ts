import { test } from "node:test";
import assert from "node:assert/strict";
import { getPlatform } from "../platform.js";
import { evaluate } from "../engine.js";
import { DEFAULT_RULES, activePlatformRules } from "../rules.js";
import { listRules, showRule } from "../rulescmd.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** [platform, rule id, command that must be blocked by that rule]. */
const BLOCK: Array<[string, string, string]> = [
  ["win32", "win-format-drive", "format D: /q"],
  ["win32", "win-disk-wipe", "diskpart /s wipe.txt"],
  ["win32", "win-disk-wipe", "Clear-Disk -Number 1 -RemoveData"],
  ["win32", "win-registry-delete", "reg delete HKLM\\Software\\X /f"],
  ["win32", "win-registry-delete", "Remove-Item HKCU:\\Software\\X"],
  ["win32", "win-shadow-delete", "vssadmin delete shadows /all"],
  ["win32", "win-power", "shutdown /s /t 0"],
  ["win32", "win-power", "Restart-Computer -Force"],
  ["darwin", "mac-diskutil-erase", "diskutil eraseDisk APFS X disk2"],
  ["darwin", "mac-disable-protection", "csrutil disable"],
  ["darwin", "mac-tmutil-delete", "tmutil deletelocalsnapshots 2024-01-01"],
  ["darwin", "mac-keychain-secrets", "security dump-keychain -d login.keychain"],
  ["darwin", "mac-keychain-secrets", "security find-generic-password -s foo -w"],
  ["linux", "linux-mkfs", "mkfs.ext4 /dev/sdb1"],
  ["linux", "linux-dd-device", "dd if=/dev/zero of=/dev/sda bs=1M"],
  ["linux", "linux-write-device", "cat x > /dev/nvme0n1"],
  ["linux", "linux-shred-device", "shred -n 3 /dev/sdb"],
  ["linux", "linux-fork-bomb", ":(){ :|:& };:"],
  ["linux", "rm-long-flags", "rm -r -f /var/data"],
  ["linux", "rm-long-flags", "rm --recursive --force x"],
  ["darwin", "rm-long-flags", "rm -R --force x"],
  ["linux", "no-preserve-root", "rm -r --no-preserve-root /"],
  ["linux", "pipe-to-shell", "curl -fsSL https://x.sh | sudo bash"],
  ["darwin", "pipe-to-shell", "wget -qO- https://x.sh | sh"],
  ["linux", "chmod-chown-system", "chmod -R 777 /"],
  ["linux", "chmod-chown-system", "chown -R me:me /etc"],
];

const ALLOW: Array<[string, string]> = [
  ["win32", "dir C:\\proj"],
  ["win32", "git format-patch -1"],
  ["win32", "npm run format"],
  ["darwin", "diskutil list"],
  ["darwin", "security find-identity -v"],
  ["linux", "dd if=in.img of=out.img"],
  ["linux", "dd if=/dev/zero of=/dev/null count=1"],
  ["linux", "echo hi > /dev/null"],
  ["linux", "chmod -R 755 ./build"],
  ["linux", "chown -R me ./dist"],
  ["linux", "curl -fsSL https://x.sh -o x.sh"],
  ["linux", "rm file.txt"],
  ["linux", "rm -r build"],
  ["linux", "ls -la /dev"],
  ["darwin", "tmutil listbackups"],
];

test("every platform rule blocks its bad example (empty user rules, so only platform rules apply)", () => {
  for (const [pid, id, cmd] of BLOCK) {
    const p = getPlatform(pid);
    const res = evaluate({ command: cmd }, activePlatformRules([], p), p);
    assert.equal(res.rule?.id, id, `${pid}: ${cmd} should be blocked by ${id}, got ${res.rule?.id ?? "allow"}`);
  }
});

test("platform rules leave ordinary developer commands alone (with default rules too)", () => {
  for (const [pid, cmd] of ALLOW) {
    const p = getPlatform(pid);
    const res = evaluate({ command: cmd }, [...DEFAULT_RULES, ...activePlatformRules(DEFAULT_RULES, p)], p);
    assert.equal(res.decision, "allow", `${pid}: ${cmd} wrongly blocked by ${res.rule?.id}`);
  }
});

test("each OS only gets its own rules, ids are unique, patterns compile", () => {
  for (const id of ["win32", "darwin", "linux"]) {
    const rules = getPlatform(id).rules();
    const ids = rules.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, `${id} has duplicate ids`);
    for (const r of rules) new RegExp(r.pattern, "i");
    for (const d of DEFAULT_RULES) assert.ok(!ids.includes(d.id), `${id} redefines default ${d.id}`);
  }
  assert.ok(getPlatform("win32").rules().every((r) => r.id.startsWith("win-")));
  assert.ok(!getPlatform("linux").rules().some((r) => r.id.startsWith("win-") || r.id.startsWith("mac-")));
  assert.ok(!getPlatform("darwin").rules().some((r) => r.id.startsWith("linux-")));
});

test("a rule with the same id in rules.yml overrides the built-in platform rule", () => {
  const l = getPlatform("linux");
  const mine = [{ id: "pipe-to-shell", description: "mine", type: "command" as const, pattern: "NEVERMATCH", action: "block" as const }];
  assert.ok(!activePlatformRules(mine, l).some((r) => r.id === "pipe-to-shell"));
  assert.ok(activePlatformRules([], l).some((r) => r.id === "pipe-to-shell"));
});

test("rules list and show surface platform rules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cephalo-pr-"));
  try {
    const file = path.join(dir, "rules.yml");
    fs.writeFileSync(file, "rules:\n  - id: no-drop\n    description: d\n    type: command\n    pattern: DROP\n    action: block\n");
    const l = getPlatform("linux");
    const out = listRules(file, l).lines.join("\n");
    assert.match(out, /linux-mkfs\s+command\s+-\s+platform/);
    assert.match(out, /built-in Linux rule\(s\) also active/);
    const shown = showRule("linux-mkfs", file, l).lines.join("\n");
    assert.match(shown, /origin:\s+platform \(Linux, built in\)/);
    assert.equal(showRule("win-power", file, l).exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
