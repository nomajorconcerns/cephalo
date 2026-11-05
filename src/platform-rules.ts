import path from "node:path";
import { fileURLToPath } from "node:url";
import { realish } from "./paths.js";
import type { Rule } from "./rules.js";
import { ANY_TOKEN_SOURCE } from "./vault/patterns.js";

const cmd = (id: string, description: string, pattern: string): Rule => ({ id, description, type: "command", pattern, action: "block" });

// ---- Building blocks for the shell rules that guard files. Slashes of either kind, because a command is matched as typed.
const SEP = String.raw`[\/\\]`;
/** Cephalo's rules file and audit log. */
const CEPHALO_FILES = String.raw`\.cephalo${SEP}(?:audit\.jsonl|rules\.yml|config\.yml|license\.json|egress\.yml|pro${SEP})`;
/** Claude Code's settings and Hermes' config. */
const AGENT_CONFIG = String.raw`\.claude${SEP}settings(?:\.local)?\.json|(?:\.hermes|\bhermes)${SEP}config\.yaml`;

/** A command that changes `target`: a verb that writes (redirect, tee, sed -i, rm, ...) before it, or a copy/move/link that ends on it. */
const writesTo = (target: string): string =>
  String.raw`(?:>>?|\btee\b|\bsed\s+-i|\brm\b|\bdel\b|\berase\b|\btruncate\b|\bset-content\b|\bout-file\b|\badd-content\b|\bremove-item\b|\bclear-content\b|\bdd\b|\bperl\s+-[a-z]*i|\bchmod\b|\bchown\b|\btouch\b|\bsponge\b)[^\n]*(?:${target})` +
  String.raw`|\b(?:cp|copy(?:-item)?|mv|move(?:-item)?|ren(?:ame)?(?:-item)?|install|ln|mklink|rsync)\b[^\n]*(?:${target})["']?\s*(?:$|[;&|])`;

/** Code that opens or writes a protected file: `open('<file>', 'w')`, `Path('<file>').write_text(...)`, `fs.writeFileSync('<file>', ...)`. Seen in python -c, node -e, and in Hermes execute_code text. */
const WRITE_FN = String.raw`(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|write_text|write_bytes|unlink(?:Sync)?|rmSync|rmtree|copyfile|copyFile(?:Sync)?|renameSync|os\.rename|os\.replace|os\.remove|symlink(?:Sync)?|truncate)`;
const codeWrites = (target: string): string =>
  String.raw`(?:${target})[^\n]{0,300}[,=]\s*['"][wax][+bt]{0,2}['"]` +
  String.raw`|(?:${target})[^\n]{0,200}\b${WRITE_FN}\b|\b${WRITE_FN}\b[^\n]{0,200}(?:${target})`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where Cephalo is installed: the folder above the compiled files this code runs from (the dist/ the agent's hook executes is inside it). */
export function defaultInstallRoots(): string[] {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return [...new Set([root, realish(root)])];
}

/**
 * Rules that keep the agent from editing the code its own hook runs. They are built from where Cephalo is installed,
 * so they follow an npm link or a global install. Writes through file tools (path rule) and through a shell (command rules).
 */
export function installGuardRules(roots: string[] = defaultInstallRoots()): Rule[] {
  const typed = roots.map((r) => escapeRe(r).replace(/(?:\\\\|\/)+/g, SEP)).join("|");
  const slashed = roots.map((r) => escapeRe(r.replace(/\\/g, "/"))).join("|");
  const dist = String.raw`(?:${typed})${SEP}dist(?:${SEP}[^\s;&|'"]*)?(?![\w-])`;
  // The Pro package, when it was installed next to Cephalo (a global install of the downloaded .tgz): its code runs in the hook too.
  const sibs = roots.filter((r) => path.basename(r) === "cephalo" && path.basename(path.dirname(r)) === "@nomajorconcerns").map((r) => path.join(path.dirname(r), "cephalo-pro"));
  const proTyped = sibs.map((r) => escapeRe(r).replace(/(?:\\\\|\/)+/g, SEP)).join("|");
  const proSlashed = sibs.map((r) => escapeRe(r.replace(/\\/g, "/"))).join("|");
  const proDirRe = String.raw`(?:${proTyped})(?:${SEP}[^\s;&|'"]*)?(?![\w-])`;
  const proGuard: Rule[] = sibs.length
    ? [
        { id: "protect-cephalo-pro-install", description: "Writing the installed Pro package (its code runs inside the hook)", type: "path", on: "write", pattern: `^(?:${proSlashed})(?:/|$)`, action: "block" },
        cmd("no-pro-install-tamper", "Changing the installed Pro package from a shell", writesTo(proDirRe)),
      ]
    : [];
  return [
    ...proGuard,
    {
      id: "protect-cephalo-install",
      description: "Writing Cephalo's installed files (the dist/ folder the hook runs): an agent could switch off its own guard",
      type: "path",
      on: "write",
      pattern: `^(?:${slashed})/dist(?:/|$)`,
      action: "block",
    },
    cmd(
      "no-protected-symlink",
      "Linking to Cephalo's data, the agent configs or Cephalo's install folder (a link would let a file tool write through it)",
      String.raw`\b(?:ln|mklink)\b[^\n]*(?:\.cephalo\b|\.claude\b|\.hermes\b|\bhermes${SEP}config\.yaml|${typed})|\bNew-Item\b[^\n]*-ItemType\s+(?:SymbolicLink|Junction|HardLink)\b[^\n]*(?:\.cephalo\b|\.claude\b|\.hermes\b)`,
    ),
    cmd("no-install-tamper", "Changing Cephalo's installed files (the dist/ folder the hook runs) from a shell", writesTo(dist)),
    cmd("no-protected-write-code", "Code that writes Cephalo's rules or audit log, the Claude Code or Hermes config, or Cephalo's installed files (open(..., 'w'), writeFile, write_text)", codeWrites(`${CEPHALO_FILES}|${AGENT_CONFIG}|${dist}`)),
  ];
}

/**
 * Built-in rules that protect Cephalo itself. They apply on every OS, are not stored in rules.yml, and can be
 * overridden only by a rule with the same id. They exist so an agent cannot approve its own MCP servers.
 */
export const SYSTEM_RULES: Rule[] = [
  {
    id: "protect-cephalo-policy",
    description: "Writing Cephalo's settings (config.yml), the Pro license and egress allowlist, the Pro package, MCP allowlist, tool approvals, tripwire state, integrity markers or local-model settings",
    type: "path",
    on: "write",
    pattern: "[\\/\\\\]\\.cephalo[\\/\\\\](mcp[^\\/\\\\]*$|models\\.yml[^\\/\\\\]*$|sync\\.yml[^\\/\\\\]*$|prices\\.yml[^\\/\\\\]*$|config\\.yml[^\\/\\\\]*$|license\\.json[^\\/\\\\]*$|egress\\.yml[^\\/\\\\]*$|pro([\\/\\\\]|$)|integrity([\\/\\\\]|$)|(judge|embed)-cache\\.json$|models-check\\.json$|asks([\\/\\\\]|$)|tripwire([\\/\\\\.]|$))",
    action: "block",
  },
  {
    id: "protect-audit-log",
    description: "Writing Cephalo's audit log or rules file (the record of what the agent did, and the limits on it)",
    type: "path",
    on: "write",
    pattern: "[\\/\\\\]\\.cephalo[\\/\\\\](audit\\.jsonl(\\.head)?|rules\\.yml)(\\.cephalo-backup-[\\w.-]+)?$",
    action: "block",
  },
  cmd(
    "no-audit-tamper",
    "Changing or deleting Cephalo's audit log, rules file or settings (config.yml) from a shell",
    "(>>?|\\btee\\b|\\bsed\\s+-i|\\brm\\b|\\bdel\\b|\\berase\\b|\\bmv\\b|\\bmove(-item)?\\b|\\bcp\\b|\\bcopy(-item)?\\b|\\btruncate\\b|\\bset-content\\b|\\bout-file\\b|\\badd-content\\b|\\bremove-item\\b|\\bclear-content\\b|\\bren(ame)?(-item)?\\b|\\bdd\\b)[^\\n]*\\.cephalo[\\/\\\\](audit\\.jsonl|rules\\.yml|config\\.yml|license\\.json|egress\\.yml|pro(?![\w.-]))",
  ),
  {
    id: "protect-vault-files",
    description: "Reading or writing Cephalo's secrets vault files",
    type: "path",
    on: "any",
    pattern: "[\\/\\\\]\\.cephalo[\\/\\\\]vault[^\\/\\\\]*$",
    action: "block",
  },
  {
    id: "protect-policy-key",
    description: "Reading or writing the key that signs shared policy (cephalo sync keygen)",
    type: "path",
    on: "any",
    pattern: "[\\/\\\\]\\.cephalo[\\/\\\\]policy-(signing\\.key|trusted\\.pub)[^\\/\\\\]*$",
    action: "block",
  },
  cmd(
    "no-vault-extract",
    "Changing or reading the secrets vault outside `cephalo run` (vault set/allow/remove/reveal, OS key APIs, the vault files)",
    "(\\bcephalo(\\.cmd|\\.ps1)?|cli\\.js[\"']?)\\s+vault\\s+(set|allow|remove|rm|reveal)\\b|\\.cephalo[\\/\\\\]vault|\\.cephalo[\\/\\\\]policy-signing\\.key|\\b(ProtectedData|Unprotect)\\b|\\bsecret-tool\\s+(lookup|search|clear)\\b",
  ),
  cmd(
    "secret-in-command",
    "A literal API token in a command. Store it with `cephalo vault set NAME` (the user does this) and run with `cephalo run --env NAME -- ...`",
    ANY_TOKEN_SOURCE,
  ),
  cmd("no-self-approve", "An agent approving MCP servers, releasing the tripwire, changing Cephalo's settings or rules, the egress allowlist or the Pro license, itself", "(\\bcephalo(\\.cmd|\\.ps1)?|cli\\.js[\"']?)\\s+(mcp\\s+(allow|approve|pin|mode|trust)|tripwire\\s+(clear|mode|reset|allow)|config\\s+set|rules\\s+reset|egress\\s+(allow|remove|mode)|pro\\s+(activate|renew|install|deactivate))\\b"),
  cmd("no-self-incident", "An agent adding or removing its own learned rules", "(\\bcephalo(\\.cmd|\\.ps1)?|cli\\.js[\"']?)\\s+incident\\b[^\\n]*(--use|\\bundo\\b)"),
  // ---- Bypass fixes in 0.2.0. Here, not in rules.yml, so they protect existing installs without any user action.
  cmd(
    "no-secret-shell",
    "A shell command that names a .env secret file (cat, grep, awk, cp, source, ... .env). .env.example is fine",
    String.raw`(?:^|[\s'"=:/\\<>(,])\.env(?:\.(?!(?:example|sample|template)\b)[\w.-]+)?(?=$|[\s'";&|)<>,])`,
  ),
  cmd("no-agent-config-tamper", "Changing the Claude Code or Hermes config from a shell (the file tools are already blocked)", writesTo(AGENT_CONFIG)),
  ...installGuardRules(),
];

/** Applies on every POSIX system (macOS and Linux). */
export const POSIX_RULES: Rule[] = [
  cmd("rm-long-flags", "rm with separate or long recursive+force flags", "\\brm\\b(?=[^;&|\\n]*(\\s-[a-z]*r[a-z]*\\b|--recursive))(?=[^;&|\\n]*(\\s-[a-z]*f[a-z]*\\b|--force))"),
  cmd("no-preserve-root", "rm --no-preserve-root", "--no-preserve-root"),
  cmd("pipe-to-shell", "Piping a download straight into a shell", "\\b(curl|wget)\\b[^|\\n]*\\|\\s*(sudo\\s+)?(ba|z|da|k)?sh\\b"),
  cmd("find-delete", "find -delete (recursive delete without rm)", "\\bfind\\b[^;&|\\n]*\\s-delete\\b"),
  cmd("find-exec-rm", "find -exec/-execdir rm (recursive delete without rm -rf)", "\\bfind\\b[^;&|\\n]*\\s-(exec|execdir|ok|okdir)\\s+(\\S*\\/)?rm\\b"),
  cmd("chmod-chown-system", "Recursive chmod/chown on / or a system directory", "\\b(chmod|chown)\\s+(-[a-z]*R[a-z]*|--recursive)\\b[^;&|\\n]*\\s(/|/etc|/usr|/var|/bin|/sbin|/boot|/lib|/opt|/home|~)/?(\\s|$|[;&|])"),
];

/**
 * Agents on Windows often run a POSIX shell (Git Bash, WSL, MSYS) for rm and find, so the rules for those apply there too.
 * (Found by the bypass benchmark: `rm -r -f ./build` was blocked on Linux and macOS but not on a Windows host.)
 */
const POSIX_SHELL_ON_WINDOWS = ["rm-long-flags", "no-preserve-root", "find-delete", "find-exec-rm"];

export const WINDOWS_RULES: Rule[] = [
  ...POSIX_RULES.filter((r) => POSIX_SHELL_ON_WINDOWS.includes(r.id)),
  cmd("win-format-drive", "Formatting a drive (format X:)", "\\bformat(\\.com)?\\s+[a-z]:(?![\\w\\\\/])"),
  cmd("win-disk-wipe", "Disk partitioning or wiping tools", "\\b(diskpart|Clear-Disk|Remove-Partition|Format-Volume|Initialize-Disk)\\b"),
  cmd("win-registry-delete", "Deleting registry keys or values", "\\breg(\\.exe)?\\s+delete\\b|Remove-Item(Property)?\\b[^;&|\\n]*\\bHK(LM|CU|CR|U):"),
  cmd("win-shadow-delete", "Deleting shadow copies or boot entries", "\\bvssadmin(\\.exe)?\\s+delete\\b|\\bwmic\\b[^;&|\\n]*\\bshadowcopy\\s+delete\\b|\\bbcdedit(\\.exe)?\\s+/delete\\b"),
  cmd("win-power", "Shutting down or restarting the machine", "\\bshutdown(\\.exe)?\\s+/[srp]\\b|\\b(Stop|Restart)-Computer\\b"),
];

export const MACOS_RULES: Rule[] = [
  cmd("mac-diskutil-erase", "diskutil erase/partition/zero a disk", "\\bdiskutil\\s+(erase\\w*|secureErase|partitionDisk|zeroDisk|randomDisk|apfs\\s+delete\\w*)\\b"),
  cmd("mac-disable-protection", "Disabling SIP or Gatekeeper", "\\bcsrutil\\s+disable\\b|\\bspctl\\s+--master-disable\\b"),
  cmd("mac-tmutil-delete", "Deleting or disabling Time Machine backups", "\\btmutil\\s+(delete|deletelocalsnapshots|disable)\\b"),
  cmd("mac-keychain-secrets", "Reading or deleting keychain secrets", "\\bsecurity\\s+(dump-keychain|delete-(generic-|internet-)?(password|keychain)|find-(generic|internet)-password\\b[^;&|\\n]*\\s-[a-z]*w)"),
  ...POSIX_RULES,
];

export const LINUX_RULES: Rule[] = [
  cmd("linux-mkfs", "Creating filesystems or wiping signatures", "\\b(mkfs(\\.\\w+)?|wipefs|mkswap)\\b"),
  cmd("linux-dd-device", "dd writing to a device", "\\bdd\\b[^;&|\\n]*\\bof=/dev/(?!null\\b|zero\\b|stdout\\b|stderr\\b|tty)"),
  cmd("linux-write-device", "Redirecting output onto a block device", ">\\s*/dev/(sd|nvme|hd|vd|xvd|mmcblk)\\w*"),
  cmd("linux-shred-device", "shred on a device", "\\bshred\\b[^;&|\\n]*\\s/dev/"),
  cmd("linux-fork-bomb", "Fork bomb", ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:"),
  ...POSIX_RULES,
];
