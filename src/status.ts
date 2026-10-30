import fs from "node:fs";
import { isMap, isSeq, parseDocument } from "yaml";
import {
  CLAUDE_CMD_RE,
  CLAUDE_MATCHER,
  HERMES_CMD_RE,
  HERMES_MATCHER,
  claudeCommand,
  hermesCommand,
} from "./install.js";

export interface HookStatus {
  fileExists: boolean;
  /** A Cephalo hook entry (any path) is present. */
  installed: boolean;
  /** Entry points at this project and uses the current matcher. */
  current: boolean;
  matcher?: string;
  command?: string;
  /** Set when the config file could not be read or parsed. */
  error?: string;
}

const none = (fileExists: boolean): HookStatus => ({ fileExists, installed: false, current: false });

export function claudeStatus(file: string, abs: string): HookStatus {
  if (!fs.existsSync(file)) return none(false);
  try {
    const txt = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const s = txt.trim() ? JSON.parse(txt) : {};
    const pre = s?.hooks?.PreToolUse;
    if (!Array.isArray(pre)) return none(true);
    for (const e of pre) {
      if (!Array.isArray(e?.hooks)) continue;
      for (const h of e.hooks) {
        if (typeof h?.command === "string" && CLAUDE_CMD_RE.test(h.command)) {
          return {
            fileExists: true,
            installed: true,
            matcher: e.matcher,
            command: h.command,
            current: e.matcher === CLAUDE_MATCHER && h.command === claudeCommand(abs),
          };
        }
      }
    }
    return none(true);
  } catch (e) {
    return { ...none(true), error: (e as Error).message };
  }
}

export function hermesStatus(file: string, abs: string): HookStatus {
  if (!fs.existsSync(file)) return none(false);
  try {
    const doc = parseDocument(fs.readFileSync(file, "utf8"));
    if (doc.errors.length) throw new Error(doc.errors[0]!.message);
    const seq = doc.getIn(["hooks", "pre_tool_call"], true);
    if (!isSeq(seq)) return none(true);
    for (const it of seq.items) {
      const j = isMap(it) ? it.toJSON() : null;
      if (j && typeof j.command === "string" && HERMES_CMD_RE.test(j.command)) {
        return {
          fileExists: true,
          installed: true,
          matcher: j.matcher,
          command: j.command,
          current: j.matcher === HERMES_MATCHER && j.command === hermesCommand(abs),
        };
      }
    }
    return none(true);
  } catch (e) {
    return { ...none(true), error: (e as Error).message };
  }
}
