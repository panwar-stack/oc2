# npm-Free GitHub Releases

## Goal

Remove npm registry lookup, authentication, and package publication from `.github/workflows/publish.yml` while preserving the GitHub Release artifacts required by `install`.

The workflow must continue allocating versions, creating or adopting draft releases, building all native binaries, uploading installer-compatible archives, validating release assets, and publishing the release as `latest`.

## Current State

- All npm-specific GitHub Actions references are confined to `.github/workflows/publish.yml`.
- `.github/workflows/publish.yml:139-170` uses `npm view oc2-ai` during version allocation.
- `.github/workflows/publish.yml:319-377` configures npm authentication and runs `packages/opencode/script/publish.ts`.
- `packages/opencode/script/build.ts:152-160` creates and uploads GitHub Release archives when `OC2_RELEASE=true`.
- `.github/workflows/publish.yml:379-414` verifies and publishes the draft release as `latest`.
- `install:104-170` selects platform, architecture, baseline, and musl variants.
- `install:185-197` downloads assets from GitHub Releases, not npm.
- `packages/opencode/script/publish.ts` mixes npm publication with native-package validation used by the workflow.
- `README.md:241` links to `docs/npm-publishing.md`.
- The existing `v0.0.2` draft has the expected assets but contains a stale npm URL.

## Non-Negotiables

- Keep the `plan`, `build`, and final release-publication jobs in `.github/workflows/publish.yml`.
- Keep `OC2_RELEASE=true`, `GH_TOKEN`, `GH_REPO`, and required `contents: write` permissions.
- Keep Node and Bun setup because release planning, validation, and builds still require them.
- Do not modify unrelated workflows, reusable actions, Bun installs, Node setup, or `node_modules` caches.
- Do not make a release public until its exact installer asset set is uploaded and nonempty.
- Preserve archive names and root layouts expected by `install`.
- Preserve source-marker validation, draft adoption, missing-tag recovery, and tag-to-source verification.
- Do not rerun an old failed workflow after deployment; reruns use the old workflow definition.
- Keep the existing `npm-publish` concurrency group through `v0.0.2` adoption unless no old runs are queued or active.

## Release Contract

Version allocation must use the union of:

- Remote Git tags matching canonical stable `v<semver>`.
- All GitHub Release tag names, including drafts and non-workflow releases.

This prevents reuse when a release exists but its Git tag is missing.

The release must contain exactly these assets:

```text
oc2-darwin-arm64.zip
oc2-darwin-x64.zip
oc2-darwin-x64-baseline.zip
oc2-linux-arm64.tar.gz
oc2-linux-arm64-musl.tar.gz
oc2-linux-x64.tar.gz
oc2-linux-x64-baseline.tar.gz
oc2-linux-x64-baseline-musl.tar.gz
oc2-linux-x64-musl.tar.gz
oc2-windows-arm64.zip
oc2-windows-x64.zip
oc2-windows-x64-baseline.zip
```

Each asset must:

- Have GitHub state `uploaded`.
- Have a size greater than zero.
- Contain `oc2` or `oc2.exe` at the archive root.
- Match the release version embedded in the binary.

The finalizer must reject missing, extra, incomplete, or empty assets.

## Implementation Slices

### PR 1: npm-Free Version Allocation

- Add a pure allocator to `packages/opencode/script/release-plan.ts`.
- Read GitHub Release metadata from the existing paginated releases response.
- Combine Release tag names with remote `v*` Git tags.
- Filter to canonical stable SemVer versions.
- Deduplicate annotated tag references and duplicate release tags.
- Increment the highest version by one patch.
- Return `0.0.1` when no valid version exists.
- Preserve existing release discovery, source markers, draft adoption, and recovery behavior.
- Remove `npm view oc2-ai`, `NPM_FILE`, `NPM_ERROR_FILE`, and npm-response parsing from `.github/workflows/publish.yml`.
- Stop adding npm URLs to newly created release notes.

Verification, from `packages/opencode`:

- `bun test script/release-plan.test.ts`
- `bun typecheck`

Required test cases:

- Empty release history.
- Git-tag-only history.
- Release-only history.
- Draft release reserving a version.
- Highest version selected across both sources.
- Duplicate and annotated tags.
- Malformed and prerelease versions ignored.
- Version increment failure.

Review:

A fresh read-only reviewer must compare the diff against this slice and verify that npm is no longer an allocation dependency without weakening draft recovery or version uniqueness.

### PR 2: Remove npm Publication and Guard Release Assets

- Extract `nativePackages` and `validateNativePackages` from `packages/opencode/script/publish.ts` into `packages/opencode/script/release-artifacts.ts`.
- Move focused validation tests to `packages/opencode/script/release-artifacts.test.ts`.
- Update both workflow validation commands to import `release-artifacts.ts`.
- Remove `registry-url` from the publish job's Node setup.
- Remove the npm authentication step and `NPM_TOKEN`.
- Remove the `Publish native packages and wrapper` step.
- Remove `NPM_CONFIG_PROVENANCE`.
- Keep the current build, Actions artifact transfer, and second package validation.
- Keep the `build.ts` GitHub Release upload controlled by `OC2_RELEASE=true`.
- Query GitHub Release assets immediately before final publication.
- Require the exact 12-asset contract, `uploaded` state, and nonzero size.
- Remove only the exact stale npm URL line from the adopted `v0.0.2` body.
- Refetch and revalidate release metadata after editing its body.
- Run `gh release edit "$TAG" --draft=false --latest` only after all checks pass.

Verification, from `packages/opencode`:

- `bun test script/release-plan.test.ts script/release-artifacts.test.ts`
- `bun typecheck`

Verification, from the repository root:

- `actionlint .github/workflows/publish.yml`
- `git diff --check`
- `rg -n 'npm (view|publish)|registry\.npmjs\.org|NPM_TOKEN|NPM_CONFIG_PROVENANCE|npmjs\.com/package/oc2-ai' .github/workflows/publish.yml packages/opencode/script/release-plan.ts packages/opencode/script/release-artifacts.ts`

Review:

A fresh read-only reviewer must verify the exact asset contract, workflow permissions, job dependencies, draft-to-public ordering, and absence of npm publication behavior.

### PR 3: Documentation and Obsolete Tooling

This slice must follow successful publication of `v0.0.2`.

- Replace `docs/npm-publishing.md` with GitHub Release dispatch, recovery, and installer verification instructions.
- Update the corresponding link in `README.md`.
- Audit references to `packages/opencode/script/publish.ts`, `script/publish.ts`, and `script/bootstrap-npm`.
- Remove the npm publishers and npm-specific tests atomically only after all active references are gone.
- Do not rewrite historical specifications solely to remove npm terminology.
- Rename the `npm-publish` concurrency group only after confirming no old workflow is queued or running.

Verification:

- `rg -n 'packages/opencode/script/publish|script/bootstrap-npm|script/publish' --glob '!specs/**' .`
- `git diff --check`

Review:

A fresh read-only reviewer must confirm that only obsolete npm distribution code was removed and that no build, release, or installer path was deleted.

## Rollout

- Confirm no old publish workflow is queued or running.
- Merge the updated workflow.
- Dispatch a new workflow run; do not rerun the old failed run.
- Confirm the workflow adopts the existing `v0.0.2` draft.
- Confirm a repeat dispatch from the same source reports completion rather than allocating `v0.0.3`.
- Confirm a newer source commit allocates the next patch version.

Commands:

```bash
gh workflow run publish.yml --ref main
gh release view v0.0.2 --json body,isDraft,tagName,targetCommitish,assets
gh api repos/panwar-stack/oc2/releases/latest --jq .tag_name
git ls-remote origin refs/tags/v0.0.2
HOME="$(mktemp -d)" ./install --version 0.0.2 --no-modify-path
```

## Future Work

- Add checksums or signatures for standalone archives.
- Add a Windows-native installer instead of relying solely on the shell installer.
- Remove the temporary legacy concurrency-group name after old workflow runs are impossible.

## Open Questions

- Should Windows ARM64 remain part of the release contract even though `install` currently rejects it? Default: keep it for compatibility with existing direct consumers.
- Should archive creation move from `build.ts` into explicit workflow steps? Default: leave it in `build.ts` for this change to minimize release risk.
