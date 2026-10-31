/**
 * Make tool parameters safe to write to the audit log: secret-looking keys and values are masked,
 * long strings are truncated, and the structure is bounded. Used for every logged MCP call.
 */
const SECRET_KEY = /pass(word|wd)?|secret|token|api[-_]?key|apikey|authorization|auth|credential|cookie|bearer|private[-_]?key|session/i;
const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI / Anthropic style
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/, // Google API key
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, // JWT
];

export const REDACTED = "[redacted]";
const MAX_STRING = 1000;
const MAX_ITEMS = 50;
const MAX_DEPTH = 6;

export function looksLikeSecret(value: string): boolean {
  return SECRET_VALUE.some((re) => re.test(value));
}

export function redactParams(value: unknown, depth = 0, key = ""): unknown {
  if (key && SECRET_KEY.test(key) && value !== null && value !== undefined && value !== "") return REDACTED;
  if (typeof value === "string") {
    if (looksLikeSecret(value)) return REDACTED;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[nested too deep]";
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ITEMS).map((v) => redactParams(v, depth + 1));
    if (value.length > MAX_ITEMS) out.push(`…(+${value.length - MAX_ITEMS} more items)`);
    return out;
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n++ >= MAX_ITEMS) {
      out["…"] = `+${Object.keys(value as object).length - MAX_ITEMS} more keys`;
      break;
    }
    out[k] = redactParams(v, depth + 1, k);
  }
  return out;
}
