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
import { createInterface } from "node:readline";
import { printBanner, supportsColor } from "./banner.js";
import { runWatch } from "./watch.js";
import { applyAllow, applyMode, listMcp, planAllow, planMode, planPin, runScan } from "./mcpcmd.js";
import { mcpPolicyPath } from "./mcp/policy.js";
import { formatChecks, runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { listRules, resetRules, showRule } from "./rulescmd.js";
import { defaultRulesPath } from "./rules.js";
import { getVersion } from "./version.js";

const USAGE = `Usage:
  cephalo test "<command>"            Check a shell command against the rules
  cephalo hook claude|hermes          Hook entry point (reads JSON on stdin)
  cephalo log [--blocked] [--limit N] Show recent audit entries
  cephalo watch [--blocked] [--last N] [--no-color]
                                      Follow the audit log live (Ctrl+C to stop)
  cephalo mcp [list|allow|pin|scan|mode|path]
                                      MCP firewall: allowlist by command/URL, fingerprint tools, audit or enforce
  cephalo install claude|hermes       Add Cephalo's hook to the agent's config
  cephalo uninstall claude|hermes     Remove Cephalo's hook from the agent's config
  cephalo init [--yes]                Set up rules and install hooks for the agents found
  cephalo doctor                      Check rules, hooks, approvals and the audit log
  cephalo rules [list|show <id>|path|reset [--yes]]
                                      Inspect the rules file, or reset it to the defaults (with backup)
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

  if (cmd === "watch") {
    let last = 10;
    const li = rest.indexOf("--last");
    if (li >= 0) {
      last = Number(rest[li + 1]);
      if (!Number.isInteger(last) || last < 0) {
        process.stderr.write("cephalo: --last needs a non-negative integer\n");
        return 1;
      }
    }
    const color = rest.includes("--no-color") ? false : supportsColor();
    const ac = new AbortController();
    process.once("SIGINT", () => ac.abort());
    process.once("SIGTERM", () => ac.abort());
    await runWatch({
      blocked: rest.includes("--blocked"),
      last,
      color,
      width: process.stdout.isTTY ? process.stdout.columns : undefined,
      write: (line) => console.log(line),
      signal: ac.signal,
    });
    return 0;
  }

  if (cmd === "mcp") {
    const sub = rest[0] ?? "list";
    const flag = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    const yes = rest.includes("--yes") || rest.includes("-y");
    const confirm = async (question: string): Promise<boolean> => {
      if (yes) return true;
      if (!process.stdin.isTTY) {
        console.log("Not running in a terminal. Nothing was changed. Re-run with --yes to apply.");
        return false;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
      rl.close();
      return /^y(es)?$/i.test(answer.trim());
    };
    if (sub === "list" || sub === "ls") {
      const r = listMcp();
      for (const line of r.lines) console.log(line);
      return r.exitCode;
    }
    if (sub === "path") {
      console.log(mcpPolicyPath());
      return 0;
    }
    if (sub === "allow") {
      const positional = rest.slice(1).find((a, i, arr) => !a.startsWith("-") && !["--command", "--url", "--source"].includes(arr[i - 1] ?? ""));
      const plan = planAllow({ name: positional, source: flag("--source"), command: flag("--command"), url: flag("--url") });
      for (const line of plan.lines) console.log(line);
      if (!plan.ok) return 1;
      if (!(await confirm("Add this to the MCP allowlist? [y/N] "))) return yes ? 0 : 1;
      for (const line of applyAllow(plan)) console.log(line);
      return 0;
    }
    if (sub === "pin" || sub === "approve") {
      const name = rest.slice(1).find((a) => !a.startsWith("-"));
      const plan = await planPin(name);
      for (const line of plan.lines) console.log(line);
      if (!plan.apply) return plan.exitCode;
      if (!(await confirm("Approve these tool definitions? [y/N] "))) return yes ? 0 : 1;
      for (const line of plan.apply()) console.log(line);
      return 0;
    }
    if (sub === "scan") {
      const name = rest.slice(1).find((a) => !a.startsWith("-"));
      const r = await runScan(name);
      if (rest.includes("--json")) console.log(JSON.stringify(r.results, null, 2));
      else for (const line of r.lines) console.log(line);
      return r.exitCode;
    }
    if (sub === "mode") {
      const plan = planMode(rest[1] ?? "");
      for (const line of plan.lines) console.log(line);
      if (!plan.ok || !plan.mode) return 1;
      if (!(await confirm("Apply? [y/N] "))) return yes ? 0 : 1;
      for (const line of applyMode(plan.mode)) console.log(line);
      return 0;
    }
    process.stderr.write("Usage: cephalo mcp [list | allow <name> | allow --command \"...\" | allow --url <url> | pin <name> | scan [name] [--json] | mode audit|enforce | path]\n");
    return 1;
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

  if (cmd === "rules") {
    const sub = rest[0] ?? "list";
    if (sub === "list" || sub === "ls") {
      const r = listRules();
      for (const line of r.lines) console.log(line);
      return r.exitCode;
    }
    if (sub === "show") {
      const r = showRule(rest[1]);
      for (const line of r.lines) console.log(line);
      return r.exitCode;
    }
    if (sub === "path") {
      console.log(defaultRulesPath());
      return 0;
    }
    if (sub === "reset") {
      return resetRules({
        yes: rest.includes("--yes") || rest.includes("-y"),
        interactive: Boolean(process.stdin.isTTY),
        confirm: async () => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => rl.question("Back up and reset the rules? [y/N] ", resolve));
          rl.close();
          return /^y(es)?$/i.test(answer.trim());
        },
        log: (line) => console.log(line),
      });
    }
    process.stderr.write("Usage: cephalo rules [list | show <id> | path | reset [--yes]]\n");
    return 1;
  }

  if (cmd === "doctor") {
    const { checks, exitCode } = runDoctor();
    for (const line of formatChecks(checks)) console.log(line);
    return exitCode;
  }

  if (cmd === "init") {
    printBanner(getVersion());
    return runInit({
      yes: rest.includes("--yes") || rest.includes("-y"),
      interactive: Boolean(process.stdin.isTTY),
      confirm: async () => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => rl.question("Apply these changes? [y/N] ", resolve));
        rl.close();
        return /^y(es)?$/i.test(answer.trim());
      },
      log: (line) => console.log(line),
    });
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
