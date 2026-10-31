import { StringDecoder } from "node:string_decoder";

/** Every way a secret is likely to show up in output: as is, base64 (std/url, padded or not), percent-encoded, JSON-escaped. */
export function variantsOf(value: string): string[] {
  const buf = Buffer.from(value, "utf8");
  const b64 = buf.toString("base64");
  const set = new Set<string>([
    value,
    b64,
    b64.replace(/=+$/, ""),
    b64.replace(/\+/g, "-").replace(/\//g, "_"),
    b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]);
  return [...set].filter((v) => v.length >= 6);
}

/**
 * Streaming redactor. Feed it output chunks; it returns text with every secret replaced by [REDACTED:NAME].
 * It holds back the last (longest-secret - 1) characters of each chunk so a secret split across two chunks is still caught.
 */
export class Scrubber {
  private readonly subs: Array<{ text: string; label: string }>;
  private readonly hold: number;
  private tail = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(secrets: Record<string, string>) {
    const subs: Array<{ text: string; label: string }> = [];
    for (const [name, value] of Object.entries(secrets)) for (const v of variantsOf(value)) subs.push({ text: v, label: `[REDACTED:${name}]` });
    subs.sort((a, b) => b.text.length - a.text.length); // longest first, so a base64 form is not eaten by a shorter substring
    this.subs = subs;
    this.hold = Math.max(0, ...subs.map((s) => s.text.length)) - 1;
  }

  private redact(text: string): string {
    let out = text;
    for (const s of this.subs) if (out.includes(s.text)) out = out.split(s.text).join(s.label);
    return out;
  }

  push(chunk: Buffer | string): string {
    const text = this.tail + (typeof chunk === "string" ? chunk : this.decoder.write(chunk));
    const red = this.redact(text);
    // Only the unredacted suffix could still be the start of a secret; keep it for the next chunk.
    if (this.hold <= 0 || red.length <= this.hold) {
      this.tail = this.hold > 0 ? red : "";
      return this.hold > 0 ? "" : red;
    }
    const cut = red.length - this.hold;
    // never cut inside a redaction marker
    const open = red.lastIndexOf("[REDACTED:", cut);
    const safeCut = open >= 0 && red.indexOf("]", open) >= cut ? open : cut;
    this.tail = red.slice(safeCut);
    return red.slice(0, safeCut);
  }

  flush(): string {
    const rest = this.redact(this.tail + this.decoder.end());
    this.tail = "";
    return rest;
  }
}
