# Cephalo

The seatbelt for AI coding agents. Cephalo is a Node.js + TypeScript CLI that sits in front of
**Claude Code** and **Hermes Agent** and blocks dangerous tool calls (`DROP TABLE`, `rm -rf`,
`git push --force`, reading `.env`, ...) before they run.

It works through each agent's pre-tool hook: the agent hands Cephalo the tool call as JSON,
Cephalo checks it against a rules file, and answers allow or block.

## Install

Developed and tested on Node.js 24. The `npm test` script uses a glob with `node --test`, which needs Node 21 or newer.

```powershell
cd C:\Users\zuri\cephalo
npm install
npm run build
npm link          # makes `cephalo` available in any terminal
```

## Quick start

```powershell
cephalo init      # shows a plan, asks to confirm, then sets everything up
cephalo doctor    # checks that it is all wired up
```

`cephalo init` creates `~/.cephalo/rules.yml` from the defaults and adds Cephalo's hook to
Claude Code (`~/.claude/settings.json`) and, if found, Hermes (`%LOCALAPPDATA%\hermes\config.yaml`
on Windows, `~/.hermes/config.yaml` elsewhere). Every edit is backed up first, to
`<file>.cephalo-backup-<timestamp>`.

Then:

1. **Restart Claude Code.** It reads hooks at startup.
2. **Approve the hook in Hermes.** Hermes skips a hook command until you approve it once. Start an
   interactive `hermes`, accept the prompt, then check `hermes hooks list`: it must not say
   `not allowlisted`. `cephalo doctor` reports this too.
3. Try it: `cephalo test "DROP TABLE users"` then `cephalo log`.

## Commands

| Command | What it does |
|---|---|
| `cephalo test "<command>"` | Check a shell command: prints `BLOCKED (rule-id: description)` or `ALLOWED` |
| `cephalo init [--yes]` | Create rules, install hooks for the agents found. Asks first unless `--yes` |
| `cephalo doctor` | Check rules, a self-test, audit log, both hooks, Hermes approval. Exit 1 on problems |
| `cephalo rules` | List rules with their origin (`default`, `modified`, `custom`) and any missing defaults |
| `cephalo rules show <id>` | Full detail of one rule, including its pattern |
| `cephalo rules path` | Print the rules file location |
| `cephalo rules reset [--yes]` | Back up `rules.yml`, then rewrite it from the built-in defaults |
| `cephalo log [--blocked] [--limit N]` | Recent audit entries, newest last (default 20) |
| `cephalo install claude\|hermes` | Add the hook to one agent (idempotent; upgrades an old matcher in place) |
| `cephalo uninstall claude\|hermes` | Remove only Cephalo's entries, after a backup |
| `cephalo hook claude\|hermes` | The hook entry point the agents call. Not for humans |

## Rules

Rules live in `~/.cephalo/rules.yml` (`C:\Users\<you>\.cephalo\rules.yml`). If the file is missing
it is created from the built-in defaults. Changing the defaults in a new Cephalo version does
**not** update an existing file: run `cephalo rules reset` to get them.

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

Default rules: `no-drop`, `no-truncate`, `no-delete-all` (DELETE without WHERE), `no-rm-rf`,
`no-win-recursive-delete`, `no-force-push` (allows `--force-with-lease`), `no-hard-reset`,
`no-secret-read`, `no-secret-file` (`.env`, but not `.env.example`) and `protect-config`
(writes to Claude's `settings.json` and Hermes's `config.yaml`).

## What each hook covers

| Agent | Tools checked | Field used |
|---|---|---|
| Claude Code | `Bash` | `tool_input.command` |
| | `Read` | `tool_input.file_path` (read) |
| | `Write`, `Edit`, `MultiEdit` | `tool_input.file_path` (write) |
| | `NotebookEdit` | `tool_input.notebook_path` (write) |
| Hermes | `terminal` | `tool_input.command` |
| | `execute_code` | `tool_input.code`, scanned like a command (heuristic) |
| | `read_file`, `search_files` | `tool_input.path` (read) |
| | `write_file`, `patch` | `tool_input.path` (write) |

Other tools are allowed and logged.

When a call is blocked the agent sees:

> 🛑 Cephalo blocked this (rule: no-drop - Dropping tables or databases). If it is intended, ask the user to run it themselves.

## Audit log

Every evaluation appends one JSON line to `~/.cephalo/audit.jsonl`:
`{ts, agent, tool, command | path, decision, rule}`. Read it with `cephalo log`.

## Safety model and limits

- **Fail-open (Phase 1).** If the hook crashes or its input is not valid JSON, the call is
  **allowed**, the error goes to stderr and into the audit log. A block decision is never
  weakened by a logging failure.
- **Hook output is pure JSON.** Cephalo never prints the banner or colours on the hook paths.
- **It is a pattern matcher, not a sandbox.** It sees the command text, not what a script does
  once it runs. A command assembled at runtime, or run from inside a script file, can slip past
  the rules. Treat Cephalo as a seatbelt, not a vault.
- **Agents can change Cephalo.** The rules do not block `cephalo install`/`uninstall` or edits
  under `~/.cephalo`. If you want to stop that, add your own rule.

## Troubleshooting

Run `cephalo doctor` first. Common causes when nothing is blocked:

- **Hermes shows `not allowlisted`:** approve the hook in an interactive `hermes` session (see above).
- **Agent not restarted:** both agents load hooks at startup.
- **`dist/cli.js` missing:** run `npm run build` in the project folder. The hook command points at it.
- **Old rules:** your `rules.yml` predates a default change. `cephalo rules` lists what is missing.

To remove Cephalo from an agent: `cephalo uninstall claude` / `cephalo uninstall hermes`. Backups
stay next to the config files; nothing is deleted.

## Development

```powershell
npm run build     # tsc -> dist/
npm test          # build, then node --test dist/tests/*.test.js
```

The tests use temporary directories and never touch your real `~/.cephalo`, Claude settings or
Hermes config.
