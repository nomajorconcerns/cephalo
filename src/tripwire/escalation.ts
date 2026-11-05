import type { Rule } from "../rules.js";

/**
 * Extra rules that apply ONLY to a session in which the tripwire fired (something the agent read looked like a prompt
 * injection). They cover what an injected instruction needs in order to do harm: send data out, reach for credentials,
 * plant something that survives the session, or use an MCP tool that writes to the outside world.
 * Everything else the agent does still works, so a false alarm costs little.
 */
const cmd = (id: string, description: string, pattern: string): Rule => ({ id, description, type: "command", pattern, action: "block" });
const path_ = (id: string, description: string, on: "read" | "write" | "any", pattern: string): Rule => ({ id, description, type: "path", on, pattern, action: "block" });

export const ESCALATION_RULES: Rule[] = [
  cmd(
    "trip-egress",
    "Sending data out of this machine (network commands, git push, publishing)",
    "\\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer|bitsadmin|nc|ncat|netcat|telnet|scp|sftp|ftp|rsync)(\\.exe)?\\b|(?<![\\w.\\\\/-])ssh(\\.exe)?\\b(?![\\\\/])|\\bcertutil\\b[^\\n]*-urlcache|\\bgit\\s+(push|remote\\s+add|remote\\s+set-url)\\b|\\b(npm|pnpm|yarn)\\s+publish\\b|\\btwine\\s+upload\\b|\\bgh\\s+(gist|release|pr|issue)\\s+(create|edit|comment)\\b|\\b(requests|httpx|urllib|aiohttp|socket|smtplib|ftplib)\\b|\\bfetch\\s*\\(|\\bXMLHttpRequest\\b|\\bnet\\.(connect|createConnection)\\b|\\bhttps?\\.(request|get)\\b|\\bsendmail\\b",
  ),
  cmd(
    "trip-secrets",
    "Reading credentials or dumping the environment",
    "(\\.ssh[\\\\/]|\\.aws[\\\\/]|\\.gnupg|\\.npmrc|\\.pypirc|\\.netrc|\\.git-credentials|\\bid_(rsa|ed25519|ecdsa)\\b|\\.kube[\\\\/]config|\\.docker[\\\\/]config\\.json|[\\\\/]gh[\\\\/]hosts\\.yml|login data|\\bcookies\\b)|^\\s*(printenv|env|set)\\s*($|[|>;&])|\\b(get-childitem|gci|dir|ls)\\s+env:|\\$env:\\w*(key|token|secret|pass)\\w*|\\bos\\.environ\\b|process\\.env\\b(?!\\.\\w+\\s*(===|!==|==|!=))",
  ),
  path_(
    "trip-secret-files",
    "Reading credential files",
    "any",
    "([\\\\/]\\.ssh[\\\\/]|[\\\\/]\\.aws[\\\\/]|[\\\\/]\\.gnupg[\\\\/]|[\\\\/]\\.(npmrc|pypirc|netrc|git-credentials)$|[\\\\/]id_(rsa|ed25519|ecdsa)(\\.pub)?$|[\\\\/]\\.kube[\\\\/]config$|[\\\\/]\\.docker[\\\\/]config\\.json$|[\\\\/]gh[\\\\/]hosts\\.yml$|[\\\\/]login data$|[\\\\/]cookies$)",
  ),
  cmd(
    "trip-replay-post",
    "Publishing a replay to a pull request",
    "(\\bcephalo(\\.cmd|\\.ps1)?|cli\\.js[\"']?)\\s+replay\\b[^\\n]*--comment",
  ),
  cmd(
    "trip-vault",
    "Using the secrets vault (a hijacked agent could point a stored token at an attacker)",
    "(\\bcephalo(\\.cmd|\\.ps1)?|cli\\.js[\"']?)\\s+(run|vault)\\b",
  ),
  cmd(
    "trip-persist",
    "Planting something that outlives the session (scheduled tasks, startup entries, git hooks, shell profiles)",
    "\\bcrontab\\b|\\bschtasks(\\.exe)?\\s+/create\\b|\\bRegister-ScheduledTask\\b|\\blaunchctl\\s+(load|bootstrap|enable)\\b|\\bsystemctl\\s+(--user\\s+)?enable\\b|\\breg(\\.exe)?\\s+add\\b[^\\n]*\\\\Run\\b|\\bNew-Service\\b|\\bsc(\\.exe)?\\s+create\\b|\\bgit\\s+config\\b[^\\n]*(hooksPath|fsmonitor)|\\b(npm|pnpm|yarn)\\s+(config\\s+set|set)\\s+registry\\b|\\bpip3?\\s+config\\s+set\\b|>>?\\s*[^\\n]*(\\.bashrc|\\.zshrc|\\.profile|\\.bash_profile|profile\\.ps1|authorized_keys)",
  ),
  path_(
    "trip-persist-files",
    "Writing shell profiles, startup locations, git hooks or agent config",
    "write",
    "([\\\\/]\\.(bashrc|zshrc|profile|bash_profile|zprofile)$|[\\\\/]profile\\.ps1$|[\\\\/]Startup[\\\\/]|[\\\\/]LaunchAgents[\\\\/]|[\\\\/]\\.config[\\\\/]autostart[\\\\/]|[\\\\/]\\.ssh[\\\\/]|[\\\\/]\\.git[\\\\/]hooks[\\\\/]|[\\\\/]\\.claude[\\\\/]|[\\\\/]hermes[\\\\/](config\\.yaml|hooks|skills|plugins)|[\\\\/]\\.cephalo[\\\\/])",
  ),
];

const MCP_WRITE_WORDS =
  /(^|[^a-z])(send|post|publish|upload|email|mail|message|notify|create|update|edit|delete|remove|write|push|commit|merge|deploy|execute|exec|run|shell|transfer|pay|share|invite|comment|reply|tweet|webhook|put|patch|set|add|insert|drop|move|rename)([^a-z]|$)/i;

/** The agent's own web tools (Claude WebFetch/WebSearch, Hermes web_search/web_extract). A URL or a search query can carry data out, so a locked session loses them. */
export const WEB_TOOLS = /^(WebFetch|WebSearch|web_search|web_extract)$/;
export const TRIP_WEB_RULE: Rule = {
  id: "trip-web",
  description: "Fetching a page or searching the web (a URL or query can carry data out of this machine)",
  type: "command",
  pattern: "",
  action: "block",
};

/** MCP tool names that look like they change something outside the machine. A name heuristic: it errs toward blocking. */
export function mcpToolLooksMutating(toolName: string): boolean {
  // `mcp__server__tool` is unambiguous: judge the tool part only (a server called "mail" must not make every tool a sender).
  let bare = toolName;
  if (toolName.startsWith("mcp__")) {
    const rest = toolName.slice(5);
    const i = rest.indexOf("__");
    bare = i > 0 ? rest.slice(i + 2) : rest;
  } else bare = toolName.replace(/^mcp_/i, "");
  bare = bare.replace(/([a-z])([A-Z])/g, "$1_$2");
  return MCP_WRITE_WORDS.test(bare);
}
