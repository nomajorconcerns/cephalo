# Cephalo

The seatbelt for AI coding agents. Cephalo is a Node.js + TypeScript command-line tool that sits in
front of **Claude Code** and **Hermes Agent** and blocks dangerous tool calls (`DROP TABLE`,
`rm -rf`, `git push --force`, reading `.env`, an MCP tool that quietly changed its description, ...)
before they run.

It works through each agent's hook: the agent hands Cephalo the tool call as JSON, Cephalo checks it
against your rules and answers allow or block. Everything runs on your machine. There is no server,
no account and no telemetry.

> **Status.** Version 0.1.0, not yet published to npm. It has been exercised on Windows. The macOS and
> Linux adapters are covered by unit tests only. The newer features (MCP firewall, tripwire, vault,
> replay, incident-to-rule) were tested with simulated hook payloads and real child processes, not yet
> in a long live agent session. See [Safety model and limits](#safety-model-and-limits).

## Contents

- [Install](#install) · [Quick start](#quick-start) · [Commands](#commands)
- [Rules](#rules) · [What each hook covers](#what-each-hook-covers)
- [MCP firewall](#mcp-firewall) · [Prompt-injection tripwire](#prompt-injection-tripwire)
- [Local-model judge](#local-model-judge) · [Secrets vault](#secrets-vault) · [Incident to rule](#incident-to-rule) · [PR replay](#pr-replay)
- [Audit log](#audit-log) · [Files Cephalo keeps](#files-cephalo-keeps)
- [Safety model and limits](#safety-model-and-limits) · [Troubleshooting](#troubleshooting)
- [Development](#development) · [Releases and verification](#releases-and-verification) · [Licence](#licence)

## Install

Until the first npm release, install from source. Node.js 20 or newer is required by `package.json`; the
code has only been run on Node 24, and the `npm test` script's glob needs Node 21+.

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
| `cephalo doctor` | Check rules, a self-test, vault, tripwire, MCP firewall, audit log, both hooks, Hermes approval. Exit 1 on failures |
| `cephalo rules [list]` / `show <id>` / `path` / `reset [--yes]` | Inspect rules and where each came from; `reset` backs up `rules.yml` then rewrites it from the defaults |
| `cephalo log [--blocked] [--limit N]` | Recent audit entries, newest last (default 20) |
| `cephalo watch [--blocked] [--last N] [--no-color]` | Follow the audit log live. ALLOW green, BLOCK red. Ctrl+C stops |
| `cephalo install` / `uninstall claude\|hermes` | Add or remove Cephalo's hooks (idempotent; backs up first; uninstall removes only Cephalo's entries) |
| `cephalo mcp ...` | MCP firewall: allowlist, fingerprints, scan, proxy. See [MCP firewall](#mcp-firewall) |
| `cephalo tripwire ...` | Prompt-injection tripwire. See [below](#prompt-injection-tripwire) |
| `cephalo models ...` | Local-model judge (Ollama). See [below](#local-model-judge) |
| `cephalo vault ...`, `cephalo run ...` | Secrets vault. See [below](#secrets-vault) |
| `cephalo incident ...` | Turn an incident into a rule. See [below](#incident-to-rule) |
| `cephalo replay ...` | Replay of what the agents did. See [below](#pr-replay) |
| `cephalo hook claude\|hermes` | The entry point the agents call. Not for humans |

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
    action: block
```

- Patterns are **case-insensitive JavaScript regular expressions**.
- `command` rules are tested against shell commands (and, for Hermes `execute_code`, the script text).
- `path` rules are tested against file paths for reads and/or writes.
- The first matching rule blocks the call.

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
| Every OS ("system") | `protect-cephalo-policy`, `protect-audit-log`, `no-audit-tamper`, `protect-vault-files`, `no-vault-extract`, `secret-in-command`, `no-self-approve`, `no-self-incident` |
| Windows | `win-format-drive`, `win-disk-wipe`, `win-registry-delete`, `win-shadow-delete`, `win-power` |
| macOS | `mac-diskutil-erase`, `mac-disable-protection`, `mac-tmutil-delete`, `mac-keychain-secrets` + POSIX |
| Linux | `linux-mkfs`, `linux-dd-device`, `linux-write-device`, `linux-shred-device`, `linux-fork-bomb` + POSIX |
| POSIX (macOS + Linux) | `rm-long-flags`, `no-preserve-root`, `pipe-to-shell`, `chmod-chown-system` |

The system rules protect Cephalo itself: they stop an agent from writing the audit log or rules file,
the MCP and tripwire state, the vault files; from running `cephalo vault reveal`; from pasting a literal
API token into a command; and from approving MCP servers, releasing the tripwire, or adding learned rules
on its own.

## What each hook covers

| Agent | Before the call (can block) | After the call (reads the result) |
|---|---|---|
| Claude Code | `Bash` (command), `Read` (path, read), `Write`/`Edit`/`MultiEdit` (path, write), `NotebookEdit` (path, write), `mcp__*` (server, tool, parameters) | `Bash`, `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `mcp__*` |
| Hermes | `terminal` (command), `execute_code` (script text, a heuristic), `read_file`/`search_files` (path, read), `write_file`/`patch` (path, write), `mcp_*` | `terminal`, `read_file`, `search_files`, `execute_code`, `web_search`, `web_extract`, `browser_*`, `mcp_*` |

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
commands) is shown to the `decider` model, which answers `allow`, `block` or `unsure` as JSON. Everyday
commands (`npm test`, `git status`) never reach a model.

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
| `reviewer` | `qwen3.5:9b` (reads suspicious tool output; see the tripwire assist below) |
| `embedding` | `nomic-embed-text` (spots paraphrased injections in tool output) |

- **It can only tighten.** Rules decide first. The model is not asked about a call a rule already blocks, and
  its answer can never lift a block. In `warn` mode (the default) a `block` verdict is only written to the
  audit note; in `enforce` mode it denies the call as rule `judge-decider`.
- **It fails open.** A model that is down, slow, missing or answers in the wrong format means "no opinion".
  One time budget (`timeout_ms`, default 8000) covers all models tried.
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
  tool output itself is embedded. The reviewer's budget is `reviewer_timeout_ms` (default 15000).
- `cephalo models scan <file|->` runs the whole pipeline on some text and shows each step (best similarity,
  matched phrasing, reviewer verdict). It records nothing. Use it to tune `similarity_threshold` (default 0.75).
- Cost: with the judge on, every non-empty tool output is embedded once. Only a match reaches the reviewer.

**Limits.** Small models are wrong sometimes, in both directions. Watch `cephalo log` in `warn` mode before
switching to `enforce`. The decider needs a command with a risk signal, so it does not look at file writes or MCP
calls. The default similarity threshold is a guess: it was not tuned on a real embedding model, so expect to
adjust it with `cephalo models scan`. All of this has been tested against a simulated Ollama server, not yet
against real models.

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

## Files Cephalo keeps

All in `~/.cephalo` (the same on Windows, macOS and Linux). Agents cannot write any of these through their
tools.

| File | Purpose |
|---|---|
| `rules.yml` | Your rules |
| `audit.jsonl` | The audit log |
| `mcp.yml`, `mcp-tools.json` | MCP allowlist and mode; approved tool fingerprints |
| `tripwire.yml`, `tripwire/` | Tripwire mode; per-session state (`cleared/` holds released records) |
| `models.yml`, `judge-cache.json`, `embed-cache.json` | Local-model judge settings (created only by `cephalo models enable`/`mode`); cached verdicts; embeddings of the known injection phrasings |
| `vault.json`, `vault.key` | Encrypted secrets, and the master key file: wrapped by DPAPI on Windows; on macOS and Linux the key lives in the OS keystore instead; with the fallback `file` backend it is a plain key file readable only by you (mode 0600) |
| `*.cephalo-backup-<timestamp>` | Backups made before any change to a file |

## Safety model and limits

- **Fail-open.** If the hook crashes or its input is not valid JSON, the call is **allowed**, the error goes
  to stderr and into the audit log. A block decision is never weakened by a logging failure.
- **Hook output is pure JSON.** Cephalo never prints the banner or colours on the hook paths.
- **It matches patterns; it is not a sandbox.** It sees command text, not what a script does once it runs. A
  command assembled at runtime, or run from inside a script file, can slip past. Cleaning catches common
  tricks, not all of them.
- **Its own files are guarded by rules.** Rules stop agents writing the audit log, rules file, vault files
  and MCP and tripwire state. They are still rules: you, or anything running outside the hooks, can edit those
  files, so the audit log is a record and not a signed proof.
- **The tripwire is a heuristic; the vault is hook-based.** See their sections.
- **Platforms.** Windows has run on a real machine. macOS and Linux are covered by unit tests only.
- **No licence checks.** Every feature works locally. The website describes how paid tiers will be packaged;
  nothing in the code enforces them.

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
npm test              # build, then node --test dist/tests/*.test.js
npm run test:release  # tests for the release script and workflow
```

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
