# OC2 Repository Rebrand And Trim

## Goal

Complete the in-repo transition from `anomalyco/opencode`, `opencode.ai`, and repo-owned `opencode` names to `panwar-stack/oc2`, `oc2.ai`, and OC2 naming. Keep the work reviewable by separating naming, release URLs, runtime compatibility removal, workflow deletion, script cleanup, repo stripping, specs consolidation, and local `.git` maintenance.

The first pass must favor deterministic cleanup over compatibility. Any remaining legacy `opencode` string must be a reviewed third-party immutable value or a temporary exception with owner, path, and removal PR.

## Current State

- `package.json` is already named `oc2` and points at `https://github.com/panwar-stack/oc2`; stale root aliases `random` and `sso` were removed in PR 7 while `dev:stats` remains until the stats surface is removed.
- `packages/core/src/naming.ts` defines OC2 constants such as `oc2`, `OC2`, `.oc2`, `oc2.json`, and `https://oc2.ai/config.json`, but still keeps `.opencode`, `opencode.json`, `OPENCODE`, `x-opencode-*`, and `opencode.ai` compatibility.
- `packages/opencode/package.json` is named `oc2`, is currently `private: true`, and still exposes a legacy `opencode` binary.
- Repo-owned package names and dependencies still use `@opencode-ai/*` across manifests and imports in areas including `packages/app`, `packages/cli`, `packages/core`, `packages/opencode`, `packages/llm`, `packages/tui`, `packages/enterprise`, `packages/storybook`, `packages/ui`, `packages/web`, `packages/slack`, `packages/http-recorder`, `packages/plugin-legacy`, `packages/sdk-legacy`, and `packages/console/*`.
- `turbo.json` still references `opencode#test`, `@opencode-ai/app#test`, `@opencode-ai/ui#test`, and `OPENCODE_DISABLE_SHARE`.
- Release/install surfaces still reference old ownership: `install`, `github/action.yml`, `.github/workflows/publish.yml`, `.github/workflows/opencode.yml`, `packages/opencode/src/installation/index.ts`, and `packages/opencode/script/publish.ts`.
- Script surfaces are split across `script/`, `packages/*/script/`, `packages/console/*/script/`, `github/script/`, `sdks/vscode/script/`, and `nix/scripts/`.
- CI and generated-artifact scripts are still active: `script/ci-scope.ts`, `script/check-generated.ts`, `script/generate.ts`, `packages/sdk/js/script/build.ts`, `packages/ui/script/tailwind.ts`, `packages/ui/script/build-oc2-v2-overrides.ts`, `script/check-brand.ts`, and `script/package-boundaries.ts`.
- Workflow-only scripts from removed issue, PR management, beta, and stats workflows were removed in PR 7 after confirming current workflows no longer invoke them.
- Confirmed zero-reference setup, benchmark, and recording-report one-offs were removed in PR 7 after checking package manifests, workflows, docs, specs, and direct invocations; package helper, enterprise admin, and Windows signing helpers remain.
- `sdks/vscode/package.json` still uses `opencode` extension metadata and `opencode.*` command IDs.
- `packages/docs/docs.json` still declares `@opencode-ai/docs` and references `https://opencode.ai/openapi.json`; active docs appear to live under `packages/web/src/content/docs`.
- `script/check-brand.ts` and `script/legacy-brand-allowlist.jsonc` exist, but the allowlist is stale and does not enforce the final OC2-only policy.
- Generated outputs include `packages/sdk/openapi.json`, `packages/sdk/js/src/gen`, `packages/sdk/js/src/v2/gen`, `packages/ui/src/styles/tailwind/colors.css`, and `packages/ui/src/theme/themes/oc-2.json`.
- Specs are split between `specs`, `packages/opencode/specs`, and `packages/opencode/prds`. Rebrand/trim specs include `specs/complete-oc2-rebrand.md`, `specs/rename-opencode-to-oc2.md`, `specs/rename-opencode-to-oc2-release-fixes.md`, and `specs/repo-trim-desktop-localization-branding.md`.
- `packages/opencode/AGENTS.md` references `packages/opencode/specs/effect/migration.md`, so package-local Effect specs must not be deleted without updating instructions.
- Local git state has `origin` pointing to `panwar-stack/opencode.git` and `upstream` pointing to `anomalyco/opencode.git`; `.git` cleanup must use git commands, not manual deletion.

## Non-Negotiables

- Replace all source-controlled `anomalyco/opencode` references with `panwar-stack/oc2`.
- Replace `https://opencode.ai` with `https://oc2.ai`.
- Remove repo-owned `opencode-*`, `@opencode-ai/*`, `opencode` binary aliases, `OPENCODE_*` env names, `x-opencode-*` headers, `.opencode`, `opencode.json`, script aliases, and VS Code `opencode.*` IDs by the final rebrand PR.
- Do not rename third-party package names or integration IDs unless the upstream dependency changed.
- Do not manually edit generated SDK/UI artifacts; update source and run generation checks.
- Do not delete `.git` manually. Use dry-run git maintenance commands first.
- Do not mix product deletion, spec deletion, script deletion, and runtime behavior changes in the same PR.
- Do not run release scripts such as `script/publish.ts` locally as verification; they can mutate versions, tags, npm releases, or GitHub releases.
- Do not add source-count stats to the spec, PR body, or review checklist.

## Target Naming Rules

- GitHub slug: `panwar-stack/oc2`.
- Public domain: `https://oc2.ai`.
- Internal scoped packages: `@oc2-ai/<package>`.
- CLI package: one package only, default `oc2`.
- CLI binary: `oc2` only.
- Config paths: `.oc2` and `oc2.json` only.
- Env vars: `OC2_*` only.
- HTTP headers: `x-oc2-*` only.
- VS Code, if retained: OC2 metadata and `oc2.*` command IDs.
- Script names and references: `oc2` only for repo-owned setup, release, publish, build, and developer convenience scripts.
- Brand scanner: fail on repo-owned legacy names; allowlist only third-party immutable strings or historical fixtures.

## Repo Surface Reduction

- Keep `.github/workflows/typecheck.yml` and `.github/workflows/test.yml` as the baseline CI.
- Keep `.github/actions/setup-bun/action.yml` while retained workflows depend on it, or replace those references in the same PR.
- Keep scripts required by retained CI, generated artifacts, package-boundary checks, release, or package builds.
- Delete scripts only after package scripts, workflows, docs, specs, and direct invocations no longer reference them.
- Decide whether release products stay before keeping `publish.yml`, `containers.yml`, `publish-github-action.yml`, `release-github-action.yml`, `publish-vscode.yml`, `nix-eval.yml`, and `nix-hashes.yml`.
- Remove AI/community/stats automation such as `triage.yml`, `duplicate-issues.yml`, `pr-management.yml`, `pr-standards.yml`, `review.yml`, `opencode.yml`, `docs-update.yml`, `generate.yml`, `beta.yml`, `close-issues.yml`, `close-prs.yml`, `compliance-close.yml`, `notify-discord.yml`, and `stats.yml`.
- Remove `STATS.md`; do not replace it with generated summary prose.
- Treat `packages/docs` as removable only after checking workflows, deploy config, package scripts, and hosting references.
- Consolidate top-level rebrand/trim specs into `specs/complete-oc2-rebrand.md`.
- Keep `packages/opencode/specs/effect/*` while `packages/opencode/AGENTS.md` references it.
- Defer deleting major product surfaces such as `packages/app`, `packages/web`, `packages/ui`, `packages/sdk`, `github`, `sdks/vscode`, `infra`, and `nix` until the minimum retained product is decided.

## Failure Modes And Edge Cases

- Package renames must update `package.json`, workspace dependency references, imports, `turbo.json`, lockfiles, generated package metadata, and package-boundary allowlists together.
- Removing legacy config/env/header support is a breaking change; tests must assert OC2-only names and delete migration tests that only preserve old names.
- Release URL changes must update installer code, GitHub Action metadata, publish scripts, and workflow guards in the same slice so releases do not point at mixed repositories.
- Workflow deletion must keep enough CI to run package checks and generated-file checks on pull requests.
- Script deletion must search package scripts and shorthand aliases, not only exact file paths. For example, `build` can mean `bun ./script/build.ts`.
- Unreferenced console scripts can still be production admin tools; require owner review before deleting `packages/console/core/script/*.ts`.
- Generated-file scripts are coupled: deleting either `script/generate.ts` or `script/check-generated.ts` breaks developer or CI workflows.
- `.git` maintenance is local state, not a reviewable source diff; record commands and dry-run output in the PR or maintenance issue instead of committing `.git` changes.

## Implementation Slices

### PR 1: Brand Guardrail

- Update `script/check-brand.ts` and `script/legacy-brand-allowlist.jsonc` to distinguish repo-owned legacy names from external immutable names.
- Make `bun run check:brand` the single brand verification entrypoint.
- Require every temporary legacy exception to include path, owner, reason, and removal slice.
- Do not rename packages or delete scripts in this PR.

Verification:

- `bun run check:brand`
- `git diff --check`

Review:

A fresh read-only sub-agent reviews scanner patterns and allowlist entries for hidden repo-owned `opencode` references.

### PR 2: Workspace Package And Import Rename

- Rename every repo-owned workspace package `name` and dependency from `@opencode-ai/*` to `@oc2-ai/*`.
- Replace repo-owned `opencode-*` package names with `oc2-*`.
- Update imports, workspace dependencies, `turbo.json`, package-boundary config, and lockfiles.
- Leave third-party package names unchanged only when allowlisted by PR 1.
- Include all manifests, including `packages/core`, `packages/opencode`, `packages/llm`, `packages/tui`, `packages/enterprise`, `packages/storybook`, and `packages/console/*`.

Verification:

- `bun install`
- `bun run check:packages`
- `bun run script/package-boundaries.ts --graph`
- `bun turbo typecheck`
- `bun run check:brand`

Review:

A fresh read-only sub-agent reviews stale package/import names and confirms lockfile changes only reflect package renames.

### PR 3: Repository, Domain, Install, And Release URLs

- Replace `anomalyco/opencode` with `panwar-stack/oc2` in installers, release scripts, action metadata, and retained workflows.
- Replace `https://opencode.ai` with `https://oc2.ai` in source docs, package metadata, installer output, action metadata, and release scripts.
- Decide whether `github/action.yml` is retained. If retained, rebrand it with `publish-github-action.yml` and `release-github-action.yml`; if removed, delete all action release workflows together.
- Remove publishing to `opencode-ai` and old `ghcr.io/anomalyco/*` targets.
- If publishing `packages/opencode`, decide whether to remove `private: true` and publish only the selected OC2 package name.

Verification:

- `bun run check:brand`
- `bun run check:packages`
- `bun turbo typecheck`
- `git diff --check`

Review:

A fresh read-only sub-agent reviews release/install files for mixed old/new repository or domain references.

### PR 4: Runtime OC2-Only Names

- Update `packages/core/src/naming.ts` to remove legacy config, env, header, and domain aliases.
- Remove the `opencode` binary from `packages/opencode/package.json`; keep only `oc2`.
- Rename `OPENCODE_*` to `OC2_*` and `x-opencode-*` to `x-oc2-*` across source, tests, scripts, workflows, and `turbo.json`.
- Update source schemas that feed generated SDK/UI files, then regenerate through repo commands.
- Delete tests that only preserve old-name compatibility; add OC2-only assertions where behavior matters.

Verification:

- `bun run check:generated`
- `bun run check:brand`
- `bun turbo typecheck`
- Working directory `packages/opencode`: `bun test`

Review:

A fresh read-only sub-agent checks generated diffs are source-backed and no hidden compatibility alias remains.

### PR 5: VS Code Surface Decision

- If `sdks/vscode` is retained, rename extension metadata, commands, settings, docs, package names, and lockfile references from `opencode` to OC2.
- If `sdks/vscode` is not retained, delete `sdks/vscode` and remove related workflows such as `publish-vscode.yml`.
- Do not leave VS Code `opencode.*` command IDs in either path.

Verification:

- Working directory `sdks/vscode`: `bun install --frozen-lockfile`
- Working directory `sdks/vscode`: `bun typecheck`
- `bun run check:brand`

Review:

A fresh read-only sub-agent verifies no VS Code metadata, commands, or workflow references still use legacy names.

### PR 6: Workflow Simplification

- Keep `typecheck.yml` and `test.yml`; update triggers to the repository's real main branch, `master`.
- Preserve or replace `./.github/actions/setup-bun` references before deleting any local action.
- Remove AI, issue-management, docs automation, stats, and community workflows that are not required for build, test, or selected release products.
- Classify `containers.yml`, `deploy.yml`, `nix-eval.yml`, `nix-hashes.yml`, `publish.yml`, `publish-github-action.yml`, `release-github-action.yml`, `publish-vscode.yml`, and `storybook.yml` as retained, deleted, or deferred in the PR description.
- Remove unused `.github/actions/*`, issue templates, PR templates, `CODEOWNERS`, and `TEAM_MEMBERS` only after retained workflow references are updated.

Verification:

- `bun run check:packages`
- `bun run check:generated`
- `bun turbo typecheck`
- `git diff --check`
- `rg -n "opencode|anomalyco|OPENCODE|setup-bun|uses:" .github`

Review:

A fresh read-only sub-agent reviews retained workflow YAML for stale names, missing local actions, wrong branch triggers, and unavailable secrets/actions.

### PR 7: Brutal Script Surface Cleanup

- Inventory every script reference from root `package.json`, workspace package manifests, `.github/workflows`, docs, specs, and direct invocations before deleting files.
- Keep CI/build/generated guardrails: `script/ci-scope.ts`, `script/check-brand.ts`, `script/legacy-brand-allowlist.jsonc`, `script/check-generated.ts`, `script/generate.ts`, `script/package-boundaries.ts`, `packages/sdk/js/script/build.ts`, `packages/ui/script/tailwind.ts`, and `packages/ui/script/build-oc2-v2-overrides.ts`.
- Keep release/build scripts only for retained release surfaces: `script/version.ts`, `script/changelog.ts`, `script/publish.ts`, `packages/opencode/script/build.ts`, `packages/opencode/script/publish.ts`, `packages/cli/script/build.ts`, `packages/cli/script/publish.ts`, `packages/sdk/js/script/publish.ts`, `packages/plugin/script/publish.ts`, `packages/containers/script/build.ts`, `github/script/*`, `sdks/vscode/script/*`, and `nix/scripts/*`.
- Keep package-script-invoked maintenance scripts unless their package alias is removed in the same PR: `script/upgrade-opentui.ts`, `packages/console/app/script/generate-sitemap.ts`, `packages/opencode/script/schema.ts`, `packages/opencode/script/httpapi-exercise.ts`, `packages/core/script/fix-node-pty.ts`, `packages/http-recorder/script/build.ts`, `packages/http-recorder/script/verify-package.ts`, and `packages/llm/script/setup-recording-env.ts`.
- PR 7 removed confirmed zero-reference one-offs `script/setup-opencode-alias.sh`, `packages/opencode/script/bench-search.ts`, and `packages/llm/script/recording-cost-report.ts`; retained `packages/http-recorder/script/pack.ts` because `verify-package.ts` imports it and deferred `script/sign-windows.ps1` plus `packages/enterprise/script/scrap.ts` pending owner decisions.
- PR 7 removed workflow-only scripts after confirming PR 6 had removed the workflows that invoked them.
- PR 7 removed root package aliases `random` and `sso`; `dev:stats` remains because stats docs still reference it and stats product removal is out of scope.
- Defer `packages/console/core/script/*.ts` until console ownership confirms whether they are production admin tools.
- Defer package-local migration, benchmark, and developer/debug helpers such as `packages/core/script/migration.ts`, `packages/opencode/script/bench-test-suite.ts`, `packages/opencode/script/profile-test-files.ts`, `packages/opencode/script/time.ts`, `packages/opencode/script/trace-imports.ts`, `packages/opencode/script/fetch-team-report.sh`, and `packages/opencode/script/run-workspace-server` unless package aliases and docs/spec references are removed.
- Update docs/specs when a script path is deleted or renamed.

Verification:

- `rg --hidden -n "script/|scripts/" --glob '!node_modules/**' --glob '!bun.lock'`
- `bun run check:brand`
- `bun run check:packages`
- `bun run check:generated`
- `bun turbo typecheck`
- `bun --cwd packages/opencode build`
- `bun --cwd packages/sdk/js build`
- `bun --cwd packages/cli build`

Review:

A fresh read-only sub-agent reviews deleted scripts against package manifests, workflows, docs, specs, and generated-artifact paths. The reviewer must flag deleted admin/release scripts without an owner decision and must not run publish scripts.

### PR 8: Repo Strip And Specs Consolidation

- Make `specs/complete-oc2-rebrand.md` the canonical rebrand/trim spec.
- Fold current tasks from `specs/rename-opencode-to-oc2.md`, `specs/rename-opencode-to-oc2-release-fixes.md`, and `specs/repo-trim-desktop-localization-branding.md`.
- Delete old rebrand specs after consolidation unless reviewers require short tombstones.
- Remove `packages/docs` only after checking `docs-update.yml`, `deploy.yml`, package scripts, hosting config, and docs references.
- Remove `STATS.md` and confirmed nonessential prose/editor-local files.
- Keep `packages/opencode/specs/effect/*` and update `packages/opencode/AGENTS.md` before moving or deleting package-local specs.

Verification:

- `git ls-files 'specs/**' 'packages/opencode/specs/**' 'packages/opencode/prds/**' 'packages/docs/**'`
- `rg -n "specs/|packages/opencode/specs|PRD|prds|complete-oc2-rebrand|rename-opencode-to-oc2|repo-trim" README.md AGENTS.md packages/opencode/AGENTS.md packages/opencode/README.md package.json packages/*/package.json .github packages/web/src/content/docs packages/docs`
- `bun run check:brand`
- `bun run lint`

Review:

A fresh read-only sub-agent checks deleted docs/specs against references and confirms no active instruction file points to a missing spec.

### PR 9: Local Git Maintenance

- Run after source cleanup PRs are merged or parked; do not mix `.git` maintenance with source diffs.
- Record baseline output from `git status --short --branch`, `git remote -v`, and `git worktree list --porcelain`.
- Update `origin` to `https://github.com/panwar-stack/oc2.git` if the repository has moved.
- Remove or retarget `upstream` from `anomalyco/opencode` unless intentionally kept for archaeology.
- Run `git worktree prune --dry-run`, `git remote prune origin --dry-run`, and, if kept, `git remote prune upstream --dry-run`.
- After confirming no active worktree is needed, run `git worktree prune`, `git remote prune origin`, and `git gc --prune=now`.
- Do not delete local branches automatically; list merged branches for owner-approved deletion.

Verification:

- `git status --short --branch`
- `git remote -v`
- `git worktree list --porcelain`
- `git fsck --connectivity-only`

Review:

A fresh read-only reviewer checks recorded command output and confirms no active worktree, branch, or remote needed for current work was removed.

## Future Work

- Remove major surfaces such as `github`, `sdks/vscode`, `infra`, `nix`, `perf`, `packages/app`, or `packages/web` only after defining the minimum supported OC2 product.
- Add a release smoke test that installs OC2 from the selected package and verifies `oc2 --version` without any legacy binary.

## Open Questions

- What is the minimum retained product surface? Default: keep CLI/TUI/core SDK and active web docs first.
- Should legacy config/env/header compatibility be removed immediately? Default: yes, because the requirement says no more repo-owned `opencode` names.
- Should release, VS Code, GitHub Action, container, and Nix scripts stay? Default: keep only for retained release products; delete the rest with their workflows or product surface.
- Should console admin scripts under `packages/console/core/script` stay? Default: defer deletion until a console owner classifies each as production admin, dev-only, or obsolete.
- Should old rebrand specs be deleted or tombstoned? Default: delete after current tasks are folded into `specs/complete-oc2-rebrand.md`.
- Should the public npm package be `oc2` or `oc2-ai`? Default: use one public CLI package, preferably existing `oc2`; use `@oc2-ai/*` only for internal scoped packages.
- Should `upstream` to `anomalyco/opencode` remain? Default: remove after `origin` points to `panwar-stack/oc2`.
