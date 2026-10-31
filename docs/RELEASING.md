# Releasing and verifying Cephalo

Nothing in this repository publishes by itself. This document covers how a release is built and signed, how you publish it with your own login, and how anyone can check it.

## What a release contains

`node scripts/release.mjs pack` builds a folder `release/cephalo-<version>/`:

| File | What it is |
| --- | --- |
| `cephalo-<version>.tgz` | The exact tarball `npm publish` uploads. Built from the `files` whitelist in `package.json`: the compiled `dist/` (without tests), `README.md`, `LICENSE`, `package.json`. No source, website or tests. |
| `SHA256SUMS` | One line per file: `<sha256>  <name>`. Readable by `sha256sum -c`. |
| `SHA256SUMS.sigstore.json` | A keyless [Sigstore](https://www.sigstore.dev/) signature of `SHA256SUMS` (made with `cosign sign-blob`). Because `SHA256SUMS` contains the tarball's hash, this signs the tarball too. |

Before building anything, the script refuses to continue unless: the tree is committed and clean, `package.json` has a licence, a matching `LICENSE` file, a GitHub `repository` URL, a `bin` entry and a `files` whitelist, the tag (if given) equals `v<version>`, `dist/cli.js` starts with `#!/usr/bin/env node`, the file list has nothing that should never ship (source, tests, `.env`, keys, source maps, Cephalo user data), none of the files contain what Cephalo's own credential detector recognises as a token, and the tests pass. It then packs **twice** and refuses to continue if the two tarballs differ, so a rebuild can always be compared with what was signed.

## One-time setup

1. **Repository.** `package.json` points to `github.com/nomajorconcerns/cephalo`. npm provenance only works from a **public** repository whose URL matches that field exactly (case-sensitive). Nothing has been created or pushed yet.
2. **npm account** with two-factor authentication on, and the package name `cephalo` (it returned "not found" on the registry when checked; npm can still refuse a name it considers too similar to an existing one).
3. **For the GitHub workflow:**
   - Settings > Environments > create `npm-publish` and add yourself as a required reviewer. The publish job cannot start until you approve it.
   - Add a repository secret `NPM_TOKEN`: a granular access token limited to this one package, with publish rights. (Alternative: configure npm *trusted publishing* for this repository and workflow on npmjs.com, then delete the secret; npm then needs no token. Requires npm 11.5.1 or newer, which Node 24 ships.)
4. **For signing on your own machine:** install `cosign` ([installation](https://docs.sigstore.dev/cosign/system_config/installation/)). It is not installed on the machine this was prepared on, so the cosign steps below have **never been run for real**.

## Path A: publish from GitHub Actions (adds npm provenance)

1. Change `version` in `package.json`, commit.
2. `git tag v<version>` and push the tag.
3. The `release` workflow runs the tests on Linux, Windows and macOS with Node 20, 22 and 24, builds and signs the tarball (the signature names the workflow as the signer), and attaches the three files to a **draft** GitHub release. It does not publish to npm.
4. Look at the draft release and download the files. Run the verification below.
5. To publish: Actions > release > Run workflow, choose the tag, tick `publish`. The `publish` job waits for your approval of the `npm-publish` environment, re-checks the checksums and the signature, then runs `npm publish <the signed tarball> --access public --provenance`.

The npm page then shows a provenance badge linking the package to the commit and workflow that built it.

## Path B: publish yourself from your machine (no provenance)

npm provenance can only be created by a supported CI provider, so a local publish has **no** provenance. It can still be checksummed and signed.

```powershell
npm ci
npm test
node scripts/release.mjs pack --sign required       # builds, checks, checksums, signs (opens a browser login)
node scripts/release.mjs verify release\cephalo-<version> --identity you@example.com --issuer https://accounts.google.com
npm publish "release\cephalo-<version>\cephalo-<version>.tgz" --access public
```

`--sign required` fails instead of producing an unsigned folder. The script prints the `npm publish` command at the end; it does not run it. The identity and issuer in the signature are whatever account you log in with, so the verify command must name that same account.

## Verifying a release (anyone)

**1. The installed package (npm).** For a release published through Path A:

```
npm audit signatures
```

checks the registry signature and the provenance attestation of every installed package, including `cephalo`.

**2. The tarball against the signed checksums.** From the GitHub release, download the `.tgz`, `SHA256SUMS` and `SHA256SUMS.sigstore.json` into one folder, then:

```
sha256sum -c SHA256SUMS
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/nomajorconcerns/cephalo/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS
```

(PowerShell: `Get-FileHash -Algorithm SHA256 .\cephalo-<version>.tgz` and compare with the line in `SHA256SUMS`.) Or use the repository's script: `node scripts/release.mjs verify <folder> --identity '<regexp>' --issuer <url>`.

**3. The tarball against npm's copy.** `npm pack cephalo@<version>` downloads the published tarball; its SHA-256 should equal the signed one.

## What this does and does not prove

- A valid signature plus matching checksum shows that the tarball is the one the named signer (this workflow, or the account you logged in with) produced, unmodified since.
- Provenance shows which repository, commit and workflow built the package. It does **not** show that the code is safe, that the maintainers are trustworthy, or that nobody with write access to the repository changed the code before tagging.
- If you only run `sha256sum -c` you learn that the files match `SHA256SUMS`, not who wrote it. Check the signature too.
- Keyless signatures are recorded in a public transparency log. The signer's identity (a workflow path, or an email address for Path B) is therefore public.

## If something goes wrong

- **Bad release not yet published:** delete the draft release and the tag. Nothing has left your control.
- **Bad version already on npm:** npm only allows unpublishing within a short window and under conditions. The normal route is `npm deprecate cephalo@<version> "<reason>"` and a fixed patch release.
- **Leaked token:** revoke it on npmjs.com first, then rotate the `NPM_TOKEN` secret.

## Known gaps in what was prepared

- The workflow file has **never run on GitHub**. Its structure is checked by `npm run test:release` (pinned action SHAs, least-privilege permissions, publish gated by a manual run and an approved environment), but the first real run will probably need small fixes. In particular the artifact folder layout between jobs (`release/cephalo-<version>`) is assumed, not observed; a wrong guess makes the publish job fail loudly, not publish something wrong.
- `engines.node` says `>=20`, but the code has only been run on Node 24. The test matrix will find out.
- The test suite has only been run on Windows. macOS and Linux runs in CI are the first real test of those adapters.
- `cosign sign-blob` and `verify-blob` are invoked with the flags in the Sigstore documentation, and a stand-in for cosign confirms the arguments. Real signing has not been done.
- Third-party actions are pinned to commit SHAs resolved on the day this was written. Update them on purpose, not automatically.
