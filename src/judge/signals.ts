/**
 * Cheap, local checks that decide whether a command is worth a model's second look.
 * Most commands match none of these and never reach the model.
 */
const SIGNALS: Array<{ id: string; re: RegExp }> = [
  { id: "pipe-to-shell", re: /\|\s*(sudo\s+)?((ba|z|da|k|c)?sh|pwsh|powershell|iex|Invoke-Expression|python3?|node|perl|ruby)\b/i },
  { id: "network", re: /\b(curl|wget|nc|ncat|netcat|socat|scp|sftp|ftp|rsync|telnet|ssh|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|bitsadmin)\b/i },
  { id: "encoded", re: /\bbase64\s+(-d|--decode)\b|\bFromBase64String\b|(^|\s)-(EncodedCommand|enc|ec)\b|\beval\b|\bxxd\s+-r\b|\bopenssl\s+enc\b/i },
  { id: "persistence", re: /\b(crontab|schtasks|systemctl\s+(enable|edit)|launchctl\s+load|reg(\.exe)?\s+add|New-ScheduledTask|Register-ScheduledTask|at\s+\d)\b|authorized_keys|\.bashrc|\.zshrc|\.profile\b|\$PROFILE|CurrentVersion[\\/]Run|Start Menu[\\/]Programs[\\/]Startup/i },
  { id: "privilege", re: /\b(sudo|su\s+-|runas|chmod\s+(-R\s+)?[0-7]?[0-7][0-7]7|chmod\s+[ugoa]*\+s|chown\s+-R|setcap|icacls\s+.*\/grant|Set-ExecutionPolicy)\b|\bdocker\s+run\b[^\n]*(--privileged|\s-v\s+\/:|--pid=host|--cap-add[= ]SYS_ADMIN)/i },
  { id: "publish", re: /\b(git\s+push|npm\s+publish|yarn\s+publish|twine\s+upload|cargo\s+publish|docker\s+push|gh\s+release|gh\s+repo\s+(delete|edit)|gh\s+secret)\b/i },
  { id: "remote-install", re: /\b(pip3?|npm|pnpm|yarn|gem|cargo|go)\s+(install|i|add|get)\b[^\n]*(https?:\/\/|git\+|github:|@[\w-]+\/[\w-]+#)/i },
  { id: "credentials", re: /(\.ssh[\\/]|id_(rsa|ed25519|ecdsa)|\.aws[\\/]|\.npmrc|\.netrc|\.git-credentials|\.kube[\\/]config|\bprintenv\b|\bGet-ChildItem\s+env:|\benv\s*(\||$)|\b(echo|printf)\b[^\n]*\$\{?\w*(TOKEN|SECRET|KEY|PASSWORD|PASSWD)\w*)/i },
  { id: "disk-destructive", re: /\b(mkfs(\.\w+)?|shred|wipefs|format\s+[a-z]:|diskpart|git\s+clean\s+-\w*[fdx]|git\s+branch\s+-D|git\s+checkout\s+--\s+\.|git\s+restore\s+\.|docker\s+(system|volume)\s+prune)\b|>\s*\/dev\/(sd|nvme|disk)|\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd|mmcblk)/i },
  { id: "exec-remote", re: /\b(exec|eval)\s*\([^\n]*(urlopen|urllib|requests\.get|fetch\(|https?:\/\/)|\b(python3?|node|perl|ruby)\s+-[ce]\b[^\n]*(urlopen|https?:\/\/|socket|child_process)/i },
  { id: "registry-change", re: /\b(npm|pnpm|yarn)\s+config\s+set\s+registry|\bpip3?\s+config\s+set\s+global\.(index-url|extra-index-url)|--(extra-)?index-url\s+http|--registry[= ]\s*http:/i },
];

export const SIGNAL_IDS = SIGNALS.map((s) => s.id);

/** Names of the risk signals found in a command (empty = not worth a model call). */
export function findSignals(command: string): string[] {
  return SIGNALS.filter((s) => s.re.test(command)).map((s) => s.id);
}
