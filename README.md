# Cephalo

The seatbelt for AI coding agents. Cephalo is a Node.js + TypeScript command-line tool that sits in
front of **Claude Code** and **Hermes Agent** and blocks dangerous tool calls (`DROP TABLE`,
`rm -rf`, `git push --force`, reading `.env`, an MCP tool that quietly changed its description, ...)
before they run.

It works through each agent's hook: the agent hands Cephalo the tool call as JSON, Cephalo checks it
against your rules and answers allow or block. Everything runs on your machine. There is no server,
no account and no telemetry.

> **Status.** Version 0.2.0. It has been exercised on Windows only. The macOS and
> Linux adapters are covered by unit tests only. The newer features (MCP firewall, tripwire, vault,
> replay, incident-to-rule) were tested with simulated hook payloads and real child processes, not yet
> in a long live agent session. See [Safety model and limits](#safety-model-and-limits).

## Contents

- [Install](#install) · [Quick start](#quick-start) · [Commands](#commands)
- [Rules](#rules) · [Allow, ask and shadow](#allow-ask-and-shadow) · [Command parsing](#command-parsing) · [What each hook covers](#what-each-hook-covers)
- [Settings](#settings) · [Self-integrity check](#self-integrity-check) · [Themes and the loading animation](#themes-and-the-loading-animation)
- [MCP firewall](#mcp-firewall) · [Prompt-injection tripwire](#prompt-injection-tripwire)
- [Local-model judge](#local-model-judge) · [Secrets vault](#secrets-vault) · [Incident to rule](#incident-to-rule) · [PR replay](#pr-replay)
- [Audit log](#audit-log) · [Pro and Team](#pro-and-team) · [Files Cephalo keeps](#files-cephalo-keeps)
- [Safety model and limits](#safety-model-and-limits) · [Troubleshooting](#troubleshooting)
- [Development](#development) · [Releases and verification](#releases-and-verification) · [Licence](#licence)

## Install

```
npm install -g @nomajorconcerns/cephalo
```

That puts the `cephalo` command on your PATH. Node.js 20 or newer is required by `package.json`; the
code has only been run on Node 24, and the `npm test` script's glob needs Node 21+.

To work on Cephalo itself, or to run it from a clone, install from source instead:

```powershell
git clone https://github.com/nomajorconcerns/cephalo.git   # or use your existing folder
cd cephalo
npm install
npm run build
npm link          # makes `cephalo` available in any terminal
```

## Quick start

```powershell
cephalo init      # shows a plan, asks to confirm, then sets everything up
cephalo doctor    # checks that it is all wired up
```

`cephalo init` creates `~/.cephalo/rules.yml` from the defaults and adds Cephalo's hooks to Claude
Code (`~/.claude/settings.json`) and, if found, Hermes (`%LOCALAPPDATA%\hermes\config.yaml` on Windows,
`~/.hermes/config.yaml` elsewhere). Every edit is backed up first, to `<file>.cephalo-backup-<timestamp>`.

Then:

1. **Restart Claude Code.** It reads hooks at startup.
2. **Approve the hook in Hermes.** Hermes skips a hook command until you approve it once. Start an
   interactive `hermes`, accept the prompt, then check `hermes hooks list`: it must not say
   `not allowlisted`. `cephalo doctor` reports this too.
3. Try it: `cephalo test "DROP TABLE users"` then `cephalo log`.

**Upgrading from an older version?** Run `cephalo install claude` and `cephalo install hermes` again.
They upgrade the matchers in place (MCP tools, and the after-call hook used by the tripwire and vault)
and keep a backup. `cephalo doctor` warns when the installed hooks are out of date.

## Commands

| Command | What it does |
|---|---|
| `cephalo test "<command>"` | Check a shell command: prints `BLOCKED (rule-id: description)` or `ALLOWED` |
| `cephalo init [--yes]` | Create rules, install hooks for the agents found. Asks first unless `--yes` |
| `cephalo doctor` | Check rules, a self-test, install integrity, settings, vault, tripwire, MCP firewall, audit log, both hooks, Hermes approval. Exit 1 on failures |
| `cephalo rules [list]` / `show <id>` / `path` / `reset [--yes]` | Inspect rules and where each came from; `reset` backs up `rules.yml` then rewrites it from the defaults |
| `cephalo log [--blocked\|--shadow] [--limit N]` | Recent audit entries, newest last (default 20). `--shadow`: only what shadow-mode rules would have blocked |
| `cephalo watch [--blocked] [--last N] [--no-color]` | Follow the audit log live, in your color scheme. Ctrl+C stops |
| `cephalo install` / `uninstall claude\|hermes` | Add or remove Cephalo's hooks (idempotent; backs up first; uninstall removes only Cephalo's entries) |
| `cephalo config [list\|get\|set\|path]` | Settings: fail-closed, shadow, ask-default, hook-timeout, theme. See [Settings](#settings) |
| `cephalo theme [list\|preview\|set\|reset]` | Color scheme of the CLI. See [Themes](#themes-and-the-loading-animation) |
| `cephalo pro [status\|activate\|renew\|install\|deactivate]` | License for the paid plans and the Pro package. See [Pro and Team](#pro-and-team) |
| `cephalo egress ...`, `cephalo audit verify\|head`, `cephalo bench` | **Pro and Team.** Network egress allowlist, tamper-evident audit log, bypass benchmark |
| `cephalo mcp ...` | MCP firewall: allowlist, fingerprints, scan, proxy. See [MCP firewall](#mcp-firewall) |
| `cephalo tripwire ...` | Prompt-injection tripwire. See [below](#prompt-injection-tripwire) |
| `cephalo models ...` | Local-model judge (Ollama). See [below](#local-model-judge) |
| `cephalo vault ...`, `cephalo run ...` | Secrets vault. See [below](#secrets-vault) |
| `cephalo incident ...` | Turn an incident into a rule. See [below](#incident-to-rule) |
| `cephalo replay ...` | Replay of what the agents did. See [below](#pr-replay) |
| `cephalo hook claude\|hermes\|codex\|cursor` | The entry point the agents call. Not for humans. `codex` and `cursor` are adapters you wire up by hand (see below); `cephalo init` does not touch them |

## Rules

Rules live in `~/.cephalo/rules.yml`. If the file is missing it is created from the built-in defaults.
Changing the defaults in a new Cephalo version does **not** update an existing file: run
`cephalo rules reset` to get them.

```yaml
rules:
  - id: no-drop
    description: Dropping tables or databases
    type: command        # command | path
    on: any              # path rules only: read | write | any
    pattern: '\bDROP\s+(TABLE|DATABASE|SCHEMA)\b'
    action: block        # block (default) | allow | ask
    shadow: false        # true: log what this rule would do, but do not do it
```

- Patterns are **case-insensitive JavaScript regular expressions**.
- `command` rules are tested against shell commands (and, for Hermes `execute_code`, the script text).
- `path` rules are tested against file paths for reads and/or writes.
- The first matching rule decides. `action` is `block` (the default), `allow` or `ask`; see [Allow, ask and shadow](#allow-ask-and-shadow).

Default rules (in your file): `no-drop`, `no-truncate`, `no-delete-all` (DELETE without WHERE), `no-rm-rf`,
`no-win-recursive-delete`, `no-force-push` (allows `--force-with-lease`), `no-hard-reset`,
`no-secret-read`, `no-secret-file` (`.env`, but not `.env.example`) and `protect-config` (writes to
Claude's `settings.json` and Hermes's `config.yaml`).

### Built-in rules (applied at runtime, not stored in `rules.yml`)

Cephalo has an adapter for Windows, macOS and Linux (other POSIX systems use the Linux one). It decides
where the agent configs live, how paths and commands are cleaned before matching, and which extra
built-in rules apply. Rules are matched against the raw text **and** a cleaned copy (for example `r''m`,
`\rm`, `r^d /s`, ``Remove`-Item``, `~/x/../.env`, `%USERPROFILE%\.env`).

`cephalo rules` lists built-in rules with origin `platform`. To change or disable one, add a rule with the
**same id** to `rules.yml` (yours wins).

| Group | Rule ids |
|---|---|
| Every OS ("system") | `protect-cephalo-policy`, `protect-audit-log`, `no-audit-tamper`, `protect-vault-files`, `protect-policy-key`, `no-vault-extract`, `secret-in-command`, `no-self-approve`, `no-self-incident`, `no-secret-shell`, `no-agent-config-tamper`, `no-protected-symlink`, `protect-cephalo-install`, `no-install-tamper`, `no-protected-write-code` |
| Windows | `win-format-drive`, `win-disk-wipe`, `win-registry-delete`, `win-shadow-delete`, `win-power` |
| macOS | `mac-diskutil-erase`, `mac-disable-protection`, `mac-tmutil-delete`, `mac-keychain-secrets` + POSIX |
| Linux | `linux-mkfs`, `linux-dd-device`, `linux-write-device`, `linux-shred-device`, `linux-fork-bomb` + POSIX |
| POSIX (macOS + Linux) | `rm-long-flags`, `no-preserve-root`, `pipe-to-shell`, `find-delete`, `find-exec-rm`, `chmod-chown-system`. Windows also gets `rm-long-flags`, `no-preserve-root`, `find-delete` and `find-exec-rm`, because agents there often run Git Bash or WSL |

The system rules protect Cephalo itself: they stop an agent from writing the audit log or rules file,
the MCP and tripwire state, the vault files; from running `cephalo vault reveal`; from pasting a literal
API token into a command; from reading `.env` files through a shell or inline code; from writing the Claude Code
or Hermes config or Cephalo's own installed files from a shell; and from approving MCP servers, releasing the
tripwire, changing Cephalo's settings or rules, or adding learned rules on its own. An `allow` rule cannot lift any
of these.

## Allow, ask and shadow

A rule's `action` is one of:

- `block` (default): stop the call.
- `allow`: an exception. The first matching rule still wins, so put an `allow` before the `block` it should lift. It is judged on each part of a compound command on its own, so `git status; rm -rf /` is still blocked, and it is ignored for a command Cephalo could not read cleanly. It cannot lift Cephalo's own built-in protections.
- `ask`: the user approves or denies. Claude Code shows an approval prompt. Codex, Cursor and Hermes cannot show one, so for them the call follows the `ask-default` setting (`block` unless you set `allow`), and the audit log says which happened.

`shadow: true` on a rule, or `cephalo config set shadow on` for every rule, logs what the rule would have done and does nothing. These appear in `cephalo log` and `cephalo watch` as `{would block: rule-id}`, and `cephalo log --shadow` lists them. The built-in protections stay on in global shadow mode. Use it to try a rule on real traffic before you trust it.

`allow`, `ask` and `shadow` need 0.2.0. Version 0.1.x treats every rule as a block, so do not copy such a rule into an older install.

## Command parsing

Before the rules run, Cephalo reads a command the way a shell would and checks each part as well as the raw text: pipelines, `&&`, `||`, `;`, subshells, `$(...)`, backticks, `<(...)`, heredocs, wrappers (`sudo`, `env`, `timeout`), `bash -c`, `sh -c`, `eval`, `ssh host "..."`, `find -exec`, base64 payloads, inline code (`python -c`, `node -e`, `perl -e`, `ruby -e`), and on Windows `powershell -Command`, `-EncodedCommand`, `iex` and `cmd /c`. The raw text is always checked too, so parsing can only add blocks. If a command cannot be read cleanly (an unbalanced quote, a construct the parser does not handle) Cephalo falls back to plain text matching. The parser is written for Cephalo and has no dependencies. It is not a shell: it does not run anything, and it cannot see inside a script file or a command built at run time.

## Settings

`~/.cephalo/config.yml`, changed with `cephalo config list|get|set|path` (a backup is made first). Agents cannot write it.

| Setting | Default | Meaning |
|---|---|---|
| `fail-closed` | off | If the hook crashes, times out or gets unreadable input, **block** the call instead of allowing it. Trade-off: a broken hook then stops your agent's tool calls until you turn this off. |
| `hook-timeout` | 8 | Seconds the hook may take before fail-closed mode blocks the call (1 to 60). |
| `shadow` | off | Shadow mode for every rule (see above). |
| `ask-default` | block | What an `ask` rule does where the agent cannot show a prompt: `block` or `allow`. |
| `theme` | reef | Color scheme of the CLI output. |

## Self-integrity check

`npm run build` writes `dist/integrity.json`, a SHA-256 for each installed file. On the first hook call of a session, and in `cephalo doctor`, Cephalo checks that its hook entry is still in the agent's config, that the entry points at this install, and that the files match. A failure warns loudly: Claude Code shows it once per session; Hermes has no warning field, so there it is logged and shown by `doctor`. With fail-closed on, a failed check blocks calls. It detects; it cannot prevent. Someone who can edit `dist/` as you can edit the hash list too.

## Themes and the loading animation

Every color the CLI prints comes from a theme, in `src/theme.ts`. Five ship, each with a dark-terminal and a light-terminal palette:

| Theme | Look |
|---|---|
| `reef` (default) | Teal to violet, with the pink octopus |
| `abyss` | Deep navy and slate blue |
| `coral` | Warm pink, orange and cream |
| `glow` | Bioluminescent cyan and green on black |
| `ink` | No color: bold, underline and reverse video carry the meaning |

`cephalo theme list` shows each with a small preview, `cephalo theme preview [name]` shows the logo and sample output, `cephalo theme set <name>` saves it, and `CEPHALO_THEME=glow cephalo log` is for one run. ALLOW, BLOCK and ASK are always words, so meaning never depends on color alone. Color falls back from 24-bit to 256 to 16 to none, and follows `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb` and piped output. If Cephalo guesses a light or dark background wrong, set `CEPHALO_BACKGROUND=light` or `dark`.

While `init --yes`, `doctor`, `mcp scan`, `models scan`, `models eval`, `replay` or `cost` work, the pixel octopus waves its tentacles beside a status message (about ten frames a second, in your theme's colors) and clears itself before results print. There is no animation, only a plain `Working...` line on stderr, when output is not a terminal or `NO_COLOR`, `CI`, `CEPHALO_NO_ANIMATION=1` or `REDUCE_MOTION=1` is set. The frames advance only while the command waits on something asynchronous; `doctor` and `replay` do synchronous work and hold the first frame. `cephalo hook ...` never prints color, banners or animation.

## What each hook covers

| Agent | Before the call (can block) | After the call (reads the result) |
|---|---|---|
| Claude Code | `Bash` (command), `Read` (path, read), `Grep`/`Glob` (path and file filters, read; they cannot be aimed at `.env` files), `WebFetch`/`WebSearch` (logged; the egress allowlist and a tripwire lock look at them), `Write`/`Edit`/`MultiEdit` (path, write), `NotebookEdit` (path, write), `mcp__*` (server, tool, parameters) | `Bash`, `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `mcp__*` |
| Hermes | `terminal` (command), `execute_code` (script text, a heuristic), `read_file`/`search_files` (path and file filters, read), `web_search`/`web_extract` (logged), `write_file`/`patch` (path, write), `mcp_*` | `terminal`, `read_file`, `search_files`, `execute_code`, `web_search`, `web_extract`, `browser_*`, `mcp_*` |

Relative paths are resolved against the session's working directory, and symlinks are resolved, before path rules run.
Other tools are allowed and logged. The after-call hook feeds the [tripwire](#prompt-injection-tripwire)
and the [vault](#secrets-vault)'s leak detection. **In Hermes the after-call hook can only observe**, so
the tripwire's block starts with the next call; Claude Code can also be given a warning in the same turn.

When a call is blocked the agent sees:

> 🛑 Cephalo blocked this (rule: no-drop - Dropping tables or databases). If it is intended, ask the user to run it themselves.

## MCP firewall

Agents can call tools from MCP servers. A server is identified by **what it runs or where it lives**
(its command line or URL), never by the name in a config file, because a name is just a label an attacker
can reuse. Cephalo reads the servers configured for Claude Code (local, project and user scope) and Hermes.

```powershell
cephalo mcp                                   # list configured servers and their status
cephalo mcp allow notes                       # allowlist a configured server (asks first)
cephalo mcp allow --command "node C:/tools/notes.js" --yes
cephalo mcp allow --url https://mcp.example.com/sse
cephalo mcp mode enforce                      # audit (default): log only. enforce: block unlisted servers
cephalo mcp pin notes                         # approve the exact set of tools it offers now
cephalo mcp scan [name] [--json]              # compare tools now with the approved ones
cephalo mcp approve notes                     # after reviewing a change, approve the new set
cephalo mcp proxy [--name x] -- <command...>  # run a local server behind Cephalo's runtime proxy
cephalo mcp wrap notes                        # print (never apply) the config that puts a server behind the proxy
```

- **Audit mode** (default) logs every MCP call. **Enforce mode** blocks calls to servers that are not on
  the allowlist or whose identity cannot be verified.
- **Fingerprinting (rug-pull check).** `pin` stores a fingerprint of each tool's name, description and
  schema. If a description changes or a tool appears after approval, the hook blocks it
  (`mcp-tool-changed`, `mcp-tool-unapproved`) until you review with `scan` and re-approve. `scan` exits
  `0` clean, `1` unreadable, `2` changed. Set `requirePin: true` in `mcp.yml` to also block tools of
  allowlisted servers that were never pinned.
- **Runtime proxy.** For local stdio servers, `proxy` hides changed or unapproved tools from the agent's
  `tools/list` and refuses to call them, and rechecks when the server announces a change.
- `scan` and `proxy` only ever start servers that are already on your allowlist.
- Policy lives in `~/.cephalo/mcp.yml` (Windows paths in YAML need single quotes), approvals in
  `~/.cephalo/mcp-tools.json`. Agents cannot write either file.

**Limits.** The proxy handles stdio servers only; remote (URL) servers are covered by the allowlist, `scan`
and the hook. A fingerprint shows the definition did not change, not that the server is honest.

## Prompt-injection tripwire

Text an agent reads (a web page, a file, an MCP result) can contain instructions aimed at the model.
The tripwire reads tool results after the call and looks for them: override phrases, requests to send
secrets out, "do not tell the user", hidden HTML comments, zero-width and Unicode tag characters, base64
payloads. One strong signal or two moderate ones raise an **alert**; weaker ones are only noted.

In an alerted session, Cephalo blocks the next actions that injection usually wants: sending data out
of the machine (`trip-egress`), reading credentials, persistence (cron, startup entries, shell profiles),
write-type MCP calls, `cephalo run`, the vault, and posting a replay. Normal work such as `git status` and
`npm test` continues.

```powershell
cephalo tripwire status          # current mode and any tripped sessions, with what triggered them
cephalo tripwire scan page.html  # check a file (or - for stdin); exit 2 alert, 1 watch, 0 clean
cephalo tripwire clear           # release tripped sessions after you reviewed them (records are moved, not deleted)
cephalo tripwire mode enforce|warn|off
```

`enforce` (default) blocks, `warn` only logs, `off` disables. `clear` and `mode` are user-only: an agent
cannot run them (`no-self-approve`).

**Limits.** This is a heuristic that limits the damage of a successful injection; it is not a guarantee.
It misses some attacks and flags some harmless text (for example a document about prompt injection).

## Local-model judge

An optional second opinion from a small model running in [Ollama](https://ollama.com) **on this machine**.
It is off by default. When on, a shell command that shows a risk signal (pipe to a shell, network tools,
encoded payloads, persistence, privilege, publishing or pushing, credential files, disk-destructive
commands) is shown to the `decider` model, which answers `allow`, `block` or `unsure`. Everyday
commands (`npm test`, `git status`) never reach a model.

Two kinds of model work here, and Cephalo finds out which a model is from Ollama (`/api/show`):

- **Decision models** (such as `d3:2b`) do not chat. They answer a yes/no question with a probability, through
  Ollama's `/v1/systemone` endpoint. At or above `decision_block` (0.9) that is `block`, at or below
  `decision_allow` (0.3) `allow`, in between `unsure`. This is the fast path: about 2.5 s on a CPU-only PC.
- **Chat models** (such as `qwen3.5:4b`) are asked for a JSON verdict, with thinking switched off.

```powershell
cephalo models status          # config, whether Ollama is reachable, which models are installed
cephalo models pull            # prints the `ollama pull` commands you still need (it downloads nothing)
cephalo models judge "<cmd>"   # try the judge on one command and see the verdict
cephalo models enable          # turn it on (mode warn)
cephalo models mode enforce    # let a confident "block" actually block
```

Settings are in `~/.cephalo/models.yml`; defaults:

| Role | Models (first, then fallbacks) |
|---|---|
| `decider` | `d3:2b`, `qwen3.5:4b` |
| `reviewer` | `d3:2b`, `qwen3.5:9b` (reads suspicious tool output; see the tripwire assist below) |
| `embedding` | `nomic-embed-text` (spots paraphrased injections in tool output) |

- **It can only tighten.** Rules decide first. The model is not asked about a call a rule already blocks, and
  its answer can never lift a block. In `warn` mode (the default) every verdict is only written to the audit
  log. In `enforce` mode:

  | The model said | Claude Code | Hermes |
  |---|---|---|
  | `block` | denied (rule `judge-decider`) | blocked |
  | `unsure` (`on_unsure: ask`) | Claude Code asks you to approve the command | allowed and logged (Hermes cannot ask) |
  | nothing usable (`on_failure: ask`): Ollama down, model missing, too slow, bad reply | Claude Code asks you (fail closed) | allowed and logged |
  | `allow` | runs | runs |

  Set `on_unsure: allow` or `on_failure: allow` to log instead of asking. Only commands that show a risk
  signal are ever put to a model, so with Ollama stopped an ordinary `npm test` is not affected.
- **Time budget.** One budget (`timeout_ms`, default 8000) covers all models tried. Models stay loaded for
  `keep_alive` (default 10m); a cold load can take 10+ seconds on a CPU, so the first risky command after an
  idle spell is asked about rather than judged.
- **Every ask is logged.** The audit entry has `decision: ask` and a structured `model` field (role, model,
  verdict, probability, milliseconds, cached, risk signals). If the command then runs, a
  `judge-ask-approved` entry records that you approved it; an ask that never ran shows up later as
  `judge-ask-unanswered`. `cephalo log`, `watch` and `replay` show `ASK`.
- **Startup check.** At most every 10 minutes the hook checks which configured models Ollama has. Missing
  models (`models-missing`) and an unreachable Ollama (`models-unreachable`) are logged, and `cephalo doctor`
  reports the last result.
- **It stays local.** Cephalo refuses any `host` that is not localhost, so commands are never sent elsewhere.
- **The command is data.** It is fenced in the prompt and the model is told not to follow it, and a
  model's `allow` changes nothing, so a command that talks the model into "allow" ends up exactly where it
  would be with no judge at all.
- Answers are cached for 24 hours in `~/.cephalo/judge-cache.json`. Agents cannot write `models.yml` or the cache.

### Tripwire assist

With the judge on (and `tripwire_assist: true`, the default), the [tripwire](#prompt-injection-tripwire)
gets help from the other two models on what tools return. It is the same after-call hook; the results are
recorded as ordinary tripwire events, so `cephalo tripwire status` and `cephalo tripwire clear` work as before.

| The regex scan found | What the models do | Result |
|---|---|---|
| an alert | nothing, it is already the top level | alert |
| a watch | the reviewer reads the flagged text | `injection` raises it to an alert; anything else changes nothing |
| nothing | the embedding model compares the output, piece by piece, with 28 known injection phrasings; a close match goes to the reviewer | `injection`: alert. `unsure` or no answer: watch (logged, nothing blocked). `benign`: nothing recorded |

- **They can only raise the level.** A `benign` verdict never lowers or removes a finding the regex scan made.
- **The reference phrasings** are embedded once and kept in `~/.cephalo/embed-cache.json`; after that only the
  tool output itself is embedded. The reviewer's budget is `reviewer_timeout_ms` (default 20000).
  The default reviewer is `d3:2b` with `qwen3.5:9b` as backup: on a CPU-only PC both judged a set of test texts
  correctly, but the 9B took 15-29 s per text and `d3:2b` about 2.6 s.
- `cephalo models scan <file|->` runs the whole pipeline on some text and shows each step (best similarity,
  matched phrasing, reviewer verdict). It records nothing. Use it to tune `similarity_threshold` (default 0.72).
- Cost: with the judge on, every non-empty tool output is embedded once. Only a match reaches the reviewer.

**Limits.** Small models are wrong sometimes, in both directions. Watch `cephalo log` in `warn` mode before
switching to `enforce`. The decider needs a command with a risk signal, so it does not look at file writes or MCP
calls. The similarity threshold (0.72) was set from a small hand-made sample with `nomic-embed-text`: injection
paraphrases scored 0.76-0.85, ordinary text 0.53-0.69. That is a narrow gap and a small sample, so expect to
adjust it with `cephalo models scan` on your own material. A page that merely quotes injection phrases (such as a
tutorial about prompt injection) is caught by the regex scan as an alert, and the models never lower that.
The judge was run against real models (`d3:2b`, `qwen3.5:4b`, `qwen3.5:9b`, `nomic-embed-text`) on one
CPU-only Windows PC; other hardware will have different timings.

## Secrets vault

Lets an agent *use* a token without ever *seeing* it. You store the value once; the agent runs commands
through `cephalo run`, which injects the secret into that one process and scrubs it from the output.

```powershell
cephalo vault set GITHUB_TOKEN --allow "^gh\s"      # hidden prompt; or --stdin / --from-env VAR
cephalo vault allow GITHUB_TOKEN "^gh\s" "^git\s"   # limit which commands may use it
cephalo vault list                                  # names, dates, allowed commands: never values
cephalo vault remove GITHUB_TOKEN
cephalo run --env GITHUB_TOKEN -- gh pr list        # NAME in the environment under the same name
cephalo run --env TOKEN=GITHUB_TOKEN -- node deploy.js   # or under another variable name
cephalo run -- curl -H "Authorization: Bearer {{secret:GITHUB_TOKEN}}" https://api.github.com/user
```

- Values enter only through a hidden prompt, `--stdin` or `--from-env`, never as an argument.
- The vault file is AES-256-GCM encrypted. The master key is protected by the OS where possible: Windows
  DPAPI (tested), macOS Keychain, or Linux Secret Service. Otherwise (`--backend file`) it is a plain key
  file with mode 0600, which protects against other users but not against anything running as you;
  `cephalo vault status` and `doctor` say which backend is in use.
- Output is scrubbed for the value and its base64, URL-encoded and JSON-escaped forms, including when it
  is split across chunks. A command the secret is not allowed for exits `126` without running.
- If a token shows up in tool output anyway, it is logged without the value and the agent is told to
  treat it as exposed.
- `vault reveal` exists for you in a terminal; agents are blocked from it, from the vault files, and from
  pasting a literal token into a command (`secret-in-command`).

**Limits.** This is hook-based, not a sandbox. The agent runs as you, so a determined agent could find a
way around it; real isolation needs a separate OS user or a container. The macOS Keychain and Linux Secret
Service backends have only been checked against stand-ins, never on a real Mac or Linux machine.

## Incident to rule

Turn something an agent did into a blocking rule, with the evidence in front of you.

```powershell
cephalo incident                 # recent actions with numbers
cephalo incident 7               # rule options for action 7 (or --last)
cephalo incident 7 --use 1       # add option 1 (asks first; --yes skips the question)
cephalo incident 7 --segment 2   # for a chain a && b && c, build from part 2
cephalo incident learned         # list rules created this way
cephalo incident undo learned-docker-rm-f
```

Options run from narrow to broad, one is recommended (for `docker rm -f production-db` it is "docker rm
with -f", not all of docker). Each is tested before you can pick it: it must compile, catch the original
action, run fast on adversarial text (a catastrophic regular expression is cut off and rejected), and the
report shows how many of your earlier allowed actions it would have blocked, with examples.

Adding a rule appends to `rules.yml` keeping your comments, makes a backup, re-reads and re-tests the
result, and takes effect on the next tool call. `undo` only removes rules whose id starts with `learned-`.
Agents cannot run `--use` or `undo`.

**Limits.** Rules match text, so a rephrased command can still get through. "Would have blocked 0" only
speaks for your own log. MCP calls have no command or path to match; use `cephalo mcp` for those.

## PR replay

A replay of what the agents did on a branch, built from the audit log and scoped to the current git
project, starting a little before the branch's first commit (work usually comes before the first commit).

```powershell
cephalo replay                                   # terminal summary + "needs attention" list
cephalo replay --format md                       # PR comment text
cephalo replay --format html --out replay.html   # one self-contained interactive file (play, step, filters)
cephalo replay --format json --out replay.json
cephalo replay --pr 12 --comment                 # post to PR 12 with the GitHub CLI (asks first; --yes skips)
cephalo replay --pr 12 --comment --update        # edit your earlier Cephalo comment instead of adding another
```

Other options: `--since` / `--until` (`30m`, `2h`, `1d`, `today`, or a date), `--session <id prefix>`,
`--all-projects`, `--strict` (leave out entries with no recorded project), `--repo owner/name`,
`--max-chars` (default 60000; GitHub's limit is 65536). An existing `--out` file needs `--force` and is kept
as a backup copy.

- Log text only ever appears inside code spans, so it cannot become markup or mentions in a comment; in the
  HTML it is set as text, with a strict content-security policy and no external requests.
- Tokens are redacted and your home folder is shown as `~`.
- Posting uses your own `gh` login, only with `--comment`, and only after a confirmation. `--update` finds
  the comment by a hidden marker and never edits "your last comment". A tripped session cannot post.

**Limits.** A replay is a record from a local log, **not a signed attestation**. Agents are blocked from
editing the log, but you, or anything running as you outside the hooks, could. Entries written before
Cephalo recorded session and directory are included by time only (the report says how many). The posting
path has been tested against a stand-in for `gh`, never against a live pull request.

## Audit log

Every evaluation appends one JSON line to `~/.cephalo/audit.jsonl`: `ts`, `agent`, `tool`, the `command`
or `path`, `decision`, `rule`, and where relevant `user`, `session`, `cwd`, MCP `server`/`params`/`pin`, and
a `note`. Tokens are redacted before writing. Read it with `cephalo log`, follow it with `cephalo watch`
(terminal control characters are neutralized), or summarise it with `cephalo replay`.

## Pro and Team

Everything above, and everything that was in 0.1.1, is free and MIT licensed. Pro ($15 per developer per month) and Team ($25) add three features that live in a separate, private package, `@nomajorconcerns/cephalo-pro`, which is **not** in this repository and is not on npm. Early users get 20% off the first year with code `CEPHALOG`. Prices and what each plan includes are on the [website](https://nomajorconcerns.github.io/cephalo/#pricing).

**Getting it.** Checkout runs on [Polar](https://polar.sh), the merchant of record. Your Polar purchase has a license key and a file download, `cephalo-pro-0.2.0.tgz`; both are in Polar's email and its customer portal. Install the download with `npm install -g ./cephalo-pro-0.2.0.tgz` (npm fetches the package's one dependency, `yaml`, from the public registry; nothing from your purchase goes to npm). Then run `cephalo pro activate`; it asks for the key without echo, activates it with Polar's public license-key API for this machine (labelled with its name), checks that activation, and stores a small record in `~/.cephalo/license.json` (provider, tier, activation id and the last four characters of the key; not the key). The key must belong to Cephalo's Polar organization and to the Pro or Team license-key benefit, and be granted; anything else is refused and its activation is given back. A `license.json` from 0.2.0 (Lemon Squeezy) still reads, but turns nothing on: re-activate with a Polar key. If Cephalo itself is not a global install (a clone, `npm link`), use `cephalo pro install ./cephalo-pro-0.2.0.tgz` instead, which installs it into `~/.cephalo/pro`. About every 35 days run `cephalo pro renew` so a cancelled subscription ends; `cephalo pro deactivate` gives the seat back; `cephalo pro status` shows where things stand.

Without the package, `cephalo egress`, `cephalo audit` and `cephalo bench` print a plain "this is part of Cephalo Pro" message with the pricing link and do nothing else. The hook never loads the package unless there is a current license, loads it only from beside Cephalo's own install or from `~/.cephalo/pro` (never from the current directory), and never uses the network.

- **Network egress allowlist.** `~/.cephalo/egress.yml` lists the domains agents may reach (`github.com` is exact, `*.npmjs.org` is any subdomain). With no file the feature is off. Shell commands (`curl`, `wget`, `Invoke-WebRequest`, `ssh`, `scp`, `rsync`, `nc`, git remotes, and URLs inside `bash -c`, `python -c` or `node -e`), `WebFetch` and MCP call parameters are blocked, or put to you with `mode: ask`, when they would reach another domain. Loopback is always allowed. A network tool whose destination cannot be read (`curl $URL`) counts as an unknown destination. Manage it with `cephalo egress list|allow|remove|mode|test`. It cannot see inside a script file, a program the agent just wrote, a host built at run time, an MCP server's own traffic, or package managers talking to their registries. It is a seatbelt, not a firewall.
- **Tamper-evident audit log.** Each audit line carries a sequence number, the previous line's hash and its own. `cephalo audit verify` reports lines that were edited, removed, reordered, inserted or cut off the end. `cephalo audit head` prints the newest `seq:hash`; keep a copy somewhere the agent and this machine cannot reach, and `verify --expect-head` checks against it. Someone who can rewrite the whole file can recompute every hash, which is exactly what the saved head catches.
- **Bypass benchmark.** `cephalo bench` runs about 100 known bypass attempts and ordinary commands through your rules without executing anything and reports the block rate, what got through, and any ordinary command blocked by mistake. `--defaults` judges the shipped rules, `--json` is for CI. Known gaps are listed and never counted in the rate. A CI job in the private package runs it on Windows, macOS and Linux.

The download itself is not locked: it is a file, and the license key is what switches the features on. The license check is client-side. Someone who edits their own files can run the paid package without paying; it keeps honest customers honest and is not copy protection.

## Files Cephalo keeps

All in `~/.cephalo` (the same on Windows, macOS and Linux). Agents cannot write any of these through their
tools.

| File | Purpose |
|---|---|
| `rules.yml` | Your rules |
| `audit.jsonl` | The audit log (with Pro: sealed lines, plus `audit.jsonl.head`) |
| `config.yml` | Settings (`cephalo config`) |
| `integrity/` | One marker per agent session, so the integrity check runs once per session |
| `license.json`, `pro/`, `egress.yml` | Pro and Team only: the license record, the installed Pro package, the egress allowlist |
| `mcp.yml`, `mcp-tools.json` | MCP allowlist and mode; approved tool fingerprints |
| `tripwire.yml`, `tripwire/` | Tripwire mode; per-session state (`cleared/` holds released records) |
| `models.yml`, `judge-cache.json`, `embed-cache.json`, `models-check.json`, `asks/` | Local-model judge settings (created only by `cephalo models enable`/`mode`); cached verdicts; embeddings of the known injection phrasings; the last model check; asks waiting for your answer |
| `vault.json`, `vault.key` | Encrypted secrets, and the master key file: wrapped by DPAPI on Windows; on macOS and Linux the key lives in the OS keystore instead; with the fallback `file` backend it is a plain key file readable only by you (mode 0600) |
| `*.cephalo-backup-<timestamp>` | Backups made before any change to a file |

## Safety model and limits

- **Fail-open by default.** If the hook crashes or its input is not valid JSON, the call is **allowed**, the
  error goes to stderr and into the audit log. A block decision is never weakened by a logging failure. Turn on
  [fail-closed mode](#settings) to block instead; then a broken hook stops your agent's tool calls.
- **Hook output is pure JSON.** Cephalo never prints the banner or colours on the hook paths.
- **It reads commands; it is not a sandbox.** It sees command text, not what a script does once it runs. A
  command assembled at runtime, or run from inside a script file, can slip past (`bash ./cleanup.sh`). Parsing
  and cleaning catch the common tricks, not all of them. `git clean -fdx` and PowerShell `iex (iwr ...)` have no rule.
- **Its own files are guarded by rules.** Rules stop agents writing the audit log, rules file, vault files
  and MCP and tripwire state. They are still rules: you, or anything running outside the hooks, can edit those
  files, so the audit log is a record and not a signed proof.
- **The tripwire is a heuristic; the vault is hook-based.** See their sections.
- **Platforms.** Windows has run on a real machine, and all of 0.2.0 was developed there. macOS and Linux, and the Codex and Cursor adapters, are covered by unit tests only.
- **Licence checks are client-side.** The free features need no licence. The Pro and Team package checks a
  Polar license key, but someone who edits their own files can run it without paying. See [Pro and Team](#pro-and-team).

## Troubleshooting

Run `cephalo doctor` first. Common causes when nothing is blocked:

- **Hermes shows `not allowlisted`:** approve the hook in an interactive `hermes` session (see Quick start).
- **Agent not restarted:** both agents load hooks at startup.
- **`dist/cli.js` missing:** run `npm run build`. The hook command points at it.
- **Old rules:** your `rules.yml` predates a default change. `cephalo rules` lists what is missing.
- **Hooks out of date** (no MCP, tripwire or vault protection): run `cephalo install claude` and
  `cephalo install hermes` again.
- **A tripped session blocks normal work:** `cephalo tripwire status` shows why; if it was a false alarm,
  `cephalo tripwire clear`.

To remove Cephalo from an agent: `cephalo uninstall claude` / `cephalo uninstall hermes`. Backups stay next
to the config files; nothing is deleted.

## Development

```powershell
npm run build         # tsc -> dist/
npm test              # build, then run every dist/tests/*.test.js with node --test (scripts/run-tests.mjs)
npm run test:release  # tests for the release script, workflow, site data, checkout and countdown
```

The Pro and Team package has its own repository and tests; it is not built from this one.

The tests use temporary directories and never touch your real `~/.cephalo`, Claude settings or Hermes config.

## Releases and verification

`node scripts/release.mjs pack` builds a release folder (the tarball, `SHA256SUMS`, and a keyless Sigstore
signature when `cosign` is installed) and prints the publish command; it never publishes. A GitHub Actions
workflow builds, signs and drafts a release on a tag, and publishes with npm provenance only after a manual
run and approval. To check a downloaded release:

```
sha256sum -c SHA256SUMS
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/nomajorconcerns/cephalo/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
```

Full procedure, setup and what the signatures do and do not prove: [docs/RELEASING.md](docs/RELEASING.md).
Nothing has been published or signed yet.

## Licence

[MIT](LICENSE)

## Codex and Cursor (adapters, not installed for you)

`cephalo hook codex` and `cephalo hook cursor` read each agent's payload and answer in its format. Command rules, protected paths and the tripwire apply; `cephalo init`/`install` do not edit their config files, so you add the hook yourself:

- Codex: a `PreToolUse` and `PostToolUse` command hook in `~/.codex/hooks.json` (or `[hooks]` in `config.toml`) running `node <project>/dist/cli.js hook codex`. Same JSON answer as Claude Code.
- Cursor: `preToolUse` and `postToolUse` in `~/.cursor/hooks.json` running `node <project>/dist/cli.js hook cursor`. Answers are `{"permission": "allow"|"deny", ...}`.

Limits: MCP calls and Codex `apply_patch` are not checked. Neither agent can be asked by the local-model judge, so a judge `unsure` or failure is logged and allowed there (a judge `block` still blocks). Both agents let the call through if the hook crashes or times out. These adapters were built from the vendors' docs and unit-tested; they have not been run inside the real Codex or Cursor.

## Cost per shipped result

`cephalo cost [--since 7d] [--all-projects] [--json] [--rows N] [--no-github]` adds up what your agent sessions cost and how many of them shipped.

- **Sessions** come from Claude Code's transcripts (`~/.claude/projects`) and Hermes' state database (read-only). A streamed message is counted once.
- **Dollars** for Claude Code are an estimate: token counts times Anthropic's API list prices. A subscription plan is a flat fee, so this is not what you were charged. Hermes' own cost figure is used for Hermes sessions. Models with no price are counted in tokens only and flagged; add prices in `~/.cephalo/prices.yml` (`model-prefix: {input, output, cache_write, cache_read}`, USD per million tokens).
- **Shipped** means the session's branch has a pull request that was merged with passing CI on its head commit, looked up with the `gh` CLI. A merged PR with no CI checks is reported separately and not counted. Sessions on `main`/`master` or with no branch can never count as shipped.
- **Cost per shipped result** is all the dollars in the window divided by the number of distinct shipped PRs, so work that never shipped raises the figure. The report also splits the spend into "sessions that shipped" and "everything else".
- By default only sessions run in the current directory are counted.

Limits: the link from a session to a PR is its branch name, so a reused branch name can mislink, and Hermes sessions often record no branch. `gh` must be logged in; without it sessions show as "unknown" and none count as shipped.

## Dashboard and team sync (no cloud)

Nothing here is hosted. Both features work through files, so your code and logs stay on machines and folders you control.

`cephalo dashboard [--out file] [--team] [--days N] [--no-cost]` writes one self-contained HTML page with three tabs: Overview (calls per day, by agent), Sessions and cost (the `cephalo cost` numbers), and Seatbelt (most-hit rules, and what needed a look). The page makes no network requests and sets all text with `textContent`, so text from an audit entry cannot run as script.

`cephalo sync` shares policy and audit logs through a folder you already have: a synced drive, a network share, or a clone of a git repo.

- `cephalo sync set <folder>` chooses the folder. Each write below asks first (or use `--yes`).
- `cephalo sync push` publishes your `rules.yml` to `<folder>/policy/` with a manifest (SHA-256, who, when). It refuses an invalid rules file.
- `cephalo sync pull` checks the manifest hash, shows what would be added, changed or **removed** (removals are flagged as weakening), asks, backs up your file, then applies it.
- **Signed policy** (optional). The person who publishes policy runs `cephalo sync keygen` once (creates `~/.cephalo/policy-signing.key` and `policy-signing.pub`; `push` then signs). Each developer runs `cephalo sync trust <policy-signing.pub>`; from then on `pull` refuses policy that is unsigned, signed by another key, or edited after signing. Hand the public key over directly, not through the shared folder. `cephalo sync status` shows whether the check is on. The agent cannot read or write the key files. Without a trusted key, pull works as before and only checks the file's hash.
- `cephalo sync audit` copies your audit log to `<folder>/audit/<user>@<machine>.jsonl`. Anyone with access to the folder can read it, so it asks first and says so. `cephalo dashboard --team` then shows every developer's log together.

Limits: the manifest hash only shows that the file arrived intact. It is not a signature, so anyone who can write to the folder can publish a policy (signed bundles are not built). Nothing pulls automatically; each developer runs `pull`. If the folder is a git repo, you commit and push it yourself. The audit copy is a snapshot you re-publish, not a live feed. Agents cannot edit `sync.yml` or `prices.yml`.

## Replay bundle (one shareable file)

`cephalo replay --format bundle [--out file] [--no-github]` writes a single self-contained HTML file (default `cephalo-bundle.html`): the interactive replay, plus what the sessions in it cost and how the work ended. Same scoping flags as any replay (`--since`, `--session`, `--pr`, `--all-projects`).

- **Cost:** only sessions that appear in the replay. Claude Code sessions are matched by session id. Hermes' audit entries carry no session id, so its sessions are matched by overlapping time inside the project directory, and the file says so. Dollars are the same list-price estimate as `cephalo cost`, labelled as an estimate.
- **Outcome:** the branch's pull request, looked up with `gh` when you export: shipped (merged with passing CI), merged with failing or no CI, open, closed, none, or "could not check". The file records when it looked, because a PR can be merged later.
- The page makes no network requests, and the data is embedded, so it works offline and can be attached to a PR or sent to a colleague.

Limits: like any replay it is built from the local audit log, not a signed attestation. Whoever receives it sees every command and path in the window (tokens are redacted, but review it before sharing). If no token usage is found, it says so instead of showing zero.
