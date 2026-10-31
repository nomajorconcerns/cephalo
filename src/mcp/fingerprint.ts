import { createHash } from "node:crypto";

/** A tool definition as an MCP server reports it in `tools/list`. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

/** JSON with object keys sorted at every level, so key order can never change a fingerprint. */
export function canonicalize(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
    .join(",")}}`;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Fingerprint of everything a model reads about a tool: name, title, description, input/output
 * schema and annotations. A changed description or a changed parameter is a changed tool.
 */
export function fingerprintTool(t: McpTool): string {
  return sha(
    canonicalize({
      name: t.name,
      title: t.title ?? null,
      description: t.description ?? null,
      inputSchema: t.inputSchema ?? null,
      outputSchema: t.outputSchema ?? null,
      annotations: t.annotations ?? null,
    }),
  );
}

/** One fingerprint for a whole server: the tool fingerprints, sorted by tool name. */
export function fingerprintServer(tools: McpTool[]): string {
  return sha([...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => `${t.name}=${fingerprintTool(t)}`).join("\n"));
}

export const short = (fp: string) => fp.slice(0, 12);

export interface PinnedTool {
  fingerprint: string;
  /** Kept so a later change can be shown as before/after. Truncated. */
  description: string;
  schema: string;
}

const MAX_DESC = 8000;
const MAX_SCHEMA = 20000;

export function snapshotTool(t: McpTool): PinnedTool {
  const schema = canonicalize(t.inputSchema ?? null);
  return {
    fingerprint: fingerprintTool(t),
    description: (t.description ?? "").slice(0, MAX_DESC),
    schema: schema.length > MAX_SCHEMA ? `${schema.slice(0, MAX_SCHEMA)}…` : schema,
  };
}

export interface ToolChange {
  name: string;
  /** Which parts changed: description, schema, or other (title/annotations/outputSchema). */
  fields: Array<"description" | "schema" | "other">;
  before: PinnedTool;
  after: PinnedTool;
}

export interface ToolDiff {
  changed: ToolChange[];
  added: string[];
  removed: string[];
}

export const diffIsEmpty = (d: ToolDiff) => d.changed.length + d.added.length + d.removed.length === 0;

/** Compare an approved set of tools with what the server reports now. */
export function diffTools(pinned: Record<string, PinnedTool>, current: McpTool[]): ToolDiff {
  const out: ToolDiff = { changed: [], added: [], removed: [] };
  const now = new Map(current.map((t) => [t.name, t]));
  for (const [name, before] of Object.entries(pinned)) {
    const t = now.get(name);
    if (!t) {
      out.removed.push(name);
      continue;
    }
    const after = snapshotTool(t);
    if (after.fingerprint === before.fingerprint) continue;
    const fields: ToolChange["fields"] = [];
    if (after.description !== before.description) fields.push("description");
    if (after.schema !== before.schema) fields.push("schema");
    if (fields.length === 0) fields.push("other");
    out.changed.push({ name, fields, before, after });
  }
  for (const t of current) if (!(t.name in pinned)) out.added.push(t.name);
  out.changed.sort((a, b) => a.name.localeCompare(b.name));
  out.added.sort();
  out.removed.sort();
  return out;
}
