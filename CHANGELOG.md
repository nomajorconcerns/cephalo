# Changelog

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
