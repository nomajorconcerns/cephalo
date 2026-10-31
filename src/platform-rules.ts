import type { Rule } from "./rules.js";
import { ANY_TOKEN_SOURCE } from "./vault/patterns.js";

const cmd = (id: string, description: string, pattern: string): Rule => ({ id, description, type: "command", pattern, action: "block" });

/**
 * Built-in rules that protect Cephalo itself. They apply on every OS, are not stored in rules.yml, and can be
 * overridden only by a rule with the same id. They exist so an agent cannot approve its own MCP servers.
 */
export const SYSTEM_RULES: Rule[] = [
  {
    id: "protect-cephalo-policy",
    description: "Writing Cephalo's MCP allowlist, tool approvals or tripwire state",
    type: "path",
    on: "write",
    pattern: "[\\/\\\\]\\.cephalo[\\/\\\\](mcp[^\\/\\\\]*$|tripwire([\\/\\\\.]|$))",
    action: "block",
  },
  {
    id: "protect-vault-files",
    description: "Reading or writing Cephalo's secrets vault files",
    type: "path",
    on: "any",
    pattern: "[\\/\\\\]\\.cephalo[\\/\\\\]vault[^\\/\\\\]*$",
    action: "block",
  },
  cmd(
    "no-vault-extract",
    "Changing or reading the secrets vault outside `cephalo run` (vault set/allow/remove/reveal, OS key APIs, the vault files)",
    "(\\bcephalo(\\.cmd|\\.ps1)?|cli\\.js[\"']?)\\s+vault\\s+(set|allow|remove|rm|reveal)\\b|\\.cephalo[\\/\\\\]vault|\\b(ProtectedData|Unprotect)\\b|\\bsecret-tool\\s+(lookup|search|clear)\\b",
  ),
  cmd(
    "secret-in-command",
    "A literal API token in a command. Store it with `cephalo vault set NAME` (the user does this) and run with `cephalo run --env NAME -- ...`",
    ANY_TOKEN_SOURCE,
  ),
  cmd("no-self-approve", "An agent approving MCP servers, or releasing/disabling the tripwire, itself", "(\\bcephalo(\\.cmd|\\.ps1)?|cli\\.js[\"']?)\\s+(mcp\\s+(allow|approve|pin|mode|trust)|tripwire\\s+(clear|mode|reset|allow))\\b"),
];

/** Applies on every POSIX system (macOS and Linux). */
export const POSIX_RULES: Rule[] = [
  cmd("rm-long-flags", "rm with separate or long recursive+force flags", "\\brm\\b(?=[^;&|\\n]*(\\s-[a-z]*r[a-z]*\\b|--recursive))(?=[^;&|\\n]*(\\s-[a-z]*f[a-z]*\\b|--force))"),
  cmd("no-preserve-root", "rm --no-preserve-root", "--no-preserve-root"),
  cmd("pipe-to-shell", "Piping a download straight into a shell", "\\b(curl|wget)\\b[^|\\n]*\\|\\s*(sudo\\s+)?(ba|z|da|k)?sh\\b"),
  cmd("chmod-chown-system", "Recursive chmod/chown on / or a system directory", "\\b(chmod|chown)\\s+(-[a-z]*R[a-z]*|--recursive)\\b[^;&|\\n]*\\s(/|/etc|/usr|/var|/bin|/sbin|/boot|/lib|/opt|/home|~)/?(\\s|$|[;&|])"),
];

export const WINDOWS_RULES: Rule[] = [
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
