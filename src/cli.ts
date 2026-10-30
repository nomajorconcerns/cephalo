#!/usr/bin/env node
import { appendAudit, formatAudit, readAudit } from "./audit.js";
import { evaluate } from "./engine.js";
import { runHook } from "./hooks.js";
import {
  installClaude,
  installHermes,
  uninstallClaude,
  uninstallHermes,
} from "./install.js";
import { printBanner } from "./banner.js";
import { getVersion } from "./version.js";

const USAGE = `Usage:
  cephalo test "<command>"            Check a shell command against the rules
  cephalo hook claude|hermes          Hook entry point (reads JSON on stdin)
  cephalo log [--blocked] [--limit N] Show recent audit entries
  cephalo install claude|hermes       Add Cephalo's hook to the agent's config
  cephalo uninstall claude|hermes     Remove Cephalo's hook from the agent's config
`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "hook") {
    // NEVER print the banner (or any non-JSON text) here: Claude Code and
    // Hermes parse hook stdout as JSON, so extra output breaks the decision.
    const agent = rest[0];
    if (agent !== "claude" && agent !== "hermes") {
      process.stderr.write(USAGE);
      return 1; // non-blocking error for the agent
    }
    let raw = "";
    try {
      raw = await readStdin();
    } catch (e) {
      process.stderr.write(`cephalo: could not read stdin (allowing call): ${(e as Error).message}\n`);
    }
    const out = runHook(agent, raw);
    if (out) process.stdout.write(out + "\n");
    return 0;
  }

  if (cmd === "test") {
    const command = rest.join(" ");
    if (!command) {
      process.stderr.write(USAGE);
      return 1;
    }
    const res = evaluate({ command });
    try {
      appendAudit({
        ts: new Date().toISOString(),
        agent: "cli",
        tool: "test",
        command,
        decision: res.decision,
        ...(res.rule ? { rule: res.rule.id } : {}),
      });
    } catch (e) {
      process.stderr.write(`cephalo: audit log failed: ${(e as Error).message}\n`);
    }
    console.log(
      res.decision === "block" && res.rule
        ? `🛑 BLOCKED (${res.rule.id}: ${res.rule.description})`
        : "✓ ALLOWED",
    );
    return 0;
  }

  if (cmd === "log") {
    let limit = 20;
    const blocked = rest.includes("--blocked");
    const i = rest.indexOf("--limit");
    if (i >= 0) {
      limit = Number(rest[i + 1]);
      if (!Number.isInteger(limit) || limit < 0) {
        process.stderr.write("cephalo: --limit needs a non-negative integer\n");
        return 1;
      }
    }
    const entries = readAudit({ blocked, limit });
    if (entries.length === 0) console.log("No audit entries.");
    for (const e of entries) console.log(formatAudit(e));
    return 0;
  }

  if (cmd === "install" || cmd === "uninstall") {
    const target = rest[0];
    if (target !== "claude" && target !== "hermes") {
      process.stderr.write(USAGE);
      return 1;
    }
    const fn =
      cmd === "install"
        ? target === "claude" ? installClaude : installHermes
        : target === "claude" ? uninstallClaude : uninstallHermes;
    try {
      for (const line of fn()) console.log(line);
      return 0;
    } catch (e) {
      process.stderr.write(`cephalo: ${(e as Error).message}\n`);
      return 1;
    }
  }

  if (cmd === "init") {
    printBanner(getVersion());
    console.log(
      "cephalo init is not implemented yet. To protect your agents run: cephalo install claude, cephalo install hermes",
    );
    return 0;
  }

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printBanner(getVersion());
    process.stdout.write(USAGE);
    return 0;
  }

  process.stderr.write(USAGE);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`cephalo: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
