# Secure Issue Automation

OC2 can turn a maintainer-labeled issue into a verified pull request. This is an opt-in repository operation, not a general-purpose hosted agent. It is disabled unless the repository variable `OC2_AUTOMATION_ENABLED` is exactly `true`.

The first rollout slice covers issue admission, immutable input capture, isolated generation, patch validation, offline verification, App-owned branch publication, provenance checks, and merge-queue enrollment. It does not let a model merge, push, or rebase `main`. It does not accept arbitrary workflows, repositories, models, commands, or private attachments.

## Current Deployment State

As of July 16, 2026, the `panwar-stack/oc2` repository is not ready to enable this automation:

- `OC2_AUTOMATION_ENABLED` is not configured and therefore defaults to false.
- the App, marker bot user ID, and publisher bot user ID are not configured in the repository;
- repository auto-merge is disabled;
- `main` does not yet require the complete check set or merge queue;
- there is no App-only ruleset for `oc2/issue-*` branches; and
- merge-group ancestry discovery has not been demonstrated against a live queue event.

Keep the kill switch false until the staged rollout checklist is complete. Do not substitute guessed actor IDs or relax a validation when a GitHub plan, API, or ruleset is unavailable.

## Labels And Admission

Opening an issue is a no-write `waiting_for_label` decision and does not run a model or create a marker comment. Exactly one of these labels starts the first durable run:

| Label     | Intended scope                  | Model variant |
| --------- | ------------------------------- | ------------- |
| `task`    | Focused maintenance or bug work | `high`        |
| `feature` | Larger product work             | `xhigh`       |

Admission uses the label event, not only the issue's current label list. The issue must remain open and have exactly one execution label. Adding both labels, changing the event identity, or changing the admitted label event fails closed as `ambiguous_label`.

The current event actor is looked up again through GitHub. A human actor must still be a `User` with `write`, `maintain`, or `admin` repository permission. A `Bot` must have the same current numeric user database ID as the event and appear explicitly in `OC2_ALLOWED_BOT_IDS`. The allowlist is empty by default. It never implicitly includes either the marker bot or publisher bot.

Only content at or before the admitted label event cutoff is captured. Later edits and comments require a new label event and a new idempotency key.

## Identity IDs

GitHub exposes several IDs that are not interchangeable:

| Setting                | Required identity                                                                |
| ---------------------- | -------------------------------------------------------------------------------- |
| `OC2_APP_ID`           | Numeric GitHub App or integration ID                                             |
| `OC2_MARKER_BOT_ID`    | Numeric user database ID of the account that owns the fixed issue marker comment |
| `OC2_PUBLISHER_BOT_ID` | Numeric user database ID of `<app-slug>[bot]`, not the App ID                    |
| `OC2_ALLOWED_BOT_IDS`  | Optional canonical comma-separated numeric user IDs allowed to label issues      |

The marker comment is written with the workflow `GITHUB_TOKEN`, so its current owner must be `github-actions[bot]` (public user database ID `41898282` at the time of this guide), not the human operator returned by `gh api user`. Verify that current public identity and the installation-specific identities before rollout:

```sh
gh api users/github-actions%5Bbot%5D --jq '{id,login,type}'
gh api users/APP-SLUG%5Bbot%5D --jq '{id,login,type}'
gh api apps/APP-SLUG --jq '{id,slug}'
```

Use `gh api user --jq '{id,login,type}'` separately to confirm the current human actor that will apply an execution label. Do not use a login string, installation ID, organization ID, node ID, human operator ID, or App ID where a bot user database ID is required. Rotate the configured IDs if the App or bot identity is replaced.

## GitHub App

Create a dedicated GitHub App for this workflow. Install it only on `panwar-stack/oc2`, not every repository owned by the account. Do not give it organization-wide administration or issue permissions.

The App needs these repository permissions:

| Permission     | Level | Purpose                                                         |
| -------------- | ----- | --------------------------------------------------------------- |
| Metadata       | Read  | Implicit repository identity                                    |
| Contents       | Write | Create or lease-update only the App-owned automation branch     |
| Pull requests  | Write | Open the fixed PR and request exact-head REBASE auto-merge      |
| Administration | Write | Read full ruleset bypass details; never used by the merge token |

The publication token is created for the current repository only. Auto-merge uses two more repository-scoped tokens: a settings token with Administration write, Contents read, and Pull requests read, and a distinct mutation token with Contents read and Pull requests write. GitHub returns ruleset bypass actors only to a caller with ruleset write access; the trusted helper uses that elevated token only for reads and never gives it to `gh`. This permission is a deliberate first-slice tradeoff. The App private key is provided only to the pinned token actions. Installation tokens are not put in remote URLs, artifacts, comments, generated files, or logs, and action post-processing revokes them.

The workflow's ordinary `GITHUB_TOKEN` updates the marker comment and reads provenance. It is not used to publish a branch or enable auto-merge.

## Secrets And Variables

Configure these Actions secrets:

| Secret                | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `OC2_OPENAI_API_KEY`  | Available only to the isolated generation step              |
| `OC2_APP_PRIVATE_KEY` | Private key used only by the pinned GitHub App token action |

Configure these Actions variables:

| Variable                     | Required value                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `OC2_AUTOMATION_ENABLED`     | `false` during setup and incident response; only exact `true` enables issue runs             |
| `OC2_APP_ID`                 | Verified positive App or integration ID                                                      |
| `OC2_MARKER_BOT_ID`          | Verified positive marker-comment bot user ID                                                 |
| `OC2_PUBLISHER_BOT_ID`       | Verified positive App bot user ID                                                            |
| `OC2_ALLOWED_BOT_IDS`        | Optional comma-separated, duplicate-free positive user IDs; empty rejects bot labelers       |
| `OC2_VERSION`                | Exact released OC2 semantic version                                                          |
| `OC2_INSTALLER_SHA256`       | Lowercase SHA-256 of the installer at that version                                           |
| `OC2_ASSET_SHA256_LINUX_X64` | Lowercase SHA-256 of the release's Linux x64 archive                                         |
| `OC2_VERIFY_IMAGE`           | Immutable verifier image reference such as `ghcr.io/panwar-stack/oc2-verify@sha256:<64-hex>` |

Never use `latest`, a branch, or a mutable container tag. Obtain installer, archive, and verifier digests through an independent trusted release channel. Verify the released CLI and its exact installer behavior before changing the repository variables. Rotate a digest only as part of a reviewed release rollout.

## Input And Attachment Limits

The snapshot contains the admitted issue title, body, and at most 100 comments, with a combined text limit of 512 KiB. More than 20 attachment candidates is rejected. At most five unique attachments are retained, each no larger than 5 MiB and no more than 20 MiB in total.

Attachments must be public GitHub attachment or user-image HTTPS URLs accepted by the fixed host and path policy. Downloads omit credentials, reject query-bearing source URLs, limit redirects, reject encoded traversal, and identify supported contents from bytes rather than trusting a filename or response type. Private attachments are not supported. Put no private data, credentials, customer files, or unpublished security material in an automation issue.

Generated patches are limited to 2 MiB, 100 changed files, and 50,000 changed text lines. Symlinks, gitlinks, submodules, rename or copy records, ambiguous Unicode or case-folded paths, traversal, and changes to automation, workflow, configuration, lock, secret-like, or repository-control paths are rejected.

## Installer And Verification Image

Generation downloads the versioned installer over HTTPS, verifies `OC2_INSTALLER_SHA256`, passes the trusted platform archive digest to the installer, and checks the installed CLI's exact version. It runs with isolated home, cache, config, data, state, and temporary directories.

Verification runs the fixed checks in a digest-pinned container with no network, all capabilities dropped, no new privileges, a read-only root filesystem, bounded CPU, memory, processes, files, output, and time. Trusted checks that must regenerate files use an ephemeral copy. Candidate-controlled package tests run from the read-only candidate bind only after a trusted write probe fails; only per-package `.artifacts` tmpfs mounts and fixed caches are writable. Git metadata and dependencies are read-only, and container-declared environment variables or volumes are rejected. Candidate bytes are rechecked after the sandbox finishes.

Slice 1 uses an explicit change allowlist. It can change ordinary docs and specs, `README.md`, `packages/onboarding.md`, browser app source and e2e files under `packages/app`, and UI source and tests under `packages/ui`. It cannot change anything else, including runtime or release packages, installers, root or package scripts, the verifier, workflows, automation agents, repository configuration, lockfiles, or this operations guide. The immutable agent edit policy and shared durable patch policy enforce the same boundary. Expand the allowlist only after extracting and reviewing a smaller immutable TCB.

## Publication And Provenance

Publication reproduces the verified tree from the exact admitted `main` SHA. It creates one deterministic commit and leases only this branch form:

```text
oc2/issue-<issue-number>-<first-12-hex-of-idempotency-key>
```

The App must own the branch commit and the pull request. The fixed PR title and body bind issue number, source workflow run and attempt, base SHA, head SHA, and patch SHA-256. Issue or model text is never copied into the PR.

The `oc2 provenance` workflow runs with top-level `permissions: {}` and read-only job permissions. It executes only the exact `github.workflow_sha` that supplied the trusted workflow, verifies the checkout commit, and treats the PR base and merge-group commits as data. It never checks out or executes a candidate PR or synthetic queue tree. For an automation PR it requires:

- the exact same-repository branch pattern, App bot user ID, base `main`, current API head, and fixed metadata. When GitHub returns `performed_via_github_app`, its ID must also match; the PR REST endpoint normally omits it, so the bot identity and App-only branch ruleset are the durable ownership evidence;
- the successful `verify` job from the exact active `.github/workflows/oc2-issue.yml` workflow ID, run, and attempt in this repository;
- a head commit with exactly the recorded base as its sole parent;
- an exact binary patch digest reproduced from Git; and
- the shared changed-path policy, regular file modes, and size, file, and line limits.

Other PR branch names are a deterministic policy no-op. A name that matches `oc2/issue-*` receives no compatibility fallback when its provenance is malformed.

During `merge_group`, the validator paginates the complete GraphQL merge queue and walks backward uniquely from the event head through `headCommit` and `baseCommit` until it terminates exactly at the event base. It retains each `pullRequest.headRefOid` and fetches the synthetic chain objects without checking them out. Human and fork entries remain metadata-only no-ops; same-repository automation PRs separately fetch and validate their recorded source head. The validator re-reads the complete queue after PR validation and requires the exact chain to be unchanged. It does not use the synthetic branch name, commit ancestry of rebased PR heads, or the empty commit-to-PR REST association to infer members. Missing objects, pagination gaps, duplicate entries, ambiguous chains, changed entries, a changed PR head, or zero matched entries fail closed.

GitHub's live merge queue must demonstrate the exact GraphQL chain and nullable-field behavior before enablement. If the configured queue does not expose a unique chain, leave automation disabled and update the reviewed design. Do not fall back to trusting the event `head_ref`, PR-looking text, expired artifacts, commit associations, or an aggregate diff.

## Branch Rules And Merge Queue

Create exactly two active repository branch rulesets before enabling the workflow. Disabled evaluation rules may remain, but any additional active branch ruleset makes auto-merge unavailable because overlapping ref patterns and bypasses cannot be proven harmless.

The `main` ruleset must target `refs/heads/main` or the default branch and include:

- pull requests required with REBASE as the only allowed method;
- deletion and non-fast-forward updates blocked;
- merge queue required with merge method `REBASE` and grouping strategy `ALLGREEN`;
- one strict, up-to-date required status rule containing exactly the six contexts below; and
- no bypass entry for the publishing App.

Require these exact check contexts after confirming their names from real runs. Bind every context to the GitHub Actions App integration ID `15368` and re-confirm that public App ID before rollout:

| Required context         |
| ------------------------ |
| `typecheck`              |
| `unit (linux)`           |
| `unit (windows)`         |
| `e2e (linux)`            |
| `e2e (windows)`          |
| `provenance/path-policy` |

The separate automation-branch ruleset must target exactly `refs/heads/oc2/issue-*`, have no exclusions, and contain exactly creation, update, deletion, and non-fast-forward restrictions. Configure update with `update_allows_fetch_and_merge: false`. Its only bypass actor must be the configured App integration ID with `always` mode. Do not add users, teams, repository roles, administrators, deploy keys, another App, or another active automation-branch rule.

Repository settings must keep `main` as the default branch, allow auto-merge, and allow rebase merges. Before mutation the trusted helper paginates and reads every active ruleset, checks these settings and exact PR head, repeats the complete settings and ruleset check immediately before mutation, and rejects every `main` bypass. It then performs only:

```sh
gh pr merge PR_NUMBER --repo OWNER/REPOSITORY --auto --rebase --match-head-commit HEAD_SHA
```

The helper re-fetches the PR and requires the same head plus exactly one of a REBASE auto-merge request or matching merge-queue entry. It repeats the complete repository/ruleset validation after enrollment before reporting success. It never calls update-branch, pushes or rebases `main`, directly merges a PR, or falls back to another merge method.

## Artifacts, Logs, And Retention

Admission, trusted helper, issue bundle, generation, and verification artifacts are retained for one day. Jobs delete downloaded and temporary state in `always()` cleanup steps. The durable provenance check intentionally does not depend on those expiring artifacts; it uses the source verify job, immutable App-owned branch, current PR metadata, and exact Git diff.

Do not increase retention to use Actions as private storage. Do not log issue contents, attachments, patches, model output, provider responses, credentials, App keys, or installation tokens. Terminal comments contain only a fixed phase and, where applicable, the PR database ID.

## Phases And Status Codes

These are the pipeline decisions and durable phases. `waiting_for_label` is the no-write opening decision; marker persistence begins at `running`, after admission, and is then machine-owned compare-and-swap state.

| Phase                    | Meaning and operator response                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `waiting_for_label`      | Issue opened; add exactly one execution label when ready                                           |
| `rejected_actor`         | Labeler is not a currently authorized human or explicitly allowed bot                              |
| `ambiguous_label`        | Label event, current label set, or issue state is not uniquely admissible                          |
| `duplicate`              | The exact input already has an active or completed protected run or PR                             |
| `running`                | The admitted run owns the marker                                                                   |
| `input_too_large`        | Snapshot comment or text limits were exceeded                                                      |
| `attachment_rejected`    | Attachment URL, redirect, count, size, or content policy failed                                    |
| `install_failed`         | Versioned installer, digest, archive, or installed version validation failed                       |
| `model_failed`           | Model invocation failed without a narrower trusted classification                                  |
| `permission_denied`      | OC2 denied an attempted generation operation                                                       |
| `tool_failed`            | A fixed generation tool failed                                                                     |
| `no_changes`             | Valid run produced no repository change                                                            |
| `patch_rejected`         | Manifest, patch, file, mode, size, path, or canonical-tree validation failed                       |
| `verification_failed`    | Offline verifier checks or post-check tree validation failed                                       |
| `stale_base`             | `main` no longer equals the admitted base                                                          |
| `push_race`              | Automation branch or PR ownership, lease, metadata, or ref changed concurrently                    |
| `pr_opened`              | Fixed App-owned PR exists; this is an intermediate publication state                               |
| `auto_merge_enabled`     | Exact-head REBASE auto-merge or merge-queue enrollment was revalidated                             |
| `auto_merge_unavailable` | Required repository settings, rules, permissions, head binding, queue state, or mutation is absent |

Earlier pipeline failures take precedence over later skipped jobs. `auto_merge_unavailable` never hides a generation, verification, stale-base, or publication failure.

## Recovery

Do not edit the marker comment. It must remain owned by `OC2_MARKER_BOT_ID` and match the fixed schema.

- For `ambiguous_label`, remove both execution labels and add exactly one in a new label event.
- For input or attachment rejection, remove unsupported or private content, then remove and re-add the intended label.
- For `stale_base`, close and delete an unneeded automation PR and branch if present, then relabel to admit the new `main` SHA.
- For `push_race`, inspect branch, commit, PR author, App provenance, and lease history. Do not overwrite an unowned ref. Delete only after ownership is established, then relabel.
- For conflicts or failing required checks, leave auto-merge disabled for that PR. Fix the underlying repository or source issue and start a fresh labeled run; do not use update-branch or manually push onto the automation branch.
- For `auto_merge_unavailable`, correct repository settings, rulesets, App permissions, or a head race. Close the old PR if it is no longer desired and relabel for a fresh exact base and head.
- For installer, image, or key rotation failures, restore the last independently verified values or complete a reviewed rotation, then relabel.

An exact retry of the same active run is treated as a duplicate. A completed successful `no_changes` or `auto_merge_enabled` result is terminal for the same input. A new label event after content or repository changes creates a new key.

A `running` marker can be recovered only when its recorded Actions attempt has a known failed terminal conclusion, or when both the workflow's last update and marker are older than the six-hour workflow timeout plus a 30-minute grace period. Missing or successful run records are not treated as stale.

After a PR merges or is deliberately abandoned, delete its `oc2/issue-*` branch using an App-authorized, audited operation. Never bulk-delete branches without checking the exact App-owned commit and PR.

## Disable And Incident Response

Set `OC2_AUTOMATION_ENABLED` to `false` first. Exact string comparison makes missing, mixed-case, or other values disabled. Then:

1. Cancel active issue automation runs.
2. Revoke or rotate the App private key and installation if token use may be compromised.
3. Disable auto-merge on untrusted automation PRs without merging or modifying their heads.
4. Preserve GitHub audit, Actions, ruleset, PR, branch, and App installation records.
5. Inspect marker ownership, branch leases, source verify jobs, required checks, and ruleset history.
6. Delete only verified transient artifacts and App-owned branches; do not rewrite `main`.

The provenance and normal CI workflows should remain enabled while issue admission is disabled so existing PRs and queue groups continue to fail closed.

## Staged Enablement

1. Release and independently verify the exact OC2 installer, archive, and verifier image digests.
2. Create the repository-only App, record all current numeric identities, and store the private key.
3. Configure variables with `OC2_AUTOMATION_ENABLED=false`.
4. Create both rulesets, enable REBASE auto-merge and merge queue, and confirm the six exact check contexts on ordinary and synthetic queue commits.
5. Run provenance fixtures for protected paths, malformed metadata, wrong App ownership, exact-head races, pagination, and failed source verification.
6. Exercise a live merge queue and prove that complete pagination plus the exact `baseCommit` to synthetic `headCommit` chain selects every and only member and preserves each `pullRequest.headRefOid`.
7. Run one non-sensitive `task` issue in a controlled repository configuration and inspect cleanup, artifacts, logs, PR metadata, queue state, and audit records.
8. Enable the variable only after two-person review of settings and results.
9. Start with the `task` label and low volume. Expand to `feature` only after the first slice is stable.

Any unmet step keeps the default false. Missing GitHub plan capabilities, unavailable ruleset details, renamed checks, or an unproven merge-group relation are blockers, not reasons to bypass validation.
