# npm Binary Publishing And Script Cleanup

## Goal

Replace `.github/workflows/publish.yml` with a focused workflow that publishes OC2 binaries to npm. The first pass must publish the `oc2-ai` wrapper and its platform-specific binary packages deterministically, without retaining unrelated Homebrew, AUR, GitHub Release, or preview CLI publication.

Remove the root `check:brand` command and delete root `script/` files that have no active project or documented maintainer use.

## Current State

- `.github/workflows/publish.yml` currently combines npm, GitHub Release, Homebrew, AUR, Windows signing, and preview `lildax` builds.
- `packages/opencode/script/build.ts` builds OC2 binaries for 12 OS, architecture, libc, and CPU combinations.
- `packages/opencode/script/publish.ts` generates the `oc2-ai` wrapper and twelve optional native packages named `oc2-<platform>`.
- `packages/opencode/script/postinstall.mjs` selects and installs the appropriate native package.
- The current workflow signs obsolete `opencode.exe` files even though `packages/opencode/script/build.ts` emits only `oc2.exe`.
- `script/publish.ts` invokes only `packages/opencode/script/publish.ts`; SDK, plugin, and preview CLI publishing are not part of the effective release path.
- `package.json` exposes `check:brand`, but no workflow or Git hook invokes it.
- `script/check-brand.ts` and `script/legacy-brand-allowlist.jsonc` exist solely to support `check:brand` and related historical specs.
- These root scripts have no active references: `script/generate.ts`, `script/format.ts`, `script/hooks`, and `script/sign-windows.ps1`.
- `script/release` has no references but is an executable maintainer shortcut for dispatching `publish.yml`; treat it as intentional manual tooling unless maintainers explicitly reject it.

## Non-Negotiables

- The canonical npm install package must be `oc2-ai`, exposing only the `oc2` executable.
- Publish the wrapper only after every required native package is confirmed published at the same version.
- Do not publish `lildax`, SDK, plugin, Homebrew, AUR, or GitHub Release artifacts in the new workflow.
- Do not attempt to sign or verify obsolete `opencode.exe` binaries.
- The workflow must support a first npm release without reading or globally installing a nonexistent prior `oc2-ai` version.
- Package names, versions, artifacts, and tarball paths must be validated before the first `npm publish`.
- A rerun must not replace a Git tag or overwrite an npm version associated with different source.
- Do not remove scripts merely because they lack an automated caller when they are exposed as documented package commands or clear maintainer tools.
- Every implementation slice requires a fresh read-only adversarial review before completion.

## npm Package Contract

The release contains one wrapper and twelve native packages:

```text
oc2-ai
oc2-linux-arm64
oc2-linux-x64
oc2-linux-x64-baseline
oc2-linux-arm64-musl
oc2-linux-x64-musl
oc2-linux-x64-baseline-musl
oc2-darwin-arm64
oc2-darwin-x64
oc2-darwin-x64-baseline
oc2-windows-arm64
oc2-windows-x64
oc2-windows-x64-baseline
```

Requirements:

- Every package must use the same exact version.
- `oc2-ai` must declare the twelve native packages as optional dependencies at that version.
- Every native tarball must contain exactly one expected `oc2` or `oc2.exe` binary plus its package metadata.
- The workflow must use explicit tarball paths. Do not publish through `*.tgz`.
- Publish native packages first and `oc2-ai` last.
- A package version already present on npm may be skipped only after verifying its manifest matches the intended package name and version.
- Authentication or network failures from `npm view` must fail the workflow, not be interpreted as “not published.”
- Partial native-package publication must be recoverable by rerunning the same source SHA and version.

## Workflow Behavior

Replace `.github/workflows/publish.yml` in place.

The new workflow must:

- Support `workflow_dispatch` with an explicit `version`.
- Leave automatic version bumping out of the first pass because `packages/script/src/index.ts` currently derives versions from the nonexistent `oc2-ai/latest`.
- Use a concurrency group that serializes npm releases.
- Build all targets through `packages/opencode/script/build.ts`.
- Sign only the emitted Windows `oc2.exe` binaries.
- Validate the complete artifact set before publication.
- Configure Node and the npm registry for trusted publishing.
- Publish using GitHub OIDC.
- Enable npm provenance unless npm trusted-publisher limitations require a documented exception.
- Use a controlled npm dist-tag, defaulting to `latest`.
- Reject invalid semver versions and unsafe dist-tags before building.
- Avoid installing `oc2-ai` to generate changelogs or run the release.
- Limit workflow permissions to `contents: read` and `id-token: write` unless an additional permission has a demonstrated use.

Repository administrators must reserve all package names and configure npm trusted publishing for `.github/workflows/publish.yml` before the first live release.

## Script Cleanup

Delete:

```text
script/check-brand.ts
script/legacy-brand-allowlist.jsonc
script/generate.ts
script/format.ts
script/hooks
script/sign-windows.ps1
```

Update:

- Remove `check:brand` from the root `package.json`.
- Remove obsolete references to `check:brand`, `script/check-brand.ts`, and `script/legacy-brand-allowlist.jsonc` from `specs/minimal-baseline.md` and `specs/readme-update.md`.
- Remove `script/generate.ts` from generated-file scope logic in `script/ci-scope.ts` if that entry becomes dead after deletion.

Retain:

- Release chain: `script/version.ts`, `script/changelog.ts`, `script/raw-changelog.ts`, `script/publish.ts`.
- CI and package checks: `script/ci-scope.ts`, `script/check-generated.ts`, `script/package-boundaries.ts`, and its baseline.
- Exposed maintainer commands: `script/check-product-copy.ts`, `script/upgrade-opentui.ts`.
- `script/release` pending an explicit maintainer decision.

## Documentation

Update `README.md` with the canonical npm installation command:

```sh
npm install --global oc2-ai
```

Document that installation lifecycle scripts must run so `packages/opencode/script/postinstall.mjs` can select the native binary. Supporting `--ignore-scripts` installs is outside the first pass.

## Implementation Slices

### PR 1: Remove Dead Root Scripts

- Remove `check:brand` from `package.json`.
- Delete the six identified unused script files.
- Remove obsolete spec and CI-scope references.
- Preserve `script/release` and other manual package commands.

Verification:

- `bun install --frozen-lockfile`
- `rg -n 'check:brand|check-brand|legacy-brand-allowlist|script/generate|sign-windows|script/hooks' package.json .github script specs`
- `bun run check:packages`
- `bun run check:generated`

Review:

A fresh read-only reviewer must inspect the diff and repeat the reference search. The reviewer must confirm that every deleted file has no runtime, workflow, package-command, hook, documentation, or dynamic command reference.

### PR 2: Make npm Packaging Deterministic

- Update `packages/opencode/script/publish.ts` to validate the exact native package set, common version, binary names, and wrapper optional dependencies.
- Pack each package once and retain its explicit tarball path.
- Distinguish npm “not found” responses from authentication and network failures.
- Publish native packages before the wrapper.
- Add packaging tests covering manifest and tarball contents.
- Add the npm install command and lifecycle-script limitation to `README.md`.

Verification:

- `bun test script`
- `bun run typecheck`
- `bun pm pack`
- `npm pack --dry-run`

Run package-specific commands from `packages/opencode`.

Review:

A fresh read-only reviewer must compare generated package manifests and tarball contents against the 13-package contract. The review must specifically test missing artifacts, mixed versions, stale tarballs, and partial reruns.

### PR 3: Replace The Publish Workflow

- Replace `.github/workflows/publish.yml` with the npm-only workflow.
- Require an explicit semver version for the first release.
- Build and transfer only OC2 native artifacts.
- Sign only Windows `oc2.exe` binaries.
- Validate all artifacts before publication.
- Configure serialized OIDC trusted publication with provenance.
- Remove preview CLI, AUR, Homebrew, and GitHub Release steps and their unused secrets and permissions.

Verification:

- `actionlint .github/workflows/publish.yml`
- `bun run typecheck`
- `git diff --check`
- Dispatch a prerelease version and confirm all native packages publish before `oc2-ai`.
- Install the prerelease in a clean environment and run `oc2 --version`.

Review:

A fresh read-only reviewer must audit workflow permissions, artifact names, Windows signing inputs, first-release behavior, publication ordering, exact-SHA reruns, and partial-release recovery. The slice must not be considered complete until the trusted-publisher mappings and package ownership are verified outside the repository.

## Future Work

- Restore automatic major, minor, and patch version allocation after the first npm version exists.
- Add npm, pnpm, Yarn, Bun, `npx`, musl, baseline CPU, and Windows installation matrices.
- Decide whether lifecycle-script-disabled installations require a supported fallback.
- Publish SDK, plugin, or `lildax` packages through separate workflows if they become public products.
- Add GitHub Release, Homebrew, or AUR distribution through separate, independently reviewable workflows.

## Open Questions

- Should `script/release` remain as a maintainer shortcut? Default: retain it because it intentionally dispatches the workflow.
- What explicit version should seed the first `oc2-ai` npm release? Default: use the repository’s current release version rather than deriving it from npm.
- Are all thirteen unscoped npm names owned and configured for trusted publishing? Default: block the live workflow until ownership is verified.
- Should npm provenance be enabled? Default: yes; remove the current `NPM_CONFIG_PROVENANCE=false`.
