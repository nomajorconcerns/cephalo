import fs from "node:fs";
import path from "node:path";
import type { PlatformAdapter } from "./platform.js";

/** macOS: /etc, /var and /tmp are symlinks into /private, so `/private/var/x` is written as `/var/x`. Expects forward slashes. */
export function stripMacPrivate(s: string): string {
  return s.replace(/^\/private(?=\/(etc|var|tmp)(\/|$))/, "");
}

/**
 * Real location of a path: symlinks resolved. A path that does not exist yet (a file about to be written) is resolved
 * through its deepest existing parent, so `link-dir/new.txt` still lands where the link points. Never throws.
 */
export function realish(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

/**
 * The places a file path really points at, besides the raw text and its normalized form:
 *   1. a relative path joined to the session's working directory (the agent's `cat notes.yml` is not the hook's cwd), and
 *   2. that path with symlinks resolved, when the platform is the one we are running on.
 * Each result is normalized the same way as the raw value, so the same rules match it. The raw value is not included.
 */
export function resolvedPathVariants(raw: string, cwd: string | undefined, platform: PlatformAdapter): string[] {
  const out: string[] = [];
  try {
    const win = platform.id === "win32";
    const P = win ? path.win32 : path.posix;
    const norm = platform.normalizePath(raw);
    let abs = norm;
    if (!P.isAbsolute(norm)) {
      const base = cwd ? platform.normalizePath(cwd) : undefined;
      if (!base || !P.isAbsolute(base)) return out;
      abs = platform.normalizePath(P.resolve(base, norm));
      out.push(abs);
    }
    if (win === (process.platform === "win32")) {
      const real = platform.normalizePath(realish(abs));
      if (real !== abs && real !== norm) out.push(real);
    }
  } catch {
    /* resolution is an extra check; it must never break evaluation */
  }
  return out;
}
