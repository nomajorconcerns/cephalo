import { CONFIG_KEYS, configPath, parseConfigValue, readConfig, setConfigValue } from "./config.js";

export const CONFIG_USAGE = `Usage: cephalo config [list | get <key> | set <key> <value> | path]

Settings live in ${"~/.cephalo/config.yml"} (created when you first set something). Agents cannot change this file.

${CONFIG_KEYS.map((k) => `  ${k.name.padEnd(13)} ${k.description}`).join("\n")}

Examples:
  cephalo config set fail-closed on
  cephalo config set shadow on
  cephalo config set ask-default allow
`;

/** `cephalo config ...` as lines to print and an exit code. */
export function configCommand(args: string[], file: string = configPath()): { lines: string[]; exitCode: number } {
  const sub = args[0] ?? "list";
  const find = (name: string | undefined) => CONFIG_KEYS.find((k) => k.name === name || k.yaml === name);
  const state = readConfig(file);
  const show = (k: (typeof CONFIG_KEYS)[number]): string => {
    const v = k.yaml === "fail_closed" ? state.config.failClosed : k.yaml === "shadow" ? state.config.shadow : k.yaml === "ask_default" ? state.config.askDefault : k.yaml === "theme" ? (state.config.theme ?? "reef") : state.config.hookTimeoutSeconds;
    return typeof v === "boolean" ? (v ? "on" : "off") : String(v);
  };
  if (sub === "path") return { lines: [file], exitCode: 0 };
  if (sub === "list" || sub === "ls") {
    const lines = [state.exists ? `Settings file: ${file}` : `Settings file: ${file} (does not exist yet; the defaults below are in force)`, ""];
    for (const k of CONFIG_KEYS) lines.push(`${k.name.padEnd(13)} ${show(k).padEnd(6)} ${k.description}`);
    for (const p of state.problems) lines.push("", `Problem: ${p}`);
    return { lines, exitCode: state.problems.length ? 1 : 0 };
  }
  if (sub === "get") {
    const k = find(args[1]);
    if (!k) return { lines: [`Unknown setting "${args[1] ?? ""}". Settings: ${CONFIG_KEYS.map((x) => x.name).join(", ")}`], exitCode: 1 };
    return { lines: [show(k)], exitCode: 0 };
  }
  if (sub === "set") {
    const k = find(args[1]);
    if (!k) return { lines: [`Unknown setting "${args[1] ?? ""}". Settings: ${CONFIG_KEYS.map((x) => x.name).join(", ")}`], exitCode: 1 };
    if (args[2] === undefined) return { lines: [`Usage: cephalo config set ${k.name} <value>`], exitCode: 1 };
    const v = parseConfigValue(k, args[2]);
    if (!v.ok) return { lines: [v.error], exitCode: 1 };
    try {
      const { backup } = setConfigValue(k.yaml, v.value, file);
      const lines = [`Set ${k.name} = ${typeof v.value === "boolean" ? (v.value ? "on" : "off") : v.value} in ${file}`];
      if (backup) lines.push(`Backup of the old file: ${backup}`);
      if (k.yaml === "fail_closed" && v.value === true) lines.push("Fail-closed is on: if the hook crashes, times out or gets input it cannot read, the call is blocked. If your agent stops working, run: cephalo config set fail-closed off");
      if (k.yaml === "shadow" && v.value === true) lines.push("Shadow mode is on: rules are logged as \"would block\" and nothing is blocked, except Cephalo's own protections.");
      return { lines, exitCode: 0 };
    } catch (e) {
      return { lines: [(e as Error).message], exitCode: 1 };
    }
  }
  return { lines: [CONFIG_USAGE.trimEnd()], exitCode: 1 };
}
