import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cephaloDir } from "./rules.js";
import {
  LICENSE_VALID_DAYS,
  PRICING_URL,
  PRO_PACKAGE,
  activateLicense,
  deactivateLicense,
  licensePath,
  licenseState,
  loadPro,
  notAvailableMessage,
  proDir,
  proEntry,
  proRoots,
  readLicense,
  validateLicense,
  writeLicense,
  LEGACY_MESSAGE,
  isLegacyRecord,
  type Fetch,
  type PolarIds,
} from "./pro.js";

export const PRO_USAGE = `Usage: cephalo pro [status | activate [key] | renew [key] | install <file.tgz> | deactivate [key] | path]

  status          what plan this machine has, and whether the Pro package is installed (no network)
  activate        use the license key from your Polar purchase on this machine
  renew           check the license with the server again (needed about every ${LICENSE_VALID_DAYS} days, so cancelled subscriptions end)
  install <file>  install the downloaded Pro package into ~/.cephalo/pro (an alternative to: npm install -g ./cephalo-pro-0.2.0.tgz)
  deactivate      give this machine's seat back, so the key can be used on another computer
  path            where the license and the package are kept

Your Polar purchase has two things: a license key and a file download, cephalo-pro-0.2.0.tgz (both are in Polar's
email and its customer portal). Install the download with
  npm install -g ./cephalo-pro-0.2.0.tgz
then run: cephalo pro activate
(npm fetches the package's one dependency, yaml, from the public registry. Nothing from your purchase goes to npm.)

The key is asked for without echo if you do not give it. It is not stored; only its last four characters are.
CEPHALO_LICENSE_KEY can hold it for a script. CEPHALO_POLAR_SANDBOX=1 uses Polar's sandbox (for testing).
Plans: ${PRICING_URL}
`;

export interface NpmRun {
  status: number;
  stderr: string;
}
export interface ProCmdDeps {
  dir?: string;
  fetch?: Fetch;
  api?: string;
  /** Polar organization and benefit IDs (tests); the built-in settings by default. */
  polar?: PolarIds;
  now?: Date;
  env?: Record<string, string | undefined>;
  /** Asks for the key without echo; null when there is no terminal. */
  readKey?: () => Promise<string | null>;
  /** Runs npm. Replaced in tests: nothing in the test suite installs a package or touches the network. */
  runNpm?: (args: string[], env: Record<string, string | undefined>) => NpmRun;
  /** Where the package may be installed (tests). */
  roots?: string[];
  hostname?: string;
}
export interface ProCmdResult {
  lines: string[];
  exitCode: number;
}

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

function defaultRunNpm(args: string[], env: Record<string, string | undefined>): NpmRun {
  const r = spawnSync("npm", args.map(q), { shell: true, encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 180_000 });
  return { status: r.status ?? 1, stderr: String(r.stderr ?? "") + (r.error ? ` ${r.error.message}` : "") };
}

/**
 * Install a downloaded Pro package file into ~/.cephalo/pro. Install scripts are not run. Nothing is sent anywhere except what npm
 * itself fetches: the package's own dependency from the public registry.
 */
export function installProFile(file: string, d: ProCmdDeps = {}): { ok: boolean; lines: string[] } {
  const dir = d.dir ?? cephaloDir();
  const run = d.runNpm ?? defaultRunNpm;
  const abs = path.resolve(file);
  if (!/\.(tgz|tar\.gz)$/i.test(abs)) return { ok: false, lines: [`${file} is not a package file. Use the cephalo-pro-0.2.0.tgz from your Polar purchase.`] };
  if (!fs.existsSync(abs)) return { ok: false, lines: [`No file at ${abs}.`] };
  const target = proDir(dir);
  fs.mkdirSync(target, { recursive: true });
  const args = ["install", abs, "--prefix", target, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
  const r = run(args, { ...(d.env ?? process.env), npm_config_update_notifier: "false" });
  if (r.status === 0 && proEntry(dir, [path.join(target, "node_modules", ...PRO_PACKAGE.split("/"))])) return { ok: true, lines: [`Installed ${PRO_PACKAGE} into ${target}`] };
  const text = r.stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ");
  return { ok: false, lines: [`Could not install ${file}${text ? ` (${text.slice(0, 300)})` : ""}.`, "Check your connection (npm needs to fetch one dependency), then try again."] };
}

async function keyFrom(args: string[], d: ProCmdDeps): Promise<string | null> {
  const env = d.env ?? process.env;
  const given = args.find((a) => !a.startsWith("-"));
  if (given) return given;
  if (env.CEPHALO_LICENSE_KEY?.trim()) return env.CEPHALO_LICENSE_KEY.trim();
  return d.readKey ? d.readKey() : null;
}
const NO_KEY = ["No license key. Pass it as an argument, set CEPHALO_LICENSE_KEY, or run this in a terminal to be asked for it."];

export async function proCommand(args: string[], d: ProCmdDeps = {}): Promise<ProCmdResult> {
  const dir = d.dir ?? cephaloDir();
  const sub = args[0] ?? "status";
  const rest = args.slice(1);
  const ops = { fetch: d.fetch, api: d.api, polar: d.polar, env: d.env ?? process.env, now: d.now, hostname: d.hostname };
  const roots = d.roots ?? proRoots(dir);

  if (sub === "path") return { lines: [`license: ${licensePath(dir)}`, `package: ${roots.join("  or  ")}`], exitCode: 0 };

  if (sub === "status") {
    const st = licenseState(readLicense(licensePath(dir)), d.now);
    const lines: string[] = [];
    if (st.state === "none") {
      lines.push("Plan: Free (everything that was in 0.1.1, plus the free 0.2.0 features).", `Pro adds the network egress allowlist, the tamper-evident audit log and the bypass benchmark. Plans: ${PRICING_URL}`, "Have a key? Run: cephalo pro activate");
      return { lines, exitCode: 0 };
    }
    if (st.state === "legacy") {
      lines.push(`Plan: Free for now. ${LEGACY_MESSAGE}`, "Everything that was in 0.1.1, plus the free 0.2.0 features, keeps working.");
      return { lines, exitCode: 0 };
    }
    const l = st.license;
    lines.push(`Plan: ${l.tier}${l.email ? ` (${l.email})` : ""}, key ending ${l.keyHint}, on ${l.instanceName}${l.sandbox ? " (Polar sandbox)" : ""}`);
    if (st.state === "active") lines.push(`License: checked ${new Date(l.validatedAt).toISOString().slice(0, 10)}; trusted for ${st.daysLeft} more day(s) before it needs: cephalo pro renew`);
    else if (st.state === "stale") lines.push(`License: last checked ${st.daysAgo} days ago, so the paid features are off. Run: cephalo pro renew`);
    else lines.push(`License: expired ${l.expiresAt}. Renew the subscription, then run: cephalo pro renew`);
    const loaded = loadPro({ dir, now: d.now, roots });
    lines.push(loaded.ok ? `Package: ${PRO_PACKAGE} loaded (paid features on)` : `Package: ${notAvailableMessage("audit", loaded).slice(1).join(" ")}`);
    return { lines, exitCode: 0 };
  }

  if (sub === "install") {
    const file = rest.find((a) => !a.startsWith("-"));
    if (!file) return { lines: ["Pass the downloaded file: cephalo pro install ./cephalo-pro-0.2.0.tgz", "Or install it for every user of this computer with: npm install -g ./cephalo-pro-0.2.0.tgz"], exitCode: 1 };
    const r = installProFile(file, d);
    return { lines: r.lines, exitCode: r.ok ? 0 : 1 };
  }

  if (sub === "activate") {
    const existing = licenseState(readLicense(licensePath(dir)), d.now);
    if (existing.state === "active") return { lines: [`This machine already has a ${existing.license.tier} license (key ending ${existing.license.keyHint}). To move it, run: cephalo pro deactivate`], exitCode: 1 };
    const key = await keyFrom(rest, d);
    if (!key) return { lines: NO_KEY, exitCode: 1 };
    const r = await activateLicense(key, ops);
    if (!r.ok) return { lines: [`Could not activate: ${r.error}`], exitCode: 1 };
    writeLicense(r.record, licensePath(dir));
    const lines = [`Activated: Cephalo ${r.record.tier} on ${r.record.instanceName} (key ending ${r.record.keyHint}).`];
    if (proEntry(dir, roots)) lines.push("The Pro package is installed. Try: cephalo bench   |   cephalo audit verify   |   cephalo egress");
    else lines.push("The Pro package is not installed yet. Install the cephalo-pro-0.2.0.tgz download from your Polar purchase:", "  npm install -g ./cephalo-pro-0.2.0.tgz");
    return { lines, exitCode: 0 };
  }

  if (sub === "renew") {
    const rec = readLicense(licensePath(dir));
    if (!rec) return { lines: ["No license on this machine. Run: cephalo pro activate"], exitCode: 1 };
    if (isLegacyRecord(rec)) return { lines: [LEGACY_MESSAGE], exitCode: 1 };
    const key = await keyFrom(rest, d);
    if (!key) return { lines: NO_KEY, exitCode: 1 };
    const r = await validateLicense(rec, key, ops);
    if (!r.ok) return { lines: [`The license was not renewed: ${r.error}`], exitCode: 1 };
    writeLicense(r.record, licensePath(dir));
    return { lines: [`License is valid. Cephalo ${r.record.tier} stays on for another ${LICENSE_VALID_DAYS} days.`], exitCode: 0 };
  }

  if (sub === "deactivate") {
    const rec = readLicense(licensePath(dir));
    if (!rec) return { lines: ["No license on this machine."], exitCode: 0 };
    if (isLegacyRecord(rec)) {
      // A Lemon Squeezy activation cannot be released through Polar; only the local record can go.
      fs.rmSync(licensePath(dir), { force: true });
      return { lines: ["Removed this machine's old Lemon Squeezy license record. Cephalo no longer talks to Lemon Squeezy, so that seat was not released there.", "To use Pro again, run: cephalo pro activate (with a Polar key)"], exitCode: 0 };
    }
    const key = await keyFrom(rest, d);
    if (!key) return { lines: NO_KEY, exitCode: 1 };
    const r = await deactivateLicense(rec, key, ops);
    if (!r.ok) return { lines: [`The seat was not released: ${r.error}`, "Nothing was changed on this machine."], exitCode: 1 };
    fs.rmSync(licensePath(dir), { force: true });
    return { lines: ["This machine's seat is released and the license record is removed. The key can be used on another computer.", "The Pro package files were left alone."], exitCode: 0 };
  }

  return { lines: [PRO_USAGE.trimEnd()], exitCode: 1 };
}
