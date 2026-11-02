# Security

Cephalo is a seatbelt for AI coding agents, not a sandbox. It matches patterns in commands and paths before a tool call runs, and it fails open if its hook crashes. Its own files are protected by rules, not by the operating system: anything running outside the hooks, including you, can edit them. See the "Honest limits" section of the README and website.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead: on the repository page, open the **Security** tab and choose **Report a vulnerability**. Include the Cephalo version (`cephalo --help` shows it), your operating system, and the command or input that gets past a rule or breaks a protection.

Reports about ways to slip a harmful command past the default rules are welcome and are normally fixed by adding or tightening a rule. Because Cephalo is a pattern matcher, a bypass is expected to exist for some inputs; the useful report is one that shows a realistic, common case.

## Verifying a download

Release tarballs are checksummed and, when published through the project's workflow, carry npm provenance. See `docs/RELEASING.md` for how to check them.
