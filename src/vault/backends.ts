import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { VaultError, newMasterKey } from "./crypto.js";

export type BackendId = "dpapi" | "keychain" | "secret-service" | "file";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
/** Runs an OS tool. Injectable so the macOS/Linux command lines can be tested without those systems. */
export type Runner = (cmd: string, args: string[], input?: string) => RunResult;

export const defaultRunner: Runner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", windowsHide: true, timeout: 20000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * Holds the 32-byte master key that encrypts vault.json. Where the key lives is the whole security story:
 *  - dpapi (Windows): the key is wrapped with the Windows Data Protection API for the current user.
 *  - keychain (macOS) / secret-service (Linux): the key sits in the login keychain / desktop secret store.
 *  - file: the key is a 0600 file next to the vault. It stops other accounts, NOT other programs running as you.
 * In every case, code running as your user can ask the OS for the key. What keeps an AI agent away from it is Cephalo's
 * hook rules, which is why the agent is blocked from reading the vault files and from calling the OS key APIs.
 */
export interface KeyBackend {
  id: BackendId;
  label: string;
  /** False when the key is stored in a plain file. */
  protectsAtRest: boolean;
  getKey(create: boolean): Buffer | null;
}

export interface BackendEnv {
  dir: string;
  run?: Runner;
  user?: string;
}

const KEY_NAME = "vault.key";

function writeKeyFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
}

function dpapiBackend(env: BackendEnv): KeyBackend {
  const run = env.run ?? defaultRunner;
  const keyFile = path.join(env.dir, KEY_NAME);
  const ps = (script: string, input: string) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], input);
  const HEAD = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $e=[Text.Encoding]::UTF8.GetBytes('cephalo-vault-v1'); $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());";
  const PROTECT = `${HEAD} [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser'))`;
  const UNPROTECT = `${HEAD} [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser'))`;
  return {
    id: "dpapi",
    label: "Windows DPAPI (current user)",
    protectsAtRest: true,
    getKey(create) {
      if (fs.existsSync(keyFile)) {
        const r = ps(UNPROTECT, fs.readFileSync(keyFile, "utf8"));
        if (r.status !== 0 || !r.stdout.trim()) throw new VaultError(`Windows could not unprotect ${keyFile} (a different Windows user, or a damaged file). Nothing was changed.`);
        return Buffer.from(r.stdout.trim(), "base64");
      }
      if (!create) return null;
      const key = newMasterKey();
      const r = ps(PROTECT, key.toString("base64"));
      if (r.status !== 0 || !r.stdout.trim()) throw new VaultError(`Windows DPAPI could not protect the vault key: ${r.stderr.trim().slice(0, 200) || "unknown error"}`);
      writeKeyFile(keyFile, r.stdout.trim());
      return key;
    },
  };
}

function keychainBackend(env: BackendEnv): KeyBackend {
  const run = env.run ?? defaultRunner;
  const user = env.user ?? os.userInfo().username;
  return {
    id: "keychain",
    label: "macOS Keychain",
    protectsAtRest: true,
    getKey(create) {
      const r = run("security", ["find-generic-password", "-s", "cephalo-vault", "-a", user, "-w"]);
      if (r.status === 0 && r.stdout.trim()) return Buffer.from(r.stdout.trim(), "hex");
      if (r.status !== 0 && r.status !== 44) throw new VaultError(`The macOS keychain could not be read: ${r.stderr.trim().slice(0, 200) || "`security` is unavailable"}`);
      if (!create) return null;
      const key = newMasterKey();
      // `security` takes the secret as an argument, so the key is visible to the same user's `ps` for a moment, once, at creation.
      const a = run("security", ["add-generic-password", "-U", "-s", "cephalo-vault", "-a", user, "-w", key.toString("hex")]);
      if (a.status !== 0) throw new VaultError(`The macOS keychain refused the vault key: ${a.stderr.trim().slice(0, 200)}`);
      return key;
    },
  };
}

function secretServiceBackend(env: BackendEnv): KeyBackend {
  const run = env.run ?? defaultRunner;
  const user = env.user ?? os.userInfo().username;
  return {
    id: "secret-service",
    label: "Linux Secret Service (libsecret)",
    protectsAtRest: true,
    getKey(create) {
      const r = run("secret-tool", ["lookup", "service", "cephalo-vault", "account", user]);
      if (r.status === 0 && r.stdout.trim()) return Buffer.from(r.stdout.trim(), "hex");
      if (!create) return null;
      const key = newMasterKey();
      const s = run("secret-tool", ["store", "--label=Cephalo vault key", "service", "cephalo-vault", "account", user], key.toString("hex"));
      if (s.status !== 0) throw new VaultError(`secret-tool could not store the vault key (is a keyring unlocked?): ${s.stderr.trim().slice(0, 200)}`);
      return key;
    },
  };
}

function fileBackend(env: BackendEnv): KeyBackend {
  const keyFile = path.join(env.dir, KEY_NAME);
  return {
    id: "file",
    label: "key file (0600), NOT protected by the OS",
    protectsAtRest: false,
    getKey(create) {
      if (fs.existsSync(keyFile)) {
        const k = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
        if (k.length !== 32) throw new VaultError(`${keyFile} is damaged. Nothing was changed.`);
        return k;
      }
      if (!create) return null;
      const key = newMasterKey();
      writeKeyFile(keyFile, key.toString("hex"));
      return key;
    },
  };
}

export function backendById(id: string, env: BackendEnv): KeyBackend {
  switch (id) {
    case "dpapi":
      return dpapiBackend(env);
    case "keychain":
      return keychainBackend(env);
    case "secret-service":
      return secretServiceBackend(env);
    case "file":
      return fileBackend(env);
    default:
      throw new VaultError(`Unknown vault key backend "${id}".`);
  }
}

/** The best backend for this OS. On Linux without secret-tool it falls back to the key file (and says so). */
export function chooseBackend(platformId: string, env: BackendEnv): KeyBackend {
  if (platformId === "win32") return dpapiBackend(env);
  if (platformId === "darwin") return keychainBackend(env);
  const r = (env.run ?? defaultRunner)("secret-tool", ["--version"]);
  if (r.status !== null) return secretServiceBackend(env);
  return fileBackend(env);
}
