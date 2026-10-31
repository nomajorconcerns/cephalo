import { sanitize } from "./watch.js";
import { VaultError } from "./vault/crypto.js";
import { Vault, validateName, type VaultOptions } from "./vault/store.js";

export interface VaultCmdOptions extends VaultOptions {}

const clip = (s: string, n = 90) => sanitize(s.length > n ? `${s.slice(0, n)}…` : s);

export function vaultList(o: VaultCmdOptions = {}): { lines: string[]; exitCode: number; names: string[] } {
  const v = new Vault(o);
  if (!v.exists()) return { lines: ["The vault is empty. Add a secret with: cephalo vault set NAME"], exitCode: 0, names: [] };
  try {
    const entries = v.load();
    const names = Object.keys(entries).sort();
    if (!names.length) return { lines: ["The vault is empty. Add a secret with: cephalo vault set NAME"], exitCode: 0, names };
    const lines = ["Secrets (values are never shown here):", ""];
    for (const n of names) {
      const e = entries[n];
      lines.push(`  ${n}`);
      lines.push(`      added ${e.created}${e.updated !== e.created ? `, changed ${e.updated}` : ""}`);
      lines.push(`      usable with: ${e.allow.length ? e.allow.map((p) => clip(p)).join("  |  ") : "any command (no restriction; see: cephalo vault allow)"}`);
    }
    lines.push("", "Use one with:  cephalo run --env NAME -- <command>     or put {{secret:NAME}} in an argument");
    return { lines, exitCode: 0, names };
  } catch (e) {
    return { lines: [(e as Error).message], exitCode: 1, names: [] };
  }
}

export function vaultStatus(o: VaultCmdOptions = {}): { lines: string[]; exitCode: number } {
  const v = new Vault(o);
  const lines: string[] = [];
  try {
    const b = v.backend();
    lines.push(`Vault file: ${v.file}${v.exists() ? "" : "  (not created yet)"}`, `Master key: ${b.label}`);
    if (!b.protectsAtRest) lines.push("  Warning: with this backend the key is a plain file. It stops other user accounts, not other programs running as you.");
    if (v.exists()) {
      const n = Object.keys(v.load()).length;
      lines.push(`Secrets: ${n}`);
    }
    lines.push("Agents are blocked from reading the vault files and from running vault commands; they can only use secrets through: cephalo run");
    return { lines, exitCode: 0 };
  } catch (e) {
    return { lines: [...lines, (e as Error).message], exitCode: 1 };
  }
}

/** Where a new value comes from. Never from the command line (it would sit in shell history and `ps`). */
export function readValueFromEnv(varName: string, env: NodeJS.ProcessEnv = process.env): string {
  const val = env[varName];
  if (!val) throw new VaultError(`The environment variable ${varName} is not set or is empty.`);
  return val;
}

export function vaultSet(name: string, value: string, allow: string[] | undefined, o: VaultCmdOptions = {}): string[] {
  validateName(name);
  const v = new Vault(o);
  const wasNew = !v.exists();
  const r = v.set(name, value.replace(/\r?\n$/, ""), allow);
  const out = [`${r.created ? "Stored" : "Updated"} ${name} (${value.replace(/\r?\n$/, "").length} characters).`];
  if (wasNew) out.push(`Created the vault at ${v.file} using ${v.backend().label}.`);
  if (r.backup) out.push(`Backup of the previous vault: ${r.backup}`);
  if (!(allow && allow.length) && r.created) out.push(`Tip: limit what ${name} can be used with:  cephalo vault allow ${name} "<regex of the command line>"`);
  return out;
}

export function vaultAllow(name: string, patterns: string[], o: VaultCmdOptions = {}): string[] {
  const r = new Vault(o).setAllow(name, patterns);
  return [patterns.length ? `${name} can now only be used with commands matching: ${patterns.join("  |  ")}` : `${name} can now be used with any command.`, ...(r.backup ? [`Backup: ${r.backup}`] : [])];
}

export function planRemove(name: string, o: VaultCmdOptions = {}): { ok: boolean; lines: string[] } {
  const v = new Vault(o);
  if (!v.exists()) return { ok: false, lines: ["The vault is empty."] };
  try {
    return v.load()[name] ? { ok: true, lines: [`Remove ${name} from the vault. A backup of the vault is kept.`] } : { ok: false, lines: [`There is no secret named ${name}.`] };
  } catch (e) {
    return { ok: false, lines: [(e as Error).message] };
  }
}

export function applyRemove(name: string, o: VaultCmdOptions = {}): string[] {
  const r = new Vault(o).remove(name);
  return [r.removed ? `Removed ${name}.` : `There is no secret named ${name}.`, ...(r.backup ? [`Backup: ${r.backup}`] : [])];
}

export function vaultReveal(name: string, o: VaultCmdOptions = {}): string {
  const e = new Vault(o).load()[name];
  if (!e) throw new VaultError(`There is no secret named ${name}.`);
  return e.value;
}

/** Summary for `doctor`. */
export function vaultSummary(o: VaultCmdOptions = {}): { exists: boolean; count: number; backend?: string; protectsAtRest?: boolean; unrestricted: number; error?: string } {
  const v = new Vault(o);
  if (!v.exists()) return { exists: false, count: 0, unrestricted: 0 };
  try {
    const b = v.backend();
    const entries = Object.values(v.load());
    return { exists: true, count: entries.length, backend: b.label, protectsAtRest: b.protectsAtRest, unrestricted: entries.filter((e) => e.allow.length === 0).length };
  } catch (e) {
    return { exists: true, count: 0, unrestricted: 0, error: (e as Error).message };
  }
}
