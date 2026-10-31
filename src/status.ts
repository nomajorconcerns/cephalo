import fs from "node:fs";
import { isMap, isSeq, parseDocument } from "yaml";
import {
  CLAUDE_CMD_RE,
  CLAUDE_MATCHER,
  CLAUDE_POST_MATCHER,
  HERMES_CMD_RE,
  HERMES_MATCHER,
  HERMES_POST_MATCHER,
  claudeCommand,
  hermesCommand,
} from "./install.js";

export interface HookStatus {
  fileExists: boolean;
  /** A Cephalo hook entry (any path) is present. */
  installed: boolean;
  /** Both the before-call and after-call entries point at this project and use the current matchers. */
  current: boolean;
  matcher?: string;
  command?: string;
  /** The after-call entry (feeds the prompt-injection tripwire) is present and current. */
  postCurrent?: boolean;
  postMatcher?: string;
  /** Set when the config file could not be read or parsed. */
  error?: string;
}

const none = (fileExists: boolean): HookStatus => ({ fileExists, installed: false, current: false });

interface Found {
  matcher?: string;
  command: string;
}

function checkPost(found: Found | null, matcher: string, cmd: string): { postCurrent: boolean; postMatcher?: string } {
  return { postCurrent: !!found && found.matcher === matcher && found.command === cmd, postMatcher: found?.matcher };
}

export function claudeStatus(file: string, abs: string): HookStatus {
  if (!fs.existsSync(file)) return none(false);
  try {
    const txt = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const s = txt.trim() ? JSON.parse(txt) : {};
    const find = (section: string): Found | null => {
      const list = s?.hooks?.[section];
      if (!Array.isArray(list)) return null;
      for (const e of list) {
        if (!Array.isArray(e?.hooks)) continue;
        for (const h of e.hooks) if (typeof h?.command === "string" && CLAUDE_CMD_RE.test(h.command)) return { matcher: e.matcher, command: h.command };
      }
      return null;
    };
    const pre = find("PreToolUse");
    if (!pre) return none(true);
    const cmd = claudeCommand(abs);
    const post = checkPost(find("PostToolUse"), CLAUDE_POST_MATCHER, cmd);
    return { fileExists: true, installed: true, matcher: pre.matcher, command: pre.command, current: pre.matcher === CLAUDE_MATCHER && pre.command === cmd && post.postCurrent, ...post };
  } catch (e) {
    return { ...none(true), error: (e as Error).message };
  }
}

export function hermesStatus(file: string, abs: string): HookStatus {
  if (!fs.existsSync(file)) return none(false);
  try {
    const doc = parseDocument(fs.readFileSync(file, "utf8"));
    if (doc.errors.length) throw new Error(doc.errors[0]!.message);
    const find = (section: string): Found | null => {
      const seq = doc.getIn(["hooks", section], true);
      if (!isSeq(seq)) return null;
      for (const it of seq.items) {
        const j = isMap(it) ? it.toJSON() : null;
        if (j && typeof j.command === "string" && HERMES_CMD_RE.test(j.command)) return { matcher: j.matcher, command: j.command };
      }
      return null;
    };
    const pre = find("pre_tool_call");
    if (!pre) return none(true);
    const cmd = hermesCommand(abs);
    const post = checkPost(find("post_tool_call"), HERMES_POST_MATCHER, cmd);
    return { fileExists: true, installed: true, matcher: pre.matcher, command: pre.command, current: pre.matcher === HERMES_MATCHER && pre.command === cmd && post.postCurrent, ...post };
  } catch (e) {
    return { ...none(true), error: (e as Error).message };
  }
}
