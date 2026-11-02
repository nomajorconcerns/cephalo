# Changelog

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
