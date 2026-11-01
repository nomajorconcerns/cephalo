#!/usr/bin/env node
import { appendAudit, formatAudit, readAudit } from "./audit.js";
import { evaluate } from "./engine.js";
import { runHookJudged } from "./judge/hook.js";
import {
  installClaude,
  installHermes,
  uninstallClaude,
  uninstallHermes,
} from "./install.js";
import fs from "node:fs";
import { createInterface } from "node:readline";
import { printBanner, supportsColor } from "./banner.js";
import { runWatch } from "./watch.js";
import { applyAllow, applyMode, listMcp, planAllow, planMode, planPin, planWrap, runScan } from "./mcpcmd.js";
import { runProxy } from "./mcp/proxy.js";
import { INCIDENT_USAGE, parseIncidentArgs, planIncident } from "./incidentcmd.js";
import { applyRule, undoRule } from "./incident/rule.js";
import { collectReplay, parseReplayArgs, planComment, postComment, render, writeOutput } from "./replaycmd.js";
import { Vault } from "./vault/store.js";
import { parseEnvSpec, runWithSecrets, type EnvMapping } from "./vault/run.js";
import type { BackendId } from "./vault/backends.js";
import { applyRemove, planRemove, readValueFromEnv, vaultAllow, vaultList, vaultReveal, vaultSet, vaultStatus } from "./vaultcmd.js";
import { applyClear, applyTripMode, planClear, planTripMode, scanReport, tripStatus } from "./tripwirecmd.js";
import { tripPolicyPath } from "./tripwire/state.js";
import { projectRoot } from "./install.js";
import { mcpPolicyPath } from "./mcp/policy.js";
import { formatChecks, runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { listRules, resetRules, showRule } from "./rulescmd.js";
import { defaultRulesPath } from "./rules.js";
import { getVersion } from "./version.js";
import { applyModelsEnabled, applyModelsMode, judgeReport, modelsEval, modelsPullPlan, modelsScan, modelsStatus, planModelsEnabled, planModelsMode } from "./modelscmd.js";
import { modelsConfigPath } from "./models/config.js";

const USAGE = `Usage:
  cephalo test "<command>"            Check a shell command against the rules
  cephalo hook claude|hermes          Hook entry point (reads JSON on stdin)
  cephalo log [--blocked] [--limit N] Show recent audit entries
  cephalo watch [--blocked] [--last N] [--no-color]
                                      Follow the audit log live (Ctrl+C to stop)
  cephalo mcp [list|allow|pin|scan|wrap|mode|path]
                                      MCP firewall: allowlist by command/URL, fingerprint tools, audit or enforce
  cephalo replay [--pr N] [--format text|md|html|json] [--comment]
                                      Replay of what the agents did on this branch, for a pull request
  cephalo incident [<n> | --last] [--use K]
                                      Turn something an agent did into a blocking rule, tested against your history
  cephalo vault [status|list|set|allow|remove|reveal|path]
                                      Secrets vault: tokens the agent can use but never see
  cephalo run --env NAME -- <command> Run a command with vault secrets injected; output is scrubbed
  cephalo tripwire [status|scan|clear|mode|path]
                                      Prompt-injection tripwire: scan what the agent reads, lock down risky actions
  cephalo models [status|pull|enable|disable|mode|judge|scan|eval|path]
                                      Local-model judge (Ollama on this machine): roles, installed models
  cephalo mcp proxy -- <command...>   Run an MCP server behind Cephalo's runtime proxy (used in agent configs)
  cephalo install claude|hermes       Add Cephalo's hook to the agent's config
  cephalo uninstall claude|hermes     Remove Cephalo's hook from the agent's config
  cephalo init [--yes]                Set up rules and install hooks for the agents found
  cephalo doctor                      Check rules, hooks, approvals and the audit log
  cephalo rules [list|show <id>|path|reset [--yes]]
                                      Inspect the rules file, or reset it to the defaults (with backup)
`;

const REPLAY_USAGE = `Usage: cephalo replay [options]

Builds a replay of what the agents did, from the local audit log, scoped to the current git project.

  --since <t>        start (30m, 2h, 1d, today, or a date). Default: a little before this branch's first commit
  --until <t>        end (default: now)
  --session <id>     only one agent session (a prefix is enough)
  --all-projects     do not filter by project directory
  --strict           leave out entries that have no recorded project
  --format text|md|html|json
                     text: summary for the terminal (default). md: PR comment text.
                     html: one interactive file (default name cephalo-replay.html). json: raw data
  --out <file>       write to a file (an existing file needs --force; it is kept as a backup copy)
  --pr <number>      the pull request this belongs to
  --comment          post the markdown replay to the PR with the GitHub CLI (asks first; --yes skips the question)
  --update           with --comment: edit your earlier Cephalo replay comment instead of adding another
  --repo <owner/name>  repository for gh
  --max-chars <n>    size limit for the markdown (default 60000; GitHub's limit is 65536)
`;

/** Read a line from the terminal without echoing it (Enter ends, Ctrl+C cancels). */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let buf = "";
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          done();
          resolve(buf);
          return;
        }
        if (c === "\u0003") {
          done();
          reject(new Error("Cancelled. Nothing was stored."));
          return;
        }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

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
    if (agent !== "claude" && agent !== "hermes" && agent !== "codex" && agent !== "cursor") {
      process.stderr.write(USAGE);
      return 1; // non-blocking error for the agent
    }
    let raw = "";
    try {
      raw = await readStdin();
    } catch (e) {
      process.stderr.write(`cephalo: could not read stdin (allowing call): ${(e as Error).message}\n`);
    }
    const out = await runHookJudged(agent, raw);
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

  if (cmd === "replay") {
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(REPLAY_USAGE);
      return 0;
    }
    const parsed = parseReplayArgs(rest);
    if ("error" in parsed) {
      process.stderr.write(`cephalo: ${parsed.error}\n`);
      return 1;
    }
    const a = parsed.args;
    const env = { cwd: process.cwd() };
    let replay;
    try {
      replay = collectReplay(a, env);
    } catch (e) {
      process.stderr.write(`cephalo: ${(e as Error).message}\n`);
      return 1;
    }
    if (a.comment) {
      const plan = planComment(replay, a, env);
      for (const line of plan.lines) console.log(line);
      if (!plan.ok) return 1;
      let ok = a.yes;
      if (!ok) {
        if (!process.stdin.isTTY) {
          console.log("Not running in a terminal. Nothing was posted. Re-run with --yes to post.");
          return 1;
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => rl.question("Post it? [y/N] ", resolve));
        rl.close();
        ok = /^y(es)?$/i.test(answer.trim());
      }
      if (!ok) return 1;
      const res = postComment(plan, a, env);
      for (const line of res.lines) console.log(line);
      return res.ok ? 0 : 1;
    }
    const outFile = a.out ?? (a.format === "html" ? "cephalo-replay.html" : undefined);
    const text = render(replay, a);
    if (outFile) {
      try {
        for (const line of writeOutput(text, outFile, a.force)) console.log(line);
      } catch (e) {
        process.stderr.write(`cephalo: ${(e as Error).message}\n`);
        return 1;
      }
    } else {
      console.log(text);
    }
    return 0;
  }

  if (cmd === "incident") {
    if (rest.includes("--help") || rest.includes("-h")) {
      console.log(INCIDENT_USAGE);
      return 0;
    }
    const parsed = parseIncidentArgs(rest);
    if ("error" in parsed) {
      process.stderr.write(`cephalo: ${parsed.error}\n`);
      return 1;
    }
    const a = parsed.args;
    if (a.sub === "undo") {
      const res = undoRule(a.id!);
      for (const line of res.lines) console.log(line);
      return res.ok ? 0 : 1;
    }
    const plan = planIncident(a);
    for (const line of plan.lines) console.log(line);
    if (!plan.apply) return plan.exitCode;
    let ok = a.yes;
    if (!ok) {
      if (!process.stdin.isTTY) {
        console.log("Not running in a terminal. Nothing was changed. Re-run with --yes to add the rule.");
        return 1;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => rl.question("Add this rule? [y/N] ", resolve));
      rl.close();
      ok = /^y(es)?$/i.test(answer.trim());
    }
    if (!ok) {
      console.log("Nothing was changed.");
      return 1;
    }
    const res = applyRule(plan.apply.rule, plan.apply.entry);
    for (const line of res.lines) console.log(line);
    return res.ok ? 0 : 1;
  }

  if (cmd === "run") {
    // cephalo run [--env NAME | --env VAR=NAME]... [--] <command> [args...]
    const tail = rest;
    const env: EnvMapping[] = [];
    let i = 0;
    try {
      while (i < tail.length && tail[i] === "--env") {
        if (!tail[i + 1]) throw new Error("--env needs a secret name");
        env.push(parseEnvSpec(tail[i + 1]));
        i += 2;
      }
    } catch (e) {
      process.stderr.write(`cephalo: ${(e as Error).message}\n`);
      return 1;
    }
    if (tail[i] === "--") i += 1;
    const command = tail[i];
    if (!command) {
      process.stderr.write("Usage: cephalo run [--env NAME | --env VAR=NAME]... -- <command> [args...]\n       (or put {{secret:NAME}} in an argument)\n");
      return 1;
    }
    const r = await runWithSecrets({ vault: new Vault(), env, command, args: tail.slice(i + 1) });
    return r.exitCode;
  }

  if (cmd === "vault") {
    const sub = rest[0] ?? "status";
    const yes = rest.includes("--yes") || rest.includes("-y");
    const flagAll = (name: string) => rest.flatMap((a, k) => (a === name && rest[k + 1] !== undefined ? [rest[k + 1]] : []));
    const positional = rest.slice(1).filter((a, k, arr) => !a.startsWith("-") && !["--from-env", "--allow", "--backend"].includes(arr[k - 1] ?? ""));
    const fail = (e: unknown) => {
      process.stderr.write(`cephalo: ${(e as Error).message}\n`);
      return 1;
    };
    try {
      if (sub === "status") {
        const r = vaultStatus();
        for (const line of r.lines) console.log(line);
        return r.exitCode;
      }
      if (sub === "list" || sub === "ls") {
        const r = vaultList();
        for (const line of r.lines) console.log(line);
        return r.exitCode;
      }
      if (sub === "path") {
        console.log(new Vault().file);
        return 0;
      }
      if (sub === "set") {
        const name = positional[0];
        if (!name) {
          process.stderr.write("Usage: cephalo vault set NAME [--stdin | --from-env VAR] [--allow REGEX]... [--backend file]\n");
          return 1;
        }
        const fromEnv = flagAll("--from-env")[0];
        let value: string;
        if (fromEnv) value = readValueFromEnv(fromEnv);
        else if (rest.includes("--stdin")) value = await readStdin();
        else if (process.stdin.isTTY) value = await readHidden(`Value for ${name} (typing is hidden): `);
        else {
          process.stderr.write("Not a terminal. Pipe the value with --stdin, or use --from-env VAR. A value is never taken from an argument.\n");
          return 1;
        }
        const backend = flagAll("--backend")[0] as BackendId | undefined;
        const allow = flagAll("--allow");
        for (const line of vaultSet(name, value, allow.length ? allow : undefined, backend ? { backend } : {})) console.log(line);
        return 0;
      }
      if (sub === "allow") {
        const [name, ...patterns] = positional;
        if (!name) {
          process.stderr.write("Usage: cephalo vault allow NAME REGEX...   (no REGEX or --clear = any command)\n");
          return 1;
        }
        for (const line of vaultAllow(name, rest.includes("--clear") ? [] : patterns)) console.log(line);
        return 0;
      }
      if (sub === "remove" || sub === "rm") {
        const name = positional[0];
        if (!name) {
          process.stderr.write("Usage: cephalo vault remove NAME [--yes]\n");
          return 1;
        }
        const plan = planRemove(name);
        for (const line of plan.lines) console.log(line);
        if (!plan.ok) return 1;
        let ok = yes;
        if (!ok) {
          if (!process.stdin.isTTY) {
            console.log("Not running in a terminal. Nothing was changed. Re-run with --yes to apply.");
            return 1;
          }
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => rl.question("Remove it? [y/N] ", resolve));
          rl.close();
          ok = /^y(es)?$/i.test(answer.trim());
        }
        if (!ok) return 1;
        for (const line of applyRemove(name)) console.log(line);
        return 0;
      }
      if (sub === "reveal") {
        const name = positional[0];
        if (!name) {
          process.stderr.write("Usage: cephalo vault reveal NAME\n");
          return 1;
        }
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          process.stderr.write("reveal only works in an interactive terminal, so a value can never be captured by a script or an agent.\n");
          return 1;
        }
        console.log(vaultReveal(name));
        return 0;
      }
    } catch (e) {
      return fail(e);
    }
    process.stderr.write("Usage: cephalo vault [status | list | set NAME | allow NAME REGEX... | remove NAME | reveal NAME | path]\n");
    return 1;
  }

  if (cmd === "tripwire") {
    const sub = rest[0] ?? "status";
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
    if (sub === "status") {
      const r = tripStatus();
      for (const line of r.lines) console.log(line);
      return r.exitCode;
    }
    if (sub === "path") {
      console.log(tripPolicyPath());
      return 0;
    }
    if (sub === "scan") {
      const target = rest.slice(1).find((a) => a === "-" || !a.startsWith("-"));
      if (!target) {
        process.stderr.write("Usage: cephalo tripwire scan <file | ->   (- reads stdin)\n");
        return 1;
      }
      let text = "";
      try {
        text = target === "-" ? await readStdin() : fs.readFileSync(target, "utf8");
      } catch (e) {
        process.stderr.write(`cephalo: could not read ${target}: ${(e as Error).message}\n`);
        return 1;
      }
      const r = scanReport(text, target === "-" ? "stdin" : target);
      for (const line of r.lines) console.log(line);
      return r.exitCode;
    }
    if (sub === "clear") {
      const plan = planClear();
      for (const line of plan.lines) console.log(line);
      if (plan.count === 0) return 0;
      if (!(await confirm("Release these sessions? [y/N] "))) return yes ? 0 : 1;
      for (const line of applyClear()) console.log(line);
      return 0;
    }
    if (sub === "mode") {
      const plan = planTripMode(rest[1] ?? "");
      for (const line of plan.lines) console.log(line);
      if (!plan.ok) return 1;
      if (!(await confirm("Apply? [y/N] "))) return yes ? 0 : 1;
      for (const line of applyTripMode(plan.mode!)) console.log(line);
      return 0;
    }
    process.stderr.write("Usage: cephalo tripwire [status | scan <file|-> | clear | mode enforce|warn|off | path]\n");
    return 1;
  }

  if (cmd === "models") {
    const sub = rest[0] ?? "status";
    const yes = rest.includes("--yes") || rest.includes("-y");
    if (sub === "status") {
      const r = await modelsStatus();
      for (const line of r.lines) console.log(line);
      return r.exitCode;
    }
    if (sub === "path") {
      console.log(modelsConfigPath());
      return 0;
    }
    if (sub === "pull") {
      const r = await modelsPullPlan();
      for (const line of r.lines) console.log(line);
      return r.exitCode;
    }
    if (sub === "scan") {
      const target = rest.slice(1).find((a) => a === "-" || !a.startsWith("-"));
      if (!target) {
        process.stderr.write("Usage: cephalo models scan <file | ->   (- reads stdin)\n");
        return 1;
      }
      let text = "";
      try {
        text = target === "-" ? await readStdin() : fs.readFileSync(target, "utf8");
      } catch (e) {
        process.stderr.write(`cephalo: could not read ${target}: ${(e as Error).message}\n`);
        return 1;
      }
      const r = await modelsScan(text, target === "-" ? "stdin" : target);
      for (const line of r.lines) console.log(line);
      return r.exitCode;
    }
    if (sub === "eval") {
      const flag = (name: string) => {
        const i = rest.indexOf(name);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const only = flag("--only");
      if (only !== undefined && only !== "commands" && only !== "diffs") {
        process.stderr.write("Usage: cephalo models eval [cases.jsonl] [--only commands|diffs] [--model <tag>] [--limit N] [--json <file>]\n");
        return 1;
      }
      const valued = new Set(["--only", "--model", "--limit", "--json"]);
      const file = rest.slice(1).find((a, i, arr) => !a.startsWith("-") && !valued.has(arr[i - 1] ?? ""));
      const r = await modelsEval({ casesFile: file, only: only as "commands" | "diffs" | undefined, model: flag("--model"), limit: flag("--limit") ? Number(flag("--limit")) : undefined, jsonOut: flag("--json"), onProgress: (l) => process.stderr.write(l + "\n") });
      for (const line of r.lines) console.log(line);
      return r.exitCode;
    }
    if (sub === "judge") {
      const command = rest.slice(1).filter((a) => a !== "--yes" && a !== "-y").join(" ");
      if (!command) {
        process.stderr.write('Usage: cephalo models judge "<command>"\n');
        return 1;
      }
      const r = await judgeReport(command);
      for (const line of r.lines) console.log(line);
      return r.exitCode;
    }
    if (sub === "enable" || sub === "disable" || sub === "mode") {
      const modePlan = sub === "mode" ? planModelsMode(rest[1] ?? "") : undefined;
      const plan = modePlan ?? planModelsEnabled(sub as "enable" | "disable");
      for (const line of plan.lines) console.log(line);
      if (modePlan && !modePlan.ok) return modePlan.lines[0].startsWith("Usage") ? 1 : 0;
      if (!modePlan && !(plan as { changed: boolean }).changed) return 0;
      let ok = yes;
      if (!ok) {
        if (!process.stdin.isTTY) {
          console.log("Not running in a terminal. Nothing was changed. Re-run with --yes to apply.");
          return 1;
        }
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => rl.question("Apply? [y/N] ", resolve));
        rl.close();
        ok = /^y(es)?$/i.test(answer.trim());
      }
      if (!ok) return 1;
      for (const line of modePlan ? applyModelsMode(modePlan.mode!) : applyModelsEnabled(sub as "enable" | "disable")) console.log(line);
      return 0;
    }
    process.stderr.write("Usage: cephalo models [status | pull | enable | disable | mode warn|enforce | judge \"<command>\" | scan <file|-> | eval | path]\n");
    return 1;
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
    if (sub === "proxy") {
      // Everything after `proxy` is: [--name <label>] [--] <command> [args...]. stdout belongs to the MCP protocol: print nothing else.
      const tail = rest.slice(1);
      let label: string | undefined;
      let i = 0;
      while (i < tail.length && tail[i] === "--name") {
        label = tail[i + 1];
        i += 2;
      }
      if (tail[i] === "--") i += 1;
      const cmdline = tail.slice(i);
      if (cmdline.length === 0) {
        process.stderr.write("Usage: cephalo mcp proxy [--name <label>] -- <command> [args...]\n");
        return 1;
      }
      return runProxy({ command: cmdline[0], args: cmdline.slice(1), label, input: process.stdin, output: process.stdout });
    }
    if (sub === "wrap") {
      const r = planWrap(rest.slice(1).find((a) => !a.startsWith("-")), `${projectRoot()}/dist/cli.js`);
      for (const line of r.lines) console.log(line);
      return r.exitCode;
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
