import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Signed policy bundles. An admin signs the published policy with an Ed25519 key; each developer lists the public
 * keys they trust. With a trust file present, `cephalo sync pull` refuses a policy that is unsigned, signed by an
 * unknown key, or changed after signing. Everything is local files and Node's own crypto: no server, no network.
 *
 * The trusted keys must come from somewhere other than the shared folder (the admin hands them over directly), or
 * anyone who can write to the folder could swap the policy and the key together.
 */

export const SIGNING_KEY_FILE = "policy-signing.key";
export const TRUST_FILE = "policy-trusted.pub";

export interface SignedFields {
  sha256: string;
  at: string;
  rules: number;
  by?: string;
}

/** The exact bytes that are signed. A version tag keeps a signature from being replayed for another purpose. */
export function signedMessage(m: SignedFields): Buffer {
  return Buffer.from(`cephalo-policy-v1\n${m.sha256}\n${m.at}\n${m.rules}\n${m.by ?? ""}\n`, "utf8");
}

/** Short stable id for a public key, for humans to compare ("is this the admin's key?"). */
export function keyId(publicPem: string): string {
  const der = crypto.createPublicKey(publicPem).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** Create a new key pair. Refuses to overwrite an existing private key. The private key file is owner-only where the OS supports it. */
export function generateKeypair(keyFile: string): { ok: boolean; lines: string[]; publicPem?: string } {
  if (fs.existsSync(keyFile)) return { ok: false, lines: [`${keyFile} already exists. Move it aside first if you really want a new key (signatures made with the old one stop verifying).`] };
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, privPem, { encoding: "utf8", mode: 0o600 });
  const pubFile = keyFile.replace(/\.key$/, "") + ".pub";
  fs.writeFileSync(pubFile, pubPem, "utf8");
  return {
    ok: true,
    publicPem: pubPem,
    lines: [`Private key: ${keyFile} (keep it secret; never put it in the shared folder)`, `Public key:  ${pubFile}  id ${keyId(pubPem)}`, "Give the public key file to each developer, who runs: cephalo sync trust <file>"],
  };
}

export function signManifest(keyFile: string, m: SignedFields): { signature: string; keyId: string } {
  const priv = crypto.createPrivateKey(fs.readFileSync(keyFile, "utf8"));
  const pub = crypto.createPublicKey(priv).export({ type: "spki", format: "pem" }).toString();
  return { signature: crypto.sign(null, signedMessage(m), priv).toString("base64"), keyId: keyId(pub) };
}

/** Public keys in a trust file: any number of PEM blocks. Unreadable blocks are ignored. */
export function loadTrusted(trustFile: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(trustFile, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const m of text.matchAll(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g)) {
    try {
      crypto.createPublicKey(m[0]);
      out.push(m[0].trim() + "\n");
    } catch {
      /* skip a damaged block */
    }
  }
  return out;
}

/** Add a public key to the trust file (idempotent). Returns the key's id. */
export function addTrusted(trustFile: string, publicPem: string): { ok: boolean; lines: string[] } {
  let id: string;
  try {
    id = keyId(publicPem);
  } catch {
    return { ok: false, lines: ["That is not a public key in PEM form (it should start with -----BEGIN PUBLIC KEY-----)."] };
  }
  const have = loadTrusted(trustFile);
  if (have.some((k) => keyId(k) === id)) return { ok: true, lines: [`Key ${id} is already trusted.`] };
  fs.mkdirSync(path.dirname(trustFile), { recursive: true });
  fs.writeFileSync(trustFile, [...have, publicPem.trim() + "\n"].join(""), "utf8");
  return { ok: true, lines: [`Trusted key ${id} added to ${trustFile}.`, "From now on, cephalo sync pull refuses any policy that is not signed by a trusted key."] };
}

export interface Verdict {
  ok: boolean;
  reason?: string;
  keyId?: string;
}

/** Check a manifest's signature against the trusted keys. */
export function verifyManifest(m: SignedFields & { signature?: unknown; keyId?: unknown }, trusted: string[]): Verdict {
  if (typeof m.signature !== "string" || !m.signature) return { ok: false, reason: "the policy is not signed" };
  let sig: Buffer;
  try {
    sig = Buffer.from(m.signature, "base64");
  } catch {
    return { ok: false, reason: "the signature is malformed" };
  }
  const msg = signedMessage(m);
  for (const pem of trusted) {
    try {
      if (crypto.verify(null, msg, crypto.createPublicKey(pem), sig)) return { ok: true, keyId: keyId(pem) };
    } catch {
      /* try the next key */
    }
  }
  return { ok: false, reason: "the signature does not match any trusted key (wrong signer, or the manifest was changed after signing)" };
}
