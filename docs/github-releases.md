# GitHub Release Guide

OC2 patch releases are published by manually dispatching the `publish` GitHub
Actions workflow from `main` without inputs. The workflow allocates the next
patch version, creates or adopts a draft GitHub Release, builds every native
binary, uploads the installer archives and their `SHA256SUMS` manifest, validates
the complete asset set, and publishes the Release as `latest` only after every
check passes. Windows executables are intentionally unsigned.

Do not create, move, or replace a release tag manually. The workflow owns
version selection, the tag, the source commit, and the GitHub Release so they
cannot diverge.

## Prerequisites

Before dispatching a release:

- have permission to dispatch workflows and create Releases in
  `panwar-stack/oc2`;
- confirm the commit to release is on `main` and all required checks passed;
- confirm `RELEASE_TAG_RECOVERY_TOKEN` is configured as described below; and
- confirm no other release workflow is queued or running.

## Configure Release Tag Recovery

Add a fine-grained personal access token for the repository owner with:

- resource owner: `panwar-stack`;
- repository access: only `panwar-stack/oc2`;
- repository permission `Contents`: read and write; and
- repository permission `Workflows`: read and write.

Store the token as the repository Actions secret
`RELEASE_TAG_RECOVERY_TOKEN`. Give it a short practical expiration, record its
owner and expiration, rotate it before expiry, and revoke superseded tokens.
Do not grant access to other repositories or add other permissions.

Normal GitHub operations use the workflow's `github.token`. The recovery token
is exposed only to the step that creates an absent tag for an adopted draft. It
is never used to edit a Release, move a tag, or force-push a ref.

## Dispatch A Patch Release

Dispatch `publish.yml` from the `main` branch in the GitHub Actions UI. The
workflow has no inputs. Alternatively, authenticate the [GitHub
CLI](https://cli.github.com/) and run:

```sh
./script/release
```

The helper runs `gh workflow run publish.yml --ref main`. Passing a version or
any other argument is an error.

The workflow reserves the next patch after the highest canonical stable version
found across remote `v*` tags and all GitHub Releases, including drafts. It
records the exact source commit in the draft body and verifies that the release
tag resolves to that source before building. Generated release notes are
included automatically.

The Release remains a draft until all 12 expected archives and the `SHA256SUMS`
manifest are uploaded, nonempty, and in GitHub's `uploaded` state. The manifest
contains one SHA-256 digest for each archive. The final step refetches the
Release and rejects missing, extra, incomplete, or empty assets before
publishing it as `latest`.

## Recover A Failed Release

A fresh dispatch from current `main` adopts the sole workflow-owned draft and
continues its recorded source, tag, and version instead of allocating another
version. Existing assets are replaced. If the Release is already public, a
repeat dispatch for the same source exits without rebuilding it.

Do not rerun an old failed workflow after a workflow change has been deployed.
Reruns use the historical workflow definition. Dispatch a new run from current
`main` so recovery uses the current validation and publication logic:

```sh
gh workflow run publish.yml --ref main
gh run list --workflow publish.yml --limit 5
gh run watch <run-id>
gh run view <run-id> --log-failed
```

Adoption is fail-closed. The draft must have one valid source marker, its target
must equal that source, its tag must be canonical stable SemVer, and its source
must exist and be an ancestor of the dispatch commit. If the tag is absent, the
workflow requires `RELEASE_TAG_RECOVERY_TOKEN` and creates the ref once. If the
tag exists, it must already resolve to the recorded source. Multiple drafts,
malformed metadata, a non-ancestor source, a conflicting tag, or a missing
recovery token stop the run without allocating another version or changing an
existing ref.

Never delete, move, or force-create a tag to recover a release.

## Verify A Release

The Actions run must finish successfully. Set the released version without a
leading `v`, then verify its metadata, tag target, and `latest` status:

```sh
VERSION=0.0.2
TAG="v$VERSION"

gh release view "$TAG" --json isDraft,isPrerelease,tagName,targetCommitish,body
gh release view "$TAG" --json assets --jq '.assets[] | [.name, .state, .size] | @tsv'
gh api repos/panwar-stack/oc2/releases/latest --jq .tag_name
git ls-remote origin "refs/tags/$TAG"
```

Confirm that the Release is public, is not a prerelease, targets the intended
source, is the latest release, and has exactly these assets:

```text
SHA256SUMS
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

Every asset must report state `uploaded` and a size greater than zero. Download
the assets, verify every archive against the published manifest, and confirm
each archive contains only `oc2` or `oc2.exe` at its root:

```sh
ARCHIVES=$(mktemp -d)
gh release download "$TAG" --dir "$ARCHIVES"

(cd "$ARCHIVES" && sha256sum --check SHA256SUMS)
for archive in "$ARCHIVES"/*.tar.gz; do tar -tzf "$archive"; done
for archive in "$ARCHIVES"/*.zip; do unzip -Z1 "$archive"; done
```

On macOS, use `shasum -a 256 --check SHA256SUMS` instead. A checksum downloaded
from the same Release detects corruption but does not independently authenticate
the Release. Record trusted digests separately before using them as deployment
inputs.

Finally, exercise the same versioned GitHub download path used by end users and
confirm the installed binary reports the release version. Set `ASSET` to the
archive selected for the test host; this example is for a glibc Linux x64 host
with AVX2:

```sh
TEST_HOME=$(mktemp -d)
ASSET=oc2-linux-x64.tar.gz
ASSET_SHA256=$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$ARCHIVES/SHA256SUMS")
HOME="$TEST_HOME" OC2_ASSET_SHA256="$ASSET_SHA256" \
  ./install --version "$VERSION" --no-modify-path
"$TEST_HOME/.oc2/bin/oc2" --version
```

The installer refuses downloaded archives when `OC2_ASSET_SHA256` is absent,
malformed, or does not match. `--binary` installs a caller-supplied local file
and therefore does not require a release-archive digest.

Do not announce the release until the workflow, Release metadata, exact asset
set, checksum verification, archive layouts, tag target, and installer check all
pass.
