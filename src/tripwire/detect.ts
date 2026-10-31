/**
 * Prompt-injection detector. It looks at text an agent has just READ (a file, a web page, command output, an MCP result)
 * for instructions aimed at the model. It is a heuristic tripwire, not a classifier: it will miss paraphrased attacks and
 * it will flag documents that merely talk about prompt injection. What it buys you is that a hit changes what the agent
 * is allowed to do next (see escalation.ts), so a successful injection has a much harder time doing damage.
 */

export type Severity = "high" | "medium" | "low";

export interface Finding {
  id: string;
  severity: Severity;
  label: string;
  /** A short, printable-ASCII slice of the normalized text around the match. */
  excerpt: string;
}

export interface Verdict {
  /** none: nothing worth acting on. watch: logged only. alert: the session becomes tainted. */
  level: "none" | "watch" | "alert";
  findings: Finding[];
}

/** Characters scanned per tool result (the head is where injections are planted; also bounds the cost). */
export const MAX_SCAN_CHARS = 300_000;

const ZERO_WIDTH = /[\u200B\u200C\u2060\uFEFF\u00AD\u180E]/g;
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g;
const TAGS = /[\u{E0000}-\u{E007F}]/gu;

/** Unicode "tag" characters mirror ASCII invisibly; attackers use them to hide whole sentences. */
export function decodeTagChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCharCode(cp - 0xe0000);
  }
  return out;
}

interface PatternDef {
  id: string;
  severity: Severity;
  label: string;
  re: RegExp;
}

// Applied to normalized text: NFKC, invisible characters removed, whitespace collapsed to single spaces, lower-cased.
const PATTERNS: PatternDef[] = [
  {
    id: "override",
    severity: "high",
    label: "Tells the model to ignore or override its instructions",
    re: /\b(?:ignore|disregard|forget|override|discard)\b\W+(?:\w+\W+){0,3}?(?:previous|prior|above|earlier|preceding|original|system|your)\W+(?:\w+\W+){0,3}?(?:instructions?|prompts?|rules|guidelines|directives|constraints|programming|training)\b/,
  },
  {
    id: "role-spoof",
    severity: "high",
    label: "Fake system/assistant markers inside content",
    re: /<\|im_(?:start|end)\|>|<\|(?:system|assistant|user|endoftext)\|>|\[\/?inst\]|<<\/?sys>>|<\s*\/?\s*(?:system|system-reminder|assistant)\s*>|\bsystem (?:override|prompt override)\b/,
  },
  {
    id: "jailbreak",
    severity: "medium",
    label: "Jailbreak or mode-switch phrasing",
    re: /\byou are (?:now )?(?:dan|in developer mode|jailbroken|unrestricted|unfiltered)\b|\bdeveloper mode (?:enabled|on|activated)\b|\bjailbreak(?:ed)?\b|\bfrom now on,? you (?:will|must|are|should|shall)\b/,
  },
  {
    id: "new-instructions",
    severity: "medium",
    label: "Announces new instructions",
    re: /\b(?:new|updated|revised|real|actual|important) (?:system )?(?:instructions?|directives?)\s*(?::|-|follow)/,
  },
  {
    id: "addressed-to-ai",
    severity: "medium",
    label: "Addresses the AI/agent directly",
    re: /\b(?:attention|note|message|instructions?|important|notice)\W+(?:\w+\W+){0,2}?(?:to|for)\W+(?:the\W+)?(?:ai|llm|assistant|agent|language model|claude|gpt|chatgpt|hermes|copilot|gemini)s?\b|\bif you are (?:an? )?(?:ai|llm|language model|assistant|agent|automated|bot)\b|\b(?:ai|llm) (?:agents?|assistants?|models?) (?:must|should|shall|need to|are required to)\b|\bwhen (?:an? )?(?:ai|llm|assistant|agent) (?:reads|sees|processes)\b/,
  },
  {
    id: "secrecy",
    severity: "medium",
    label: "Asks to hide something from the user",
    re: /\b(?:do not|don't|never|without)\b\W+(?:\w+\W+){0,3}?(?:tell|inform|notify|alert|mention|reveal|show|disclose|telling|informing|notifying)\W+(?:\w+\W+){0,3}?(?:user|human|operator|owner)\b|\b(?:hide|conceal) (?:this|it|that) from (?:the )?(?:user|human)\b/,
  },
  {
    id: "silent-action",
    severity: "medium",
    label: "Asks for a silent action",
    re: /\b(?:silently|secretly|quietly|covertly)\W+(?:\w+\W+){0,3}?(?:send|post|upload|run|execute|delete|install|fetch|download|forward|exfiltrate)\b/,
  },
  {
    id: "html-comment",
    severity: "medium",
    label: "Hidden HTML comment aimed at an AI",
    re: /<!--[^>]{0,600}?\b(?:assistant|ai agent|ai model|llm|language model|ignore (?:all|previous|prior)|do not tell)\b[^>]{0,600}?-->/,
  },
  {
    id: "image-beacon",
    severity: "medium",
    label: "Markdown image that sends data to a URL",
    re: /!\[[^\]]{0,100}\]\(\s*https?:\/\/[^)\s]+\?[^)\s]*(?:\{[^)}]*\}|%7b|\b(?:data|d|q|key|token|secret|content|msg|payload)=)/,
  },
  { id: "run-command", severity: "low", label: "Asks to run a command", re: /\b(?:run|execute|paste|enter)\b\W+(?:\w+\W+){0,4}?(?:following|this|these)\W+(?:\w+\W+){0,3}?(?:commands?|script|code|snippet)\b/ },
  { id: "pipe-to-shell", severity: "low", label: "Pipes a download into a shell", re: /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|\n]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring)\b[^|\n]{0,200}\|\s*iex\b|\biex\s*\(\s*(?:new-object|iwr|irm)/ },
  { id: "encoded-command", severity: "low", label: "Encoded PowerShell command", re: /\bpowershell(?:\.exe)?\b[^\n]{0,80}\s-(?:enc|encodedcommand|e)\s+[a-z0-9+/=]{20,}/ },
];

const SECRET_STRICT = /\.env\b|\bssh keys?\b|\bprivate keys?\b|\bid_rsa\b|\bid_ed25519\b|\benvironment variables?\b|\benv vars?\b|\.aws\b|\.npmrc\b|\.netrc\b|\.git-credentials\b|\bcookies?\b|\bkeychain\b|\bcredentials? (?:file|store)\b/g;
const SECRET_GENERIC = /\bsecrets?\b|\bapi[ _-]?keys?\b|\baccess tokens?\b|\bauth(?:entication)? tokens?\b|\bpasswords?\b|\bcredentials?\b/g;
const EXFIL_VERB = /\b(?:send|post|upload|forward|email|mail|exfiltrat\w*|transmit|leak|submit|curl|wget)\b/;
const EXFIL_DEST = /https?:\/\/|\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b|\bwebhook\b|\bpastebin\b|\bngrok\b|\brequestbin\b|\battacker\b|\bmy server\b|\bthis (?:url|endpoint|address)\b|\bfollowing (?:url|endpoint|address)\b/;

function excerptOf(t: string, idx: number, len: number): string {
  const s = t.slice(Math.max(0, idx - 15), idx + Math.min(len, 100) + 25);
  return s.replace(/[^\x20-\x7e]/g, "?").trim().slice(0, 140);
}

/** Collapse text the way a model effectively reads it: compatibility forms, no invisibles, single spaces, lower case. */
export function normalizeForScan(raw: string): string {
  return raw.normalize("NFKC").replace(TAGS, "").replace(ZERO_WIDTH, "").replace(BIDI, "").replace(/\s+/g, " ").toLowerCase();
}

function runPatterns(t: string, out: Finding[], suffix = ""): void {
  for (const p of PATTERNS) {
    const m = p.re.exec(t);
    if (m) out.push({ id: p.id + suffix, severity: p.severity, label: p.label + (suffix ? " (inside encoded text)" : ""), excerpt: excerptOf(t, m.index, m[0].length) });
  }
  // secrets + a sending verb + somewhere to send it to
  let best: Finding | null = null;
  for (const [re, strict] of [[SECRET_STRICT, true], [SECRET_GENERIC, false]] as const) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(t)) && guard++ < 200) {
      const win = t.slice(Math.max(0, m.index - 120), m.index + m[0].length + 160);
      if (!EXFIL_VERB.test(win)) continue;
      const dest = EXFIL_DEST.test(win);
      const severity: Severity | null = strict ? (dest ? "high" : "medium") : dest ? "medium" : null;
      if (!severity) continue;
      const f: Finding = { id: "exfil-directive" + suffix, severity, label: "Tells the model to send secrets somewhere", excerpt: excerptOf(t, m.index, m[0].length) };
      if (!best || (best.severity !== "high" && severity === "high")) best = f;
      if (best.severity === "high") break;
    }
    if (best?.severity === "high") break;
  }
  if (best) out.push(best);
}

const printableRatio = (s: string) => {
  if (!s.length) return 0;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) ok++;
  }
  return ok / s.length;
};

/** Scan one blob of text read by the agent. */
export function scanText(raw: string): Verdict {
  const text = raw.length > MAX_SCAN_CHARS ? raw.slice(0, MAX_SCAN_CHARS) : raw;
  const findings: Finding[] = [];

  const hiddenTags = decodeTagChars(text);
  const t = normalizeForScan(text + (hiddenTags ? ` ${hiddenTags}` : ""));
  if (hiddenTags.length >= 4) {
    findings.push({ id: "hidden-tags", severity: "high", label: "Invisible Unicode text (tag characters)", excerpt: excerptOf(hiddenTags.toLowerCase(), 0, 100) });
  }
  const bidi = text.match(BIDI)?.length ?? 0;
  if (bidi > 0) findings.push({ id: "bidi", severity: "medium", label: "Bidirectional-override characters (text can display differently from what it says)", excerpt: `${bidi} character(s)` });
  const zw = text.match(ZERO_WIDTH)?.length ?? 0;
  if (zw >= 5) findings.push({ id: "zero-width", severity: "low", label: "Many zero-width characters", excerpt: `${zw} character(s)` });

  runPatterns(t, findings);

  // base64 payloads that decode to instructions
  const b64 = text.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? [];
  for (const tok of b64.slice(0, 40)) {
    let dec = "";
    try {
      dec = Buffer.from(tok, "base64").toString("utf8");
    } catch {
      continue;
    }
    if (dec.length < 20 || printableRatio(dec) < 0.9) continue;
    const inner: Finding[] = [];
    runPatterns(normalizeForScan(dec), inner, "@base64");
    const hit = inner.find((f) => f.severity !== "low");
    if (hit) {
      findings.push({ ...hit, id: "encoded-injection", severity: "high", label: `Base64 text that decodes to: ${hit.label.toLowerCase()}` });
      break;
    }
  }

  // one finding per id (keep the most severe)
  const rank: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
  const byId = new Map<string, Finding>();
  for (const f of findings) {
    const cur = byId.get(f.id);
    if (!cur || rank[f.severity] > rank[cur.severity]) byId.set(f.id, f);
  }
  const list = [...byId.values()].sort((a, b) => rank[b.severity] - rank[a.severity]);
  return { level: levelOf(list), findings: list };
}

/**
 * alert: at least one high finding, or two different medium findings.
 * watch: a single medium finding. Low findings (a README that says "run the following command") count as medium
 * only when something else suspicious is present; on their own they change nothing.
 */
export function levelOf(findings: Finding[]): Verdict["level"] {
  const hi = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "medium").length;
  const low = findings.filter((f) => f.severity === "low").length;
  if (hi > 0) return "alert";
  const eff = med + (med > 0 || hi > 0 ? low : 0);
  if (eff >= 2) return "alert";
  if (med >= 1) return "watch";
  return "none";
}
