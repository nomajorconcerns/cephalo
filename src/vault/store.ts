import fs from "node:fs";
import path from "node:path";
import { cephaloDir } from "../rules.js";
import { backendById, chooseBackend, type BackendId, type KeyBackend, type Runner } from "./backends.js";
import { VaultError, decryptPayload, encryptPayload, parseBlob } from "./crypto.js";

export interface SecretEntry {
  value: string;
  created: string;
  updated: string;
  /** Regexes (case-insensitive) the command line must match for this secret to be injected. Empty = any command. */
  allow: string[];
}
export type Entries = Record<string, SecretEntry>;

export interface VaultOptions {
  dir?: string;
  /** Force a backend for a NEW vault (an existing vault always uses the one recorded in it). */
  backend?: BackendId;
  platformId?: string;
  run?: Runner;
  user?: string;
}

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const MIN_VALUE_LENGTH = 8;
const MAX_VALUE_LENGTH = 16 * 1024;

export function validateName(name: string): void {
  if (!NAME_RE.test(name)) throw new VaultError(`"${name}" is not a valid secret name. Use letters, digits and underscores, starting with a letter or underscore (for example GITHUB_TOKEN).`);
}

export function validateValue(value: string): void {
  if (value.length < MIN_VALUE_LENGTH) throw new VaultError(`That value is only ${value.length} characters. Cephalo needs at least ${MIN_VALUE_LENGTH}: shorter values cannot be reliably removed from output.`);
  if (value.length > MAX_VALUE_LENGTH) throw new VaultError(`That value is longer than ${MAX_VALUE_LENGTH} characters.`);
  if (value.includes("\0")) throw new VaultError("A secret cannot contain a NUL character.");
}

export function validateAllow(patterns: string[]): void {
  for (const p of patterns) {
    if (!p || p.length > 300) throw new VaultError("An allow pattern must be 1 to 300 characters.");
    try {
      new RegExp(p, "i");
    } catch (e) {
      throw new VaultError(`"${p}" is not a valid regular expression: ${(e as Error).message}`);
    }
  }
}

export function vaultFilePath(dir: string = cephaloDir()): string {
  return path.join(dir, "vault.json");
}

export class Vault {
  readonly dir: string;
  readonly file: string;
  constructor(private readonly o: VaultOptions = {}) {
    this.dir = o.dir ?? cephaloDir();
    this.file = vaultFilePath(this.dir);
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  /** The backend that opens this vault: the one recorded in it, or the best one for this OS (or the forced one) if it is new. */
  backend(): KeyBackend {
    const env = { dir: this.dir, run: this.o.run, user: this.o.user };
    if (this.exists()) return backendById(parseBlob(fs.readFileSync(this.file, "utf8")).backend, env);
    return this.o.backend ? backendById(this.o.backend, env) : chooseBackend(this.o.platformId ?? process.platform, env);
  }

  /** Decrypt everything. An empty vault is `{}`. Throws VaultError (and changes nothing) if it cannot be opened. */
  load(): Entries {
    if (!this.exists()) return {};
    const blob = parseBlob(fs.readFileSync(this.file, "utf8"));
    const key = this.backend().getKey(false);
    if (!key) throw new VaultError("The vault exists but its master key is missing. Restore it, or move the vault aside to start a new one. Nothing was changed.");
    const payload = decryptPayload(key, blob) as { secrets?: Entries };
    return payload.secrets ?? {};
  }

  private save(entries: Entries): { backup?: string } {
    const backend = this.backend();
    const key = backend.getKey(true)!;
    fs.mkdirSync(this.dir, { recursive: true });
    let backup: string | undefined;
    if (this.exists()) {
      backup = `${this.file}.cephalo-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      fs.copyFileSync(this.file, backup);
    }
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(encryptPayload(key, { secrets: entries }, backend.id), null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return { backup };
  }

  set(name: string, value: string, allow?: string[]): { created: boolean; backup?: string } {
    validateName(name);
    validateValue(value);
    if (allow) validateAllow(allow);
    const entries = this.load(); // throws before anything is touched if the existing vault cannot be opened
    const now = new Date().toISOString();
    const prev = entries[name];
    entries[name] = { value, created: prev?.created ?? now, updated: now, allow: allow ?? prev?.allow ?? [] };
    return { created: !prev, ...this.save(entries) };
  }

  setAllow(name: string, allow: string[]): { backup?: string } {
    validateAllow(allow);
    const entries = this.load();
    if (!entries[name]) throw new VaultError(`There is no secret named ${name}.`);
    entries[name] = { ...entries[name], allow, updated: new Date().toISOString() };
    return this.save(entries);
  }

  remove(name: string): { removed: boolean; backup?: string } {
    const entries = this.load();
    if (!entries[name]) return { removed: false };
    delete entries[name];
    return { removed: true, ...this.save(entries) };
  }
}
