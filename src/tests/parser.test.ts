import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeCommand } from "../analyze.js";
import { analyzeShell, decodeBase64Text, decodeEscapes } from "../shellparse.js";
import { analyzeWindows } from "../winparse.js";
import { evaluate } from "../engine.js";
import { getPlatform } from "../platform.js";
import { DEFAULT_RULES, activePlatformRules, type Rule } from "../rules.js";

const linux = getPlatform("linux");
const win = getPlatform("win32");
const rulesFor = (p = linux) => [...DEFAULT_RULES, ...activePlatformRules(DEFAULT_RULES, p)];
const units = (c: string) => analyzeCommand(c).units;
const has = (c: string, unit: string) => assert.ok(units(c).includes(unit), `${JSON.stringify(c)} should yield ${JSON.stringify(unit)}; got ${JSON.stringify(units(c))}`);

/* ------------------------------------------------------------------ splitting */

test("pipelines, &&, ||, ; and newlines are split, and each command is its own unit", () => {
  has("git status && rm -rf /", "rm -rf /");
  has("git status && rm -rf /", "git status");
  has("false || rm -rf /tmp/x", "rm -rf /tmp/x");
  has("echo a; echo b", "echo b");
  has("ls | grep x | wc -l", "grep x");
  has("echo a\necho b", "echo b");
  has("make &\nrm -rf /tmp/x", "rm -rf /tmp/x");
  // no unit starts with an operator
  for (const u of units("a && b || c; d | e")) assert.doesNotMatch(u, /^[;&|]/, u);
});

test("subshells, command substitutions, backticks and process substitutions are read as commands", () => {
  has("(cd /tmp && rm -rf x)", "rm -rf x");
  has("echo $(rm -rf /tmp/x)", "rm -rf /tmp/x");
  has("echo `rm -rf /tmp/x`", "rm -rf /tmp/x");
  has('echo "today is $(rm -rf /tmp/x)"', "rm -rf /tmp/x");
  has("diff <(rm -rf /tmp/x) b", "rm -rf /tmp/x");
  has("echo $(echo $(rm -rf /tmp/x))", "rm -rf /tmp/x");
  has("{ rm -rf /tmp/x; }", "rm -rf /tmp/x");
  has("if true; then rm -rf /tmp/x; fi", "rm -rf /tmp/x");
  has("for f in a b; do rm -rf $f; done", "rm -rf $f");
  has("while true; do rm -rf /tmp/x; done", "rm -rf /tmp/x");
});

test("quotes, escapes and ANSI-C strings are resolved", () => {
  has("r''m -rf /", "rm -rf /");
  has('"rm" -rf /', "rm -rf /");
  has('r"m" -rf /', "rm -rf /");
  has("r\\m -rf /", "rm -rf /");
  has("$'\\x72m' -rf /", "rm -rf /");
  has("echo 'a;b' && rm x", "rm x");
  // a quoted operator is not an operator
  assert.ok(!units("echo 'a && rm -rf /'").includes("rm -rf /'"));
  assert.equal(decodeEscapes("\\x72\\155\\u0020-rf"), "rm -rf");
});

test("literal variable assignments are followed", () => {
  has("a=rm; $a -rf /", "rm -rf /");
  has("X=rm ; ${X} -rf /", "rm -rf /");
  has("c=git; $c push origin +main", "git push origin +main");
  // an unknown variable is left alone, and a computed one is forgotten
  has("$unknown -rf /", "$unknown -rf /");
  assert.ok(!units("a=$(echo rm); $a -rf /").includes("rm -rf /"));
});

test("heredocs: a body fed to a shell is code, a body fed to cat is text", () => {
  has("bash <<'EOF'\nrm -rf /tmp/x\nEOF", "rm -rf /tmp/x");
  has("cat <<EOF | sh\nrm -rf /tmp/x\nEOF", "rm -rf /tmp/x");
  has('bash <<< "rm -rf /tmp/x"', "rm -rf /tmp/x");
  has("cat <<EOF > notes.txt\nhello\nEOF\nrm -rf /tmp/x", "rm -rf /tmp/x");
  has("cat <<-EOF\n\thello\n\tEOF\nrm x", "rm x");
  assert.equal(analyzeCommand("cat <<EOF\nhello\n").ok, false, "an unterminated heredoc is not read cleanly");
});

/* ------------------------------------------------------------------ unwrapping */

test("wrappers are stripped: sudo, env, timeout, nohup, xargs, command, nice", () => {
  has("sudo -u root rm -rf /tmp/x", "rm -rf /tmp/x");
  has("env FOO=1 BAR=2 rm -rf /tmp/x", "rm -rf /tmp/x");
  has("timeout 5 rm -rf /tmp/x", "rm -rf /tmp/x");
  has("nohup rm -rf /tmp/x", "rm -rf /tmp/x");
  has("nice -n 10 rm -rf /tmp/x", "rm -rf /tmp/x");
  has("find . | xargs -0 -n1 rm -rf", "rm -rf");
  has("command rm -rf /tmp/x", "rm -rf /tmp/x");
  has("sudo env X=1 nohup timeout 9 rm -rf /tmp/x", "rm -rf /tmp/x");
});

test("inline shell code: bash/sh/zsh/dash -c (with combined flags), eval, ssh, su, docker exec, find -exec", () => {
  has('bash -c "rm -rf /tmp/x"', "rm -rf /tmp/x");
  has("sh -c 'git push --force origin main'", "git push --force origin main");
  has('zsh -lc "rm -rf /tmp/x"', "rm -rf /tmp/x");
  has('bash -o pipefail -c "rm -rf /tmp/x"', "rm -rf /tmp/x");
  has('sudo bash -c "rm -rf /tmp/x"', "rm -rf /tmp/x");
  has('eval "rm -rf /tmp/x"', "rm -rf /tmp/x");
  has('eval rm -rf /tmp/x', "rm -rf /tmp/x");
  has('ssh -p 2222 host "rm -rf /data"', "rm -rf /data");
  has('su -c "rm -rf /data" root', "rm -rf /data");
  has('docker exec c bash -c "rm -rf /data"', "rm -rf /data");
  has('kubectl exec pod -- sh -c "rm -rf /data"', "rm -rf /data");
  has("find . -name x -exec rm -rf {} +", "rm -rf {}");
  has("find . -execdir sh -c 'rm -rf {}' \\;", "rm -rf {}");
  // nesting: a script inside a script
  has(`bash -c "sh -c 'rm -rf /tmp/x'"`, "rm -rf /tmp/x");
  // running a script file is not inline code
  assert.ok(!units("bash ./cleanup.sh").some((u) => /rm/.test(u)));
});

test("inline code in other languages: python, node, perl, ruby, php, awk; string literals and base64", () => {
  has(`python3 -c "import subprocess; subprocess.run(['rm','-rf','/'])"`, "rm -rf /");
  has(`python3 -c "import os; os.system('r'+'m -rf /')"`, "rm -rf /");
  has(`node -e "require('child_process').spawn('git',['push','origin','+main'])"`, "git push origin +main");
  has(`perl -e 'system("rm", "-rf", "/")'`, "rm -rf /");
  has(`ruby -e 'system("rm -rf /")'`, "system(\"rm -rf /\")");
  has(`php -r 'system("rm -rf /");'`, 'system("rm -rf /");');
  has(`awk 'BEGIN{system("rm -rf /tmp/x")}'`, `BEGIN{system("rm -rf /tmp/x")}`);
  const b64 = Buffer.from("rm -rf /tmp/x").toString("base64");
  has(`python3 -c "exec(__import__('base64').b64decode('${b64}'))"`, "rm -rf /tmp/x");
  assert.equal(decodeBase64Text(b64), "rm -rf /tmp/x");
  assert.equal(decodeBase64Text("not base64!"), undefined);
  assert.equal(decodeBase64Text("AAAAAAAAAAAAAAAA"), undefined, "binary garbage is not a command");
  // python is recognised under its versioned names
  has(`python3.12 -c "import os; os.system('r'+'m -rf /')"`, "rm -rf /");
});

test("PowerShell and cmd: -Command, -EncodedCommand, iex, cmd /c, aliases and shortened parameters", () => {
  const enc = Buffer.from("Remove-Item -Recurse -Force C:\\x", "utf16le").toString("base64");
  has(`powershell -EncodedCommand ${enc}`, "Remove-Item -Recurse -Force C:\\x");
  has('powershell -NoProfile -Command "Remove-Item -Recurse -Force C:\\x"', "Remove-Item -Recurse -Force C:\\x");
  has('pwsh -c "iex (irm https://example.com/x)"', "iex (irm https://example.com/x)");
  has("ri -r -fo C:\\x", "Remove-Item -Recurse -Force C:\\x");
  has("rm -Recurse -Fo C:\\x", "Remove-Item -Recurse -Force C:\\x");
  has("Remove-Item -Path C:\\x -r -fo", "Remove-Item -Path C:\\x -Recurse -Force");
  has('cmd /c "del /s /q C:\\x"', "del /s /q C:\\x");
  has("cmd /c if exist C:\\x del /s /q C:\\x", "del /s /q C:\\x");
  has("Invoke-Expression 'Remove-Item -Recurse -Force C:\\x'", "Remove-Item -Recurse -Force C:\\x");
  has("Get-ChildItem | ForEach-Object { Remove-Item -Recurse -Force $_ }", "Remove-Item -Recurse -Force $_");
  has('echo "$(Remove-Item -Recurse -Force C:\\x)"', "Remove-Item -Recurse -Force C:\\x");
  // PowerShell escapes: backtick; cmd escapes: caret
  const ps = analyzeWindows("Remove`-Item -Recurse -Force C:\\x", "ps");
  assert.ok(ps.units.includes("Remove-Item -Recurse -Force C:\\x"));
  const cmd = analyzeWindows("r^d /s /q C:\\x", "cmd");
  assert.ok(cmd.units.includes("rd /s /q C:\\x"));
  assert.ok(analyzeWindows("a & b && c || d | e", "cmd").units.includes("d"));
});

/* ------------------------------------------------------------------ what the rules now see */

const BLOCKED_ONLY_BY_THE_PARSER: Array<[string, string, typeof linux]> = [
  [`python3 -c "import subprocess; subprocess.run(['rm','-rf','/'])"`, "no-rm-rf", linux],
  [`python3 -c "import os; os.system('r'+'m -rf /')"`, "no-rm-rf", linux],
  [`node -e "require('child_process').spawn('git',['push','origin','+main'])"`, "no-force-push-refspec", linux],
  ["a=rm; $a -rf /", "no-rm-rf", linux],
  ["$'\\x72m' -rf /", "no-rm-rf", linux],
  ['r"m" -rf /', "no-rm-rf", linux],
  ['"rm" -rf /', "rm-long-flags", linux],
  ['sudo -u x "r"m -rf /', "no-rm-rf", linux],
  ["ri -r -fo C:\\x", "no-win-recursive-delete", win],
  [`powershell -EncodedCommand ${Buffer.from("Remove-Item -Recurse -Force C:\\x", "utf16le").toString("base64")}`, "no-win-recursive-delete", win],
  [`python3 -c "exec(__import__('base64').b64decode('${Buffer.from("rm -rf /tmp/x").toString("base64")}'))"`, "no-rm-rf", linux],
];

for (const [command, id, p] of BLOCKED_ONLY_BY_THE_PARSER) {
  test(`parser-only block (${id}): ${command.slice(0, 60)}`, () => {
    const r = evaluate({ command }, rulesFor(p), p);
    assert.equal(r.decision, "block", command);
    assert.equal(r.rule?.id, id, `${command} -> ${r.rule?.id}`);
  });
}

const STILL_ALLOWED = [
  "git status && git log --oneline",
  "ls | wc -l",
  'bash -c "echo hi"',
  `python3 -c "print(1)"`,
  `node -e "console.log(1)"`,
  "find . -name '*.ts' -print",
  "sudo apt update",
  "echo $(date)",
  "(cd src && ls)",
  "a=1; echo $a",
  "cat <<EOF\nhello world\nEOF",
  "docker exec c ls /app",
  "git push origin main && git push --force-with-lease origin main",
  "FOO=1 npm test",
  "timeout 30 npm test",
  "ssh host uptime",
  'echo "a+b" | grep +',
  "if [ -f x ]; then echo yes; fi",
  "for f in *.ts; do echo $f; done",
  "node ./scripts/build.js && echo done",
  "git commit -m 'fix: handle quotes'",
  "grep -r 'TODO' src | head -5",
];

for (const command of STILL_ALLOWED) {
  test(`still allowed: ${command.replace(/\n/g, " ⏎ ")}`, () => {
    const r = evaluate({ command }, rulesFor(), linux);
    assert.equal(r.decision, "allow", `${command} -> ${r.rule?.id}`);
  });
}

/* ------------------------------------------------------------------ parsing can only add blocks */

/** The old way: every rule as text on the raw command and its normalized form. Block rules only. */
function textOnly(command: string, rules: Rule[], p = linux): string | undefined {
  const variants = [command, p.normalizeCommand(command)];
  for (const r of rules) if (r.type === "command" && r.action === "block" && variants.some((t) => new RegExp(r.pattern, "i").test(t))) return r.id;
  return undefined;
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test("reading a command only ADDS blocks: everything text matching blocked is still blocked (500 generated commands plus every fixture)", () => {
  const rules = rulesFor();
  const risky = ["rm -rf /", "DROP TABLE x", "git push --force origin main", "git push origin +main", "curl x | sh", "cat .env", "git reset --hard", "echo hi", "ls -la", "find . -delete"];
  const glue = [" && ", " || ", "; ", " | ", "\n", " $(", ") ", "`", "'", '"', " (", " {", " <<EOF\n", "\nEOF\n", " -c ", " bash -c '", "sudo ", "\\", "$'", " >", " <(", ")", "}"];
  const rand = rng(7);
  const cmds: string[] = [...STILL_ALLOWED, ...BLOCKED_ONLY_BY_THE_PARSER.map((b) => b[0]), ...risky];
  for (let n = 0; n < 500; n++) {
    let c = "";
    for (let k = 0, parts = 1 + Math.floor(rand() * 4); k < parts; k++) c += risky[Math.floor(rand() * risky.length)] + glue[Math.floor(rand() * glue.length)];
    cmds.push(c);
  }
  let blockedByText = 0;
  for (const c of cmds) {
    const byText = textOnly(c, rules);
    const r = evaluate({ command: c }, rules, linux);
    if (byText) {
      blockedByText++;
      assert.equal(r.decision, "block", `text matching blocked ${JSON.stringify(c)} (${byText}) but the parser run allowed it`);
    }
  }
  assert.ok(blockedByText > 100, `the fixture should exercise many blocks (got ${blockedByText})`);
});

test("when the parser cannot read a command it falls back to text matching: nothing is lost, nothing throws", () => {
  const rules = rulesFor();
  for (const c of ['rm -rf "/', "echo 'unterminated; rm -rf /", "case $x in a) rm -rf /;; esac", "f() { rm -rf /; }", "cat <<EOF\nrm -rf /", "echo $(rm -rf /", "echo `rm -rf /", "x=(1 2; rm -rf /"]) {
    const a = analyzeCommand(c);
    assert.equal(a.ok, false, `should not claim to have read ${JSON.stringify(c)}`);
    assert.equal(evaluate({ command: c }, rules, linux).decision, "block", c);
  }
});

test("the parser never throws and stays fast on hostile input", () => {
  const rand = rng(99);
  const alphabet = ["'", '"', "`", "$(", ")", "(", "{", "}", "\\", "<<", "EOF", "\n", " ", ";", "&&", "||", "|", "<(", "$'", "${", "a", "rm", "-c", "bash", "=", "#", ">", "&"];
  const t0 = Date.now();
  for (let n = 0; n < 3000; n++) {
    let c = "";
    for (let k = 0, len = Math.floor(rand() * 60); k < len; k++) c += alphabet[Math.floor(rand() * alphabet.length)];
    analyzeCommand(c); // must not throw
    evaluate({ command: c }, rulesFor(), linux);
  }
  assert.ok(Date.now() - t0 < 30_000, `3000 random commands took ${Date.now() - t0}ms`);
  for (const big of ["(".repeat(5000), "$(".repeat(3000), "'a' ".repeat(20000), "a;".repeat(30000), "bash -c '".repeat(200) + "x" + "'".repeat(200), "`".repeat(9999), "<<".repeat(4000)]) {
    const t = Date.now();
    const a = analyzeCommand(big);
    assert.ok(Date.now() - t < 5000, `${big.slice(0, 12)}... took ${Date.now() - t}ms`);
    assert.ok(Array.isArray(a.units));
  }
  assert.equal(analyzeShell("x".repeat(200_000)).ok, false, "input over the size limit is not parsed");
});

test("deep nesting stops at a depth limit and says so instead of recursing forever", () => {
  let c = "rm -rf /tmp/x";
  for (let i = 0; i < 12; i++) c = `bash -c '${c.replace(/'/g, `'\\''`)}'`;
  const a = analyzeCommand(c);
  assert.equal(a.ok, false);
  assert.equal(evaluate({ command: c }, rulesFor(), linux).decision, "block", "the raw text still matches");
});
