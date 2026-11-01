import { formatDuration, needsAttention, type Replay, type ReplayEvent } from "./model.js";

/** Hidden marker in the comment, so a later run can find and update the same comment. */
export const MARKER = "<!-- cephalo-replay -->";
/** GitHub rejects comments over 65,536 characters; stay well under. */
export const DEFAULT_MAX_CHARS = 60_000;

/** Anything that came from the log goes inside a code span, so it can never become markdown, HTML or a mention. */
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const stamp = (ts: string) => `${ts.slice(5, 10)} ${ts.slice(11, 19)}Z`;

function tagOf(e: ReplayEvent): string {
  if (e.kind === "tripwire") return e.rule === "tripwire-alert" ? "ALERT" : "WATCH";
  if (e.kind === "leak") return "LEAK";
  if (e.kind === "vault") return e.decision === "block" ? "VAULT!" : "VAULT";
  return e.decision === "block" ? "BLOCK" : e.asked ? "ASK" : "ALLOW";
}

function lineOf(e: ReplayEvent): string {
  const rule = (e.decision === "block" || e.asked) && e.rule ? ` [${e.rule}]` : e.kind === "tripwire" || e.kind === "leak" ? ` [${e.rule}]` : "";
  const subject = e.subject || (e.note ? clip(e.note, 120) : "");
  return `${stamp(e.ts)}  ${tagOf(e).padEnd(6)} ${e.agent}/${e.tool}${rule}  ${clip(subject, 140)}`.replace(/```/g, "'''");
}

function attentionLine(e: ReplayEvent): string {
  const at = code(stamp(e.ts));
  const who = `${code(`${e.agent}/${e.tool}`)}`;
  switch (e.kind) {
    case "tripwire":
      return `- ${at} **Prompt-injection ${e.rule === "tripwire-alert" ? "alert" : "signal"}** in the output of ${who}: ${code(clip(e.note ?? "", 200))}`;
    case "leak":
      return `- ${at} **Credential in output** of ${who}: ${code(clip(e.note ?? "", 200))}`;
    case "vault":
      return `- ${at} **Vault use refused** ${code(clip(e.subject, 120))}: ${code(clip(e.note ?? e.rule ?? "", 160))}`;
    default:
      return `- ${at} **Blocked** ${who} ${code(clip(e.subject, 140))} by rule ${code(e.rule ?? "?")}`;
  }
}

export interface MarkdownOptions {
  maxChars?: number;
}

export function renderMarkdown(r: Replay, o: MarkdownOptions = {}): string {
  const max = o.maxChars ?? DEFAULT_MAX_CHARS;
  const s = r.stats;
  const m = r.meta;
  const head: string[] = [MARKER, "## Cephalo replay", ""];

  const where = [m.repo?.branch ? `branch ${code(m.repo.branch)}` : null, m.repo?.base ? `base ${code(m.repo.base)}` : null, m.repo?.head ? `at ${code(m.repo.head)}` : null, m.pr ? `PR #${m.pr.number}` : null].filter(Boolean);
  if (where.length) head.push(where.join(" · "), "");
  if (s.total === 0) {
    head.push("No agent activity was recorded in this window.", "", `Window: ${code(m.window.since ?? "?")} to ${code(m.window.until ?? m.generatedAt)}`);
    for (const n of m.notes) head.push(`- ${n}`);
    head.push("", footer(r));
    return head.join("\n");
  }
  head.push(
    `${s.agents.join(", ")}${s.users.length ? ` (${s.users.join(", ")})` : ""} · ${s.sessions || "unknown number of"} session${s.sessions === 1 ? "" : "s"} · ${stamp(s.first!)} to ${stamp(s.last!)} (${formatDuration(s.durationMs)})`,
    "",
    "| Tool calls | Blocked | Injection signals | Credential leaks | Vault runs | MCP calls |",
    "|---:|---:|---:|---:|---:|---:|",
    `| ${s.calls} | ${s.blocked} | ${s.tripwire.alert + s.tripwire.watch} | ${s.leaks} | ${s.vault.runs} | ${s.mcp.calls} |`,
    "",
  );
  const rules = Object.entries(s.byRule).sort((a, b) => b[1] - a[1]);
  if (rules.length) head.push(`Blocked by: ${rules.slice(0, 8).map(([k, v]) => `${code(k)} ×${v}`).join(", ")}`, "");
  if (s.vault.names.length) head.push(`Secrets used through the vault (names only): ${s.vault.names.map(code).join(", ")}`, "");
  if (s.mcp.servers.length) head.push(`MCP servers called: ${s.mcp.servers.map(code).join(", ")}`, "");

  const attention = r.events.filter(needsAttention);
  const mid: string[] = [];
  if (attention.length) {
    mid.push("### Needs attention", "");
    for (const e of attention.slice(0, 30)) mid.push(attentionLine(e));
    if (attention.length > 30) mid.push(`- …and ${attention.length - 30} more (see the timeline)`);
    mid.push("");
  } else {
    mid.push("Nothing was blocked and no injection or credential signals were seen.", "");
  }
  if (s.filesWritten.length) {
    mid.push(`### Files written (${s.filesWritten.length}${s.filesWritten.length >= 200 ? "+" : ""})`, "");
    for (const f of s.filesWritten.slice(0, 40)) mid.push(`- ${code(clip(f, 160))}`);
    if (s.filesWritten.length > 40) mid.push(`- …and ${s.filesWritten.length - 40} more`);
    mid.push("");
  }
  const tail = ["", ...m.notes.map((n) => `> ${n}`), m.notes.length ? "" : "", footer(r)];

  // timeline, thinned only as much as needed to fit
  const fixed = [...head, ...mid, ...tail].join("\n").length;
  const budget = max - fixed - 300;
  const { lines, omitted } = timeline(r.events, budget);
  const body = [`<details><summary>Timeline (${r.events.length} events${omitted ? `, ${omitted} routine ones not shown to fit the comment size; the HTML replay has everything` : ""})</summary>`, "", "```text", ...lines, "```", "", "</details>"];
  return [...head, ...mid, ...body, ...tail].join("\n");
}

function timeline(events: ReplayEvent[], budget: number): { lines: string[]; omitted: number } {
  const all = events.map(lineOf);
  const size = (ls: string[]) => ls.reduce((n, l) => n + l.length + 1, 0);
  if (size(all) <= budget) return { lines: all, omitted: 0 };
  const important = (e: ReplayEvent) => needsAttention(e) || e.kind === "vault";
  for (const edge of [25, 10, 3, 0]) {
    const out: string[] = [];
    let gap = 0;
    let omitted = 0;
    events.forEach((e, i) => {
      if (important(e) || i < edge || i >= events.length - edge) {
        if (gap) out.push(`  … ${gap} routine event${gap === 1 ? "" : "s"} not shown …`);
        gap = 0;
        out.push(all[i]);
      } else {
        gap++;
        omitted++;
      }
    });
    if (gap) out.push(`  … ${gap} routine event${gap === 1 ? "" : "s"} not shown …`);
    if (size(out) <= budget) return { lines: out, omitted };
  }
  // even the important events do not fit: keep the most recent ones
  const imp = events.map((e, i) => (important(e) ? i : -1)).filter((i) => i >= 0);
  const keep: string[] = [];
  let used = 0;
  for (let k = imp.length - 1; k >= 0; k--) {
    const l = all[imp[k]];
    if (used + l.length + 1 > budget - 120) break;
    keep.unshift(l);
    used += l.length + 1;
  }
  return { lines: [`  … ${imp.length - keep.length} earlier notable events and all routine events not shown …`, ...keep], omitted: events.length - keep.length };
}

function footer(r: Replay): string {
  return `<sub>Generated by Cephalo ${r.meta.version} on ${r.meta.generatedAt} from the local audit log. Window: ${r.meta.window.basis}. This is a record kept on the author's machine, not a signed attestation.</sub>`;
}
