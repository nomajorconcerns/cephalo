import crypto from "node:crypto";

const AAD = Buffer.from("cephalo-vault-v1");

export interface VaultBlob {
  version: 1;
  /** Which key backend holds the master key (informational, but it is what opens the vault). */
  backend: string;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

export class VaultError extends Error {}

export function newMasterKey(): Buffer {
  return crypto.randomBytes(32);
}

export function encryptPayload(key: Buffer, payload: unknown, backend: string): VaultBlob {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final()]);
  return { version: 1, backend, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: ct.toString("base64") };
}

export function decryptPayload(key: Buffer, blob: VaultBlob): unknown {
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64"));
    d.setAAD(AAD);
    d.setAuthTag(Buffer.from(blob.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(blob.data, "base64")), d.final()]).toString("utf8"));
  } catch {
    throw new VaultError("The vault could not be decrypted: wrong key or a damaged file. Nothing was changed.");
  }
}

export function parseBlob(text: string): VaultBlob {
  let b: any;
  try {
    b = JSON.parse(text);
  } catch {
    throw new VaultError("The vault file is not valid JSON. Nothing was changed.");
  }
  if (!b || b.version !== 1 || b.alg !== "aes-256-gcm" || typeof b.iv !== "string" || typeof b.tag !== "string" || typeof b.data !== "string") {
    throw new VaultError("The vault file has an unknown format. Nothing was changed.");
  }
  return b as VaultBlob;
}
