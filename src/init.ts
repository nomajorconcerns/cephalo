import fs from "node:fs";
import {
  claudeSettingsPath,
  hermesConfigPath,
  installClaude,
  installHermes,
  projectRoot,
} from "./install.js";
import { defaultRulesPath, ensureRulesFile } from "./rules.js";
import { claudeStatus, hermesStatus, type HookStatus } from "./status.js";

export interface InitOptions {
  /** Apply without asking. */
  yes: boolean;
  /** True when a person can answer a prompt (stdin is a TTY). */
  interactive: boolean;
  /** Ask the user to confirm; only called when !yes && interactive. */
  confirm: () => Promise<boolean>;
  log: (line: string) => void;
  rulesFile?: string;
  claudeFile?: string;
  hermesFile?: string;
  abs?: string;
}

type Action = { label: string; run: () => string[] };

function describe(name: string, file: string, st: HookStatus): { text: string; action: boolean } {
  if (st.error) return { text: `${name}: cannot read ${file} (${st.error}). Will skip it.`, action: false };
  if (st.current) return { text: `${name}: hook already installed and up to date.`, action: false };
  if (st.installed) return { text: `${name}: hook installed but outdated. Will update it (backup first).`, action: true };
  if (!st.fileExists) return { text: `${name}: ${file} not found.`, action: false };
  return { text: `${name}: will add the hook to ${file} (backup first).`, action: true };
}

/** Returns the process exit code. */
export async function runInit(o: InitOptions): Promise<number> {
  const abs = o.abs ?? projectRoot();
  const rulesFile = o.rulesFile ?? defaultRulesPath();
  const claudeFile = o.claudeFile ?? claudeSettingsPath();
  const hermesFile = o.hermesFile ?? hermesConfigPath();
  const actions: Action[] = [];
  let failed = false;

  o.log("Plan:");
  if (fs.existsSync(rulesFile)) {
    o.log(`  Rules: ${rulesFile} exists, leaving it as is.`);
  } else {
    o.log(`  Rules: will create ${rulesFile} from the built-in defaults.`);
    actions.push({ label: "rules", run: () => (ensureRulesFile(rulesFile), [`Created ${rulesFile}`]) });
  }

  const cs = claudeStatus(claudeFile, abs);
  if (cs.error) failed = true;
  if (!cs.fileExists && !cs.error) {
    o.log(`  Claude Code: ${claudeFile} not found. Will create it with the hook.`);
    actions.push({ label: "claude", run: () => installClaude(claudeFile, abs) });
  } else {
    const d = describe("Claude Code", claudeFile, cs);
    o.log(`  ${d.text}`);
    if (d.action) actions.push({ label: "claude", run: () => installClaude(claudeFile, abs) });
  }

  const hs = hermesStatus(hermesFile, abs);
  if (hs.error) failed = true;
  if (!hs.fileExists) {
    o.log(`  Hermes: ${hermesFile} not found. Skipping (Hermes does not appear to be installed).`);
  } else {
    const d = describe("Hermes", hermesFile, hs);
    o.log(`  ${d.text}`);
    if (d.action) actions.push({ label: "hermes", run: () => installHermes(hermesFile, abs) });
  }

  if (actions.length > 0) {
    if (!o.yes) {
      if (!o.interactive) {
        o.log("");
        o.log("Not running in a terminal. Nothing was changed. Re-run with: cephalo init --yes");
        return 1;
      }
      if (!(await o.confirm())) {
        o.log("No changes made.");
        return 0;
      }
    }
    o.log("");
    for (const a of actions) {
      try {
        for (const line of a.run()) o.log(`  ${line}`);
      } catch (e) {
        failed = true;
        o.log(`  ${a.label}: FAILED: ${(e as Error).message}`);
      }
    }
  } else {
    o.log("");
    o.log("Nothing to change.");
  }

  o.log("");
  o.log("Next steps:");
  o.log("  1. Restart Claude Code (it reads hooks at startup).");
  if (hs.fileExists) {
    o.log("  2. Hermes asks you to approve a new hook the first time. Start an interactive `hermes`,");
    o.log("     accept the prompt, then check: hermes hooks list (should not say 'not allowlisted').");
  }
  o.log('  3. Try it: cephalo test "DROP TABLE users"   then   cephalo log');
  return failed ? 1 : 0;
}
