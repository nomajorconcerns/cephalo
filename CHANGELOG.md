# Changelog

## 0.3.0

### Pro and Team: Polar replaces Lemon Squeezy

Checkout, license keys and the Pro download move to [Polar](https://polar.sh), the merchant of record (payments run on Stripe). The `cephalo pro` commands and what they do stay the same.

- `cephalo pro activate` activates the key with Polar's public license-key API for this machine, labelled with its name, then validates that activation. It refuses a key unless it belongs to Cephalo's Polar organization, to the Pro or Team license-key benefit, and is granted; a key refused after activating has its activation given back. If every seat of a key is in use, the message says how to free one.
- `cephalo pro renew` validates the stored activation. Polar answers "not found" for a key that is revoked, disabled or expired, so a cancelled subscription ends the license, as before.
- `cephalo pro deactivate` gives the seat back.
- `~/.cephalo/license.json` keeps its shape (plan, activation ID, last four characters of the key, dates; never the key) and gains `provider: "polar"`.
- A `license.json` written by 0.2.0 with Lemon Squeezy still reads, but turns nothing on: `cephalo pro status`, the paid commands and `renew` say to re-activate with a Polar key, and nothing is sent anywhere for it. `cephalo pro deactivate` removes it (the Lemon Squeezy seat itself cannot be released from Cephalo any more).
- `CEPHALO_POLAR_SANDBOX=1` uses Polar's sandbox (`sandbox-api.polar.sh`) for testing, with its own IDs from `CEPHALO_POLAR_ORG_ID`, `CEPHALO_POLAR_PRO_BENEFIT_ID` and `CEPHALO_POLAR_TEAM_BENEFIT_ID`. A record activated in one environment is not renewed or released in the other.
- The Polar organization and the Pro and Team license-key benefit IDs are built in. If a build ever ships without them (placeholders), activation refuses with a plain message and sends nothing.
- The install hints no longer name a fixed Pro file version: they point at the cephalo-pro `.tgz` from your Polar download.
- The hook still never touches the network; only `cephalo pro activate | renew | deactivate` do.
- Website: the checkout settings name Polar and accept only `https://buy.polar.sh/...` and `https://polar.sh/...` links (still off, no links). The privacy, terms and refund pages and the README name Polar.

### Built-in updater and website

- **`cephalo update [--check] [--yes]`.** Updates Cephalo to the newest version on npm: it looks up the latest version from the public registry (only when you run the command), shows `current -> newest`, asks, then runs `npm install -g @nomajorconcerns/cephalo@<newest>`. `--check` only looks. It refuses to replace a copy that is not in npm's global folder (a git checkout or an `npm link`), and agents cannot run it (`no-self-approve` now covers `cephalo update`). Rules, audit log, settings and license are not touched. Not in 0.2.0; new in 0.3.0.
- Website: the pre-launch announcement and countdown are replaced by a release notice and an Install / Update section; the page has a new look based on the CLI's reef theme.

## 0.2.0

Launches 10 November 2026. Everything that was in 0.1.1 stays free and MIT licensed. This release adds free features and a paid layer (Pro and Team) that lives in a separate, private package.

### Free

**Closes the bypasses found in 0.1.1.** Each has a regression test.

- `Grep`, `Glob`, `WebFetch` and `WebSearch` (and Hermes `search_files`, `web_search`, `web_extract`) are now checked. Grep and Glob can no longer read `.env` files. Run `cephalo install` again to pick up the wider hook matchers; hooks installed earlier keep their old ones.
- Relative paths are resolved against the session's working directory, and symlinks are resolved, before path rules run.
- Writes to the Claude Code and Hermes config files are blocked from the shell, not only from file tools (`no-agent-config-tamper`).
- Cephalo's own `dist/` folder, the code the hook runs, is protected from agent writes (`protect-cephalo-install`, `no-install-tamper`, `no-protected-write-code`).
- On macOS, an install folder under `/private/var`, `/private/tmp` or `/private/etc` is also guarded in its `/var`, `/tmp` or `/etc` form, so a relative write from inside it is blocked too.
- `no-secret-shell`: reading `.env` files through a shell command or inline code. It also matches `.env` inside a commit message.
- On Windows, the `rm`, `find -delete` and `find -exec rm` rules now apply too, because agents there often run Git Bash or WSL. Before, `rm -r -f ./build` was blocked on Linux and macOS but not on a Windows host.
- Agents can no longer run `cephalo config set`, `cephalo rules reset`, `cephalo egress allow|remove|mode` or `cephalo pro activate|renew|install|deactivate` themselves (`no-self-approve`).

**Commands are parsed, not only matched as text.** Pipelines, `&&`, `||`, `;`, subshells, `$(...)`, backticks, `<(...)` and heredocs are split and each part is checked. Inline code is unwrapped and checked: `bash -c`, `sh -c`, `eval`, `python -c`, `node -e`, `perl -e`, `ruby -e`, `ssh host "..."`, `find -exec`, `sudo`/`env`/`timeout` wrappers, base64 payloads, and on Windows `powershell -Command`, `-EncodedCommand`, `iex` and `cmd /c`. The raw text is always checked as well, so parsing can add blocks but never remove one. If a command cannot be read cleanly, Cephalo falls back to text matching, and `allow` rules do not apply to it. The parser has no dependencies.

**Allow and ask rules.** A rule can now say `action: allow` (an exception; the first matching rule still wins) or `action: ask`. Claude Code shows you an approval prompt. Codex, Cursor and Hermes cannot show one, so for them `ask` follows the `ask-default` setting (block unless you change it), and the log says so. An `allow` rule cannot lift Cephalo's own built-in protections. `cephalo rules` shows each rule's action. The rule builder on the website has the same options.

**Shadow mode**, global (`cephalo config set shadow on`) or per rule (`shadow: true`). A shadow rule logs what it would have done and blocks nothing. `cephalo log` and `cephalo watch` label these `would block`, and `cephalo log --shadow` lists them. The built-in protections stay on in global shadow mode.

**Optional fail-closed mode** (`cephalo config set fail-closed on`, off by default). If the hook crashes, times out (`hook-timeout`, default 8 seconds) or gets unreadable input, the call is blocked instead of allowed. The trade-off: a broken hook then stops your agent's tool calls until you turn it off.

**Self-integrity check.** The build writes `dist/integrity.json` with a SHA-256 for each installed file. On the first hook call of a session, and in `cephalo doctor`, Cephalo checks that its hook entry is still in the agent's config, that it points at this install, and that the files match. A failure warns loudly (Claude Code shows it once per session; Hermes has no warning field, so it is logged and shown by `doctor`). With fail-closed on, a failed check blocks calls. This catches accidents and clumsy tampering; someone who can edit `dist/` as you can also edit the list.

**Settings file** `~/.cephalo/config.yml`: `fail-closed`, `shadow`, `ask-default`, `hook-timeout`, `theme`. Use `cephalo config list|get|set|path`. Agents cannot write it.

**Themed CLI.** Five color schemes, each with a dark-terminal and a light-terminal palette: `reef` (default), `abyss`, `coral`, `glow` and `ink` (no color; meaning comes from bold, underline and reverse video). `cephalo theme list|preview|set|reset`, or `CEPHALO_THEME=glow` for one run. ALLOW, BLOCK and ASK are always words and never depend on color alone. Colors fall back from 24-bit to 256 to 16 to none, and respect `NO_COLOR`, `FORCE_COLOR` and piped output. Every color the CLI prints now comes from `src/theme.ts`, including the `[y/N]` prompts. `cephalo hook ...` never prints color, banners or animation; its output stays pure JSON, with tests.

**Loading animation.** While `init --yes`, `doctor`, `mcp scan`, `models scan`, `models eval`, `replay` and `cost` work, the pixel octopus waves its tentacles beside a status message, about ten frames a second, in the active theme's colors. It clears itself before results print. With no terminal, `NO_COLOR`, `CI`, `CEPHALO_NO_ANIMATION=1` or `REDUCE_MOTION=1`, a plain `Working...` line goes to stderr instead. The frames advance only while the command is waiting on something asynchronous, so `doctor` and `replay` show the first frame and hold it.

### Pro and Team (private package, not in this repository)

Pro is $15 per developer per month and Team $25. Both include these three features. Early users get 20% off the first year with code `CEPHALOG`. The free core only holds a small license layer (`cephalo pro status|activate|renew|install|deactivate`); the features ship in the private package `@nomajorconcerns/cephalo-pro`, which is not on npm. Each Lemon Squeezy order has the license key and a download, `cephalo-pro-0.2.0.tgz`, installed with `npm install -g ./cephalo-pro-0.2.0.tgz`; the activate command then checks the key against the store and product. The package loads from beside Cephalo's own install or from `~/.cephalo/pro`, never from the current directory, and needs no network access in the hook. The license is checked against the server about every 35 days (`cephalo pro renew`).

- **Network egress allowlist** (`cephalo egress`). `~/.cephalo/egress.yml` lists the domains agents may reach; shell commands (`curl`, `wget`, `Invoke-WebRequest`, `ssh`, `scp`, `rsync`, `nc`, git remotes, and URLs inside `bash -c`, `python -c`, `node -e`), `WebFetch` and MCP call parameters are blocked, or put to you with `mode: ask`, when they would reach anything else. Loopback is always allowed. A network tool whose destination cannot be read (`curl $URL`) counts as an unknown destination. It cannot see inside a script file, a program the agent just wrote, a host built at run time, or an MCP server's own traffic, and it does not watch package managers talking to their registries. It is a seatbelt, not a firewall.
- **Tamper-evident audit log** (`cephalo audit verify`). Each audit line carries a sequence number, the previous line's hash and its own hash. `verify` reports lines that were edited, removed, reordered, inserted or cut off the end. `cephalo audit head` prints the newest `seq:hash` to keep somewhere safe, and `verify --expect-head` checks against it. Someone who can rewrite the whole file can recompute every hash; the saved head is what catches that.
- **Bypass benchmark** (`cephalo bench`). About 100 known bypass attempts and ordinary commands are run through your rules (nothing is executed). It reports the block rate, what got through, and any ordinary command blocked by mistake; `--defaults` judges the shipped rules and `--json` is for CI. Documented gaps are listed and never counted in the rate. A CI job runs it on Windows, macOS and Linux.

The license check is client-side: someone who edits their own files can run the paid package without paying. It keeps honest customers honest; it is not copy protection.

### Existing users

- Cephalo never changes an existing `rules.yml`. `cephalo rules` lists the default rules your file lacks. The new built-in protections (the ones in the first list above) are active without any change to your file.
- Run `cephalo install` once to widen the hook matchers (Grep, Glob, WebFetch, WebSearch; Hermes web tools) and `cephalo doctor` to check the install integrity.
- `allow` and `ask` rules, and `shadow`, are ignored by 0.1.x. Do not copy a rule that relies on them into an older install: it would be treated as a block.

### Known limits

- Commands hidden inside a script file (`bash ./cleanup.sh`), built at run time, or passed through an environment variable are not inspected. `git clean -fdx` and PowerShell `iex (iwr ...)` have no rule.
- The parser is not a shell: constructs it does not handle (`case` patterns, function definitions) fall back to text matching.
- The macOS and Linux adapters, the Keychain and Secret Service vault backends, and the Codex and Cursor adapters are covered by unit tests only. All of 0.2.0 was developed and run on Windows.
- The website's playground uses a text-only port of the engine, not the parser.

## 0.1.1

Closes four bypasses found in review.

New default rules (stored in `~/.cephalo/rules.yml`):

- `no-force-push-refspec`: blocks a `+` refspec, which force pushes without a flag (`git push origin +main`, `+HEAD:main`). `--force-with-lease` stays allowed.
- `no-pipe-to-shell`: blocks output piped into `sh`, `bash`, `zsh`, `dash` or `ksh` (also after `sudo`, and `sh -s`), `eval "$(...)"`, and `bash <(...)`. This includes `curl ... | bash` installers on purpose: the agent should ask you to run those.

New built-in Linux and macOS rules (active at once, not stored in the file):

- `find-delete`: `find ... -delete`.
- `find-exec-rm`: `find ... -exec rm` and `-execdir rm`.

New feature:

- **Signed policy bundles.** `cephalo sync keygen` creates an Ed25519 signing key; `cephalo sync push` then signs the shared policy. A developer runs `cephalo sync trust <public-key-file>` once, and from then on `cephalo sync pull` refuses policy that is unsigned, signed by another key, or changed after signing. Without a trusted key nothing changes. A new built-in rule, `protect-policy-key`, stops agents reading or writing the key files. Local files and Node's crypto only; no network.

Existing users: Cephalo never changes an existing `rules.yml`, so the two new default rules are not in your file yet. Run `cephalo rules`: it lists them under "Missing defaults". To add them, rename your rules file (for example to `rules.yml.old`) and let Cephalo regenerate it, or add the two rules by hand. The `find` rules need no action.

Still a known limit: commands hidden inside a script file (`bash ./cleanup.sh`) are not inspected.

## 0.1.0

First public release. Everything below runs locally; Cephalo has no server and no telemetry.

- **Rules firewall.** Hooks for Claude Code and Hermes check every shell command and file path against `~/.cephalo/rules.yml` before it runs. First match wins. Text is cleaned for the operating system first (empty quotes, carets, backticks, `..` in paths) and both versions are checked.
- **Platform adapters** for Windows, macOS and Linux, each with its own built-in rules. Windows is the platform it has been run on for real; macOS and Linux are covered by unit tests only.
- **Audit log** with `cephalo log`, `cephalo watch` and `cephalo replay` (text, Markdown, HTML, and a single-file bundle with cost and outcome).
- **MCP firewall**: server allowlist and tool fingerprinting with re-approval when a tool changes.
- **Prompt-injection tripwire** that locks a session after suspicious tool output.
- **Secrets vault** (`cephalo run`) and a literal-token rule.
- **Incident to rule**: turn a blocked or missed action into a new rule, with a test against earlier actions.
- **Optional local-model judge** through Ollama. Off by default; with every model role disabled Cephalo behaves exactly as without it. Models can only make a decision stricter.
- **Cost per shipped result**, a local HTML dashboard and shared-folder policy/audit sync.
- **Codex and Cursor adapters**, tested only against the vendors' documented hook formats, not run inside the real apps.

Known limits are listed on the project website and in the README.
