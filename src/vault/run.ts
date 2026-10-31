import type { Writable } from "node:stream";
import { appendAudit, type AuditEntry } from "../audit.js";
import { spawnProcess } from "../mcp/client.js";
import { currentUser } from "../user.js";
import { Scrubber } from "./scrub.js";
import { Vault, validateName, type Entries } from "./store.js";

export const PLACEHOLDER_RE = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface EnvMapping {
  /** Environment variable the child sees. */
  envVar: string;
  /** Secret in the vault. */
  secret: string;
}

/** `--env NAME` (variable and secret share a name) or `--env VAR=NAME`. */
export function parseEnvSpec(spec: string): EnvMapping {
  const i = spec.indexOf("=");
  const envVar = i < 0 ? spec : spec.slice(0, i);
  const secret = i < 0 ? spec : spec.slice(i + 1);
  validateName(envVar);
  validateName(secret);
  return { envVar, secret };
}

export interface RunOptions {
  vault: Vault;
  env: EnvMapping[];
  command: string;
  args: string[];
  stdout?: Writable;
  stderr?: Writable;
  stdin?: "inherit" | "ignore";
  cwd?: string;
  auditFile?: string;
  /** Test hook: environment the child starts from (default: this process's). */
  baseEnv?: NodeJS.ProcessEnv;
}

export interface RunResult {
  exitCode: number;
  used: string[];
  /** Set when nothing was started. */
  refused?: { rule: string; message: string };
}

export async function runWithSecrets(o: RunOptions): Promise<RunResult> {
  const out = o.stdout ?? process.stdout;
  const err = o.stderr ?? process.stderr;
  const original = [o.command, ...o.args].join(" ");
  const log = (e: Partial<AuditEntry> & { decision: "allow" | "block" }) => {
    try {
      appendAudit({ ts: new Date().toISOString(), agent: "cli", tool: "vault-run", user: currentUser(), command: original, ...e }, o.auditFile);
    } catch (x) {
      err.write(`cephalo: audit log failed: ${(x as Error).message}\n`);
    }
  };
  const refuse = (rule: string, message: string, used: string[] = []): RunResult => {
    err.write(`cephalo: ${message}\n`);
    log({ decision: "block", rule, note: message });
    return { exitCode: rule === "vault-missing" ? 127 : 126, used, refused: { rule, message } };
  };

  const wanted = new Set<string>(o.env.map((m) => m.secret));
  for (const a of [o.command, ...o.args]) for (const m of a.matchAll(PLACEHOLDER_RE)) wanted.add(m[1]);
  if (wanted.size === 0) return refuse("vault-usage", "Nothing to inject. Name a secret with --env NAME, or use {{secret:NAME}} in an argument.");

  let entries: Entries;
  try {
    entries = o.vault.load();
  } catch (x) {
    return refuse("vault-unreadable", (x as Error).message);
  }
  const missing = [...wanted].filter((n) => !entries[n]);
  if (missing.length) return refuse("vault-missing", `No secret named ${missing.join(", ")} in the vault. Available: ${Object.keys(entries).sort().join(", ") || "(none)"}. Add one with: cephalo vault set NAME`, [...wanted]);

  for (const n of wanted) {
    const allow = entries[n].allow;
    if (allow.length && !allow.some((p) => new RegExp(p, "i").test(original))) {
      return refuse("vault-not-allowed", `${n} is restricted to commands matching: ${allow.join("  |  ")}. This command does not match, so nothing was run. The owner can change this with: cephalo vault allow ${n}`, [...wanted]);
    }
  }

  const values: Record<string, string> = {};
  for (const n of wanted) values[n] = entries[n].value;
  const env: NodeJS.ProcessEnv = { ...(o.baseEnv ?? process.env) };
  for (const m of o.env) env[m.envVar] = values[m.secret];
  const sub = (s: string) => s.replace(PLACEHOLDER_RE, (_, name: string) => values[name]);
  const command = sub(o.command);
  const args = o.args.map(sub);

  const so = new Scrubber(values);
  const se = new Scrubber(values);
  const child = spawnProcess(command, args, env, o.stdin ?? "inherit", o.cwd);
  child.stdout?.on("data", (c) => {
    const t = so.push(c);
    if (t) out.write(t);
  });
  child.stderr?.on("data", (c) => {
    const t = se.push(c);
    if (t) err.write(t);
  });
  const code = await new Promise<number>((resolve) => {
    child.on("error", (e) => {
      const s = new Scrubber(values);
      err.write(`cephalo: could not start the command: ${s.push(e.message)}${s.flush()}\n`);
      resolve(127);
    });
    child.on("close", (c) => resolve(c ?? 1));
  });
  const a = so.flush();
  if (a) out.write(a);
  const b = se.flush();
  if (b) err.write(b);
  log({ decision: "allow", note: `injected ${[...wanted].join(", ")}; exit ${code}` });
  return { exitCode: code, used: [...wanted] };
}
