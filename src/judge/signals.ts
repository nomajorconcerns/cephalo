/**
 * Cheap, local checks that decide whether a command is worth a model's second look.
 * Most commands match none of these and never reach the model.
 */
const SIGNALS: Array<{ id: string; re: RegExp }> = [
  { id: "pipe-to-shell", re: /\|\s*(sudo\s+)?((ba|z|da|k|c)?sh|pwsh|powershell|iex|Invoke-Expression|python3?|node|perl|ruby)\b/i },
  { id: "network", re: /\b(curl|wget|nc|ncat|netcat|socat|scp|sftp|ftp|rsync|telnet|ssh|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|bitsadmin)\b/i },
  { id: "encoded", re: /\b(base64\s+(-d|--decode)|FromBase64String|-EncodedCommand|-enc\b|eval\b|xxd\s+-r|openssl\s+enc)/i },
  { id: "persistence", re: /\b(crontab|schtasks|systemctl\s+(enable|edit)|launchctl\s+load|reg(\.exe)?\s+add|New-ScheduledTask|Register-ScheduledTask|at\s+\d)\b|authorized_keys|\.bashrc|\.zshrc|\.profile\b|\$PROFILE|CurrentVersion[\\/]Run|Start Menu[\\/]Programs[\\/]Startup/i },
  { id: "privilege", re: /\b(sudo|su\s+-|runas|chmod\s+(-R\s+)?[0-7]?[0-7][0-7]7|chmod\s+[ugoa]*\+s|chown\s+-R|setcap|icacls\s+.*\/grant|Set-ExecutionPolicy)\b/i },
  { id: "publish", re: /\b(git\s+push|npm\s+publish|yarn\s+publish|twine\s+upload|cargo\s+publish|docker\s+push|gh\s+release|gh\s+repo\s+(delete|edit)|gh\s+secret)\b/i },
  { id: "remote-install", re: /\b(pip3?|npm|pnpm|yarn|gem|cargo|go)\s+(install|i|add|get)\b[^\n]*(https?:\/\/|git\+|github:|@[\w-]+\/[\w-]+#)/i },
  { id: "credentials", re: /(\.ssh[\\/]|id_(rsa|ed25519|ecdsa)|\.aws[\\/]|\.npmrc|\.netrc|\.git-credentials|\.kube[\\/]config|\bprintenv\b|\bGet-ChildItem\s+env:|\benv\s*(\||$)|\b(echo|printf)\b[^\n]*\$\{?\w*(TOKEN|SECRET|KEY|PASSWORD|PASSWD)\w*)/i },
  { id: "disk-destructive", re: /\b(dd\s+if=|mkfs(\.\w+)?|shred|wipefs|format\s+[a-z]:|diskpart|git\s+clean\s+-\w*[fdx]|git\s+branch\s+-D|git\s+checkout\s+--\s+\.|git\s+restore\s+\.|docker\s+(system|volume)\s+prune)\b|>\s*\/dev\/(sd|nvme|disk)/i },
];

export const SIGNAL_IDS = SIGNALS.map((s) => s.id);

/** Names of the risk signals found in a command (empty = not worth a model call). */
export function findSignals(command: string): string[] {
  return SIGNALS.filter((s) => s.re.test(command)).map((s) => s.id);
}
