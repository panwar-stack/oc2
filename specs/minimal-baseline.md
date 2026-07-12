# Fresh Minimal Baseline

## Goal

Establish a smaller, local-first OC2 baseline by removing proven hosted-product drift, fixing canonical configuration behavior, deleting demonstrably stale dependency patches, and locking the contracts that later runtime cleanup must preserve.

The first pass must be incremental and compatibility-preserving. It must not treat the active V1/V2 overlap, broad provider support, migration history, or large files as dead code. Those areas may be simplified only after their consumers and migration requirements are made explicit and verified.

## Current State

- `README.md` describes a local harness without a hosted app fallback, but `packages/opencode/src/server/shared/ui.ts` proxies missing UI assets to `https://app.oc2.ai`.
- `packages/opencode/src/server/cors.ts` implicitly trusts hosted OC2 and OpenCode origins in addition to local and explicitly configured origins.
- Built binaries embed browser assets through `packages/opencode/script/build.ts`; source UI development already has separate backend and Vite instructions in `README.md` and `packages/app/AGENTS.md`.
- Canonical naming in `packages/core/src/naming.ts` uses `.oc2`, `oc2.json`, `oc2.jsonc`, and `OC2_*`, while `Config.update` in `packages/opencode/src/config/config.ts` writes `config.json`, which canonical discovery does not reload.
- `packages/core/src/config.ts` currently includes `.oc2` twice in its discovery targets. The focused Core config suite has three failing expectations around the partially removed legacy names.
- Ordinary reads in `packages/opencode/src/config/config.ts` can add `$schema`, seed global configuration, or persist TOML migration output. `packages/opencode/src/config/tui-migrate.ts` can rewrite and back up source files during migration.
- `.well-known/oc2` is used for explicit provider interoperability in `packages/opencode/src/cli/cmd/providers.ts` and must not be confused with the hosted browser fallback.
- Local `/doc` and public schema compatibility are mounted by `packages/opencode/src/server/routes/instance/httpapi/server.ts` and rewritten by `packages/opencode/src/server/routes/instance/httpapi/public.ts` for current clients.
- V2 prompt admission and execution live in `packages/core/src/session.ts`, `packages/core/src/session/execution/local.ts`, and `packages/core/src/session/runner/llm.ts`.
- V2 still depends on V1 session, message, part, permission, event, and config shapes through `packages/core/src/session.ts`, `packages/core/src/session/projector.ts`, `packages/core/src/session/sql.ts`, and `packages/core/src/config.ts`.
- `packages/opencode/src/server/routes/instance/httpapi/server.ts` mounts both the legacy local routes and the reusable `@oc2-ai/server` `/api` routes. App, TUI, ACP, SDK, and public HTTP consumers have not all cut over to one contract.
- `packages/core/package.json` and `packages/opencode/package.json` each declare the broad `@ai-sdk/*` provider set. Both source trees actively use those dependencies.
- `packages/opencode/src/session/llm.ts` keeps the native runtime opt-in, falls back for unsupported routes, and otherwise uses AI SDK. The Core runner cannot yet replace the legacy provider surface without parity work.
- `packages/core/src/models-dev.ts` provides useful model and provider information through the existing models.dev snapshot, cache, refresh, override, and canonicalization flow.
- Root `package.json` declares nine patched dependencies. Exact installed-version inspection found three stale entries: `@standard-community/standard-openapi@0.2.9`, `gcp-metadata@8.1.2`, and `pacote@21.5.0`.
- Core owns active database migration execution through `packages/core/src/database/migration.ts` and `packages/core/migration`. `packages/opencode/migration` is legacy, but it must be removed only after an upgrade-path test proves it is not required.
- Both browser layout generations remain reachable through `packages/app/src/pages/layout.tsx`. `packages/app/playwright.config.ts` currently defines desktop Chromium only.
- Large-file splitting, repository-wide type cleanup, package merging, and broad Bun process rewrites mix unrelated behavior and are not safe baseline deletions.
- `packages/opencode/src/command/template/spec-implement.txt` tells `/spec:implement` to edit, test, review, and commit without first isolating those changes from the checkout that invoked the command.

## Non-Negotiables

- Retain the local TUI, browser app, server, JS SDK, plugin API, workspaces, shared tasks, provider authentication, provider-hosted tools, and all currently reachable providers in the first pass.
- Remove implicit OC2-hosted browser fallback and origin trust. Do not block user-selected provider traffic, provider OAuth, MCP traffic, `.well-known/oc2`, or explicitly configured CORS origins.
- Preserve local `/doc` and current public API compatibility until all SDK, app, TUI, ACP, and plugin consumers have migrated.
- Preserve V1 config read compatibility and V1-to-V2 in-memory normalization. New writes must use canonical OC2 names.
- Configuration reads must be side-effect free. Only an explicit update or migration action may write user files.
- Preserve existing databases and append-only Core migration history by default. Do not squash migrations or silently reset user data.
- Preserve the V2 Session contract: durable prompt admission is separate from execution; advisory wakes only drain eligible inbox items; same-session resumes join; wakes coalesce; different sessions may run concurrently.
- Keep runner, model, tools, permissions, and filesystem location-scoped. Do not bridge V2 execution through `SessionPrompt.loop`.
- Use one `llm.stream(request)` per provider turn and reload projected history before durable continuation.
- Keep process-scoped `ApplicationTools`, location-scoped `ToolRegistry`, authorization in built-in tool leaves, and one canonical tool settlement boundary.
- Preserve the existing models.dev integration as a runtime source of model and provider information. Deterministic tests may use checked-in snapshots, but this baseline must not remove, replace, or otherwise change the production fetch, cache, refresh, override, or canonicalization behavior.
- Do not remove provider dependencies or live patches until the replacement runtime is the default, fallback has been removed, and provider parity is verified.
- Do not combine feature deletion, migration, dependency pruning, generated-client updates, branding, type cleanup, or monolith splitting in one slice.
- Regenerate SDK artifacts from source. Do not hand-edit generated clients.
- New or materially changed browser behavior must load in desktop and mobile Chromium.
- Type safety is a touched-file ratchet. Do not introduce new `any`, `Schema.Any`, or unexplained `@ts-expect-error` in changed handwritten files.
- `/spec:implement` must perform implementation in a dedicated git worktree and must not edit, stash, reset, clean, merge into, or otherwise mutate the checkout that invoked the command.

## Baseline Product Boundary

| Surface                                                                    | First-Pass Decision                                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Embedded browser app                                                       | Retain. Serve only local embedded assets in built binaries.                                        |
| Missing browser bundle                                                     | Return an explicit local error. Never proxy to a managed OC2 site.                                 |
| Source browser development                                                 | Retain the separate backend plus Vite flow documented in `README.md` and `packages/app/AGENTS.md`. |
| Hosted OC2/OpenCode CORS entries                                           | Remove implicit trust.                                                                             |
| `--cors` and local/same-host origins                                       | Retain.                                                                                            |
| Provider network access and OAuth                                          | Retain.                                                                                            |
| `.well-known/oc2` provider discovery                                       | Retain only the canonical OC2 path.                                                                |
| Local `/doc` and public OpenAPI compatibility                              | Retain until client cutover.                                                                       |
| Managed changelog, docs, icons, free-model, subscription, and Discord copy | Remove or replace with repository-local help and assets.                                           |
| V1 config reads and schema migration                                       | Retain in memory.                                                                                  |
| V1 public/session/storage compatibility                                    | Retain until the gated cutover described below.                                                    |
| Current provider breadth                                                   | Retain.                                                                                            |
| models.dev model and provider information                                  | Retain the existing integration unchanged.                                                        |
| Core migration history                                                     | Retain unchanged.                                                                                  |

## Configuration Contract

Server configuration is deep-merged from lowest to highest priority:

| Priority | Source                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1        | Embedded and fetched `.well-known/oc2` configuration.                                                                                                  |
| 2        | `Global.Path.config`: `oc2.json`, then `oc2.jsonc`, then legacy global TOML normalized in memory.                                                      |
| 3        | `OC2_CONFIG`.                                                                                                                                          |
| 4        | Direct project files from worktree boundary to routed directory, root-first; `oc2.json`, then `oc2.jsonc` in each directory.                           |
| 5        | Project `.oc2` directories in the current opencode order, nearest first and outer ancestors afterward; `oc2.json`, then `oc2.jsonc` in each directory. |
| 6        | Home `.oc2`.                                                                                                                                           |
| 7        | `OC2_CONFIG_DIR`: `oc2.json`, then `oc2.jsonc`.                                                                                                        |
| 8        | `OC2_CONFIG_CONTENT`.                                                                                                                                  |
| 9        | System-managed `oc2.json`, then `oc2.jsonc`.                                                                                                           |
| 10       | macOS managed preferences.                                                                                                                             |

Later sources override earlier sources, so JSONC overrides JSON in the same directory. Core currently traverses ancestor `.oc2` directories root-first while opencode traverses them nearest-first. Do not silently align those behaviors in this work; any alignment requires a separate behavior change and conflicting-ancestor tests.

`PATCH /config` must mutate only the last existing project-owned canonical document in the opencode merge plan, considering direct project and project `.oc2` files only. Global, home, environment-selected, remote, virtual, managed, and non-selected project sources are read-only. If no project-owned canonical file exists, create `<routed-directory>/oc2.json`.

`PATCH /global/config` must update `Global.Path.config/oc2.jsonc` when it exists, otherwise update `Global.Path.config/oc2.json`, otherwise create `Global.Path.config/oc2.jsonc`. It must never target project, home, environment-selected, remote, managed, or legacy TOML sources.

Both PATCH endpoints must merge only the request payload into the selected source, not serialize resolved configuration. JSONC edits must preserve comments and unrelated formatting through `jsonc-parser`; JSON uses two-space indentation. Preserve existing `$schema`, never synthesize it, and write atomically so a failure preserves original bytes. Target selection must use the loader's ordered source plan rather than duplicate precedence logic.

Parsing, validating, normalizing, and merging must not create, modify, rename, or delete configuration source files. Protected sources include `oc2.json`, `oc2.jsonc`, `tui.json`, `tui.jsonc`, legacy TOML, migration backups, and environment-selected files. This guarantee does not cover plugin activation artifacts such as `.gitignore`, package manifests, lockfiles, `node_modules`, or installed plugins; moving plugin preparation out of config access is future work.

Existing V1 configuration must be decoded and normalized in memory through `packages/core/src/v1/config/migrate.ts`. Invalid input must report its source path without modifying protected sources.

Legacy TUI extraction must become a pure reader returning:

```ts
type LegacyTuiInfo = Pick<TuiConfig.Info, "theme" | "keybinds" | "scroll_speed" | "scroll_acceleration" | "diff_style">

type LegacyTuiContribution = {
  source: string
  directory: string
  info: LegacyTuiInfo
}
```

`TuiConfig.loadState` must merge contributions before `TuiConfig.resolve`. Within one directory, precedence is legacy `oc2.json`, legacy `oc2.jsonc`, explicit `tui.json`, then explicit `tui.jsonc`. Cross-directory precedence follows the existing TUI source plan. `OC2_CONFIG` legacy values apply after global TUI files and before project TUI files; `OC2_TUI_CONFIG` remains the explicit override before project files. Do not infer a sibling TUI file from `OC2_CONFIG`.

The pure reader must inspect global canonical config, direct project canonical config, discovered project and home `.oc2` config, `OC2_CONFIG_DIR`, and `OC2_CONFIG`. It must extract top-level `theme` and `keybinds` plus legacy `tui.scroll_speed`, `tui.scroll_acceleration`, and `tui.diff_style`. Decode fields independently, drop invalid or unknown legacy TUI fields, and report the source path for each invalid field without discarding valid fields from that source.

## Hosted Boundary And Error Behavior

- `packages/opencode/src/server/shared/ui.ts` must not issue a request to `app.oc2.ai` or any other managed UI origin.
- When embedded assets are disabled or unavailable, browser UI requests must return `503` with a local-development message that points to the separate backend plus Vite flow.
- When embedded assets exist but a requested asset does not, the server must return `404` and must not make an outbound request.
- CORS must continue to allow requests without `Origin`, local loopback origins, the serving host, and origins explicitly supplied through `--cors`.
- CORS must reject hosted OC2/OpenCode domains unless they were explicitly supplied through `--cors`.
- `/doc`, API routes, and `.well-known/oc2` behavior must not change in the hosted-boundary slice.

## Session And Runtime Cutover Gates

The first pass does not authorize V1 deletion or provider pruning. Each later cutover must satisfy these gates in order:

1. Lock prompt admission, exact retry, coordinator, interrupt, runner, location, tool, permission, and public HTTP behavior with tests.
2. Add direct `/api` integration coverage for permission request, list, and reply behavior.
3. Define V2-owned session, message, part, event, permission, and config schemas without changing persisted or public shapes.
4. Migrate every app, TUI, ACP, SDK, plugin, and HTTP consumer to the retained API before removing legacy routes.
5. Demonstrate provider parity for every retained provider before changing the default runtime.
6. Add a forward Core migration and upgrade fixtures before removing a legacy table or stored field.
7. Regenerate the JS SDK and pass public-schema drift checks after any API change.
8. Remove V1 modules, legacy routes, runtime fallback, and duplicated dependencies only after static search and package-scoped tests show no consumers.

The default policy is compatibility-preserving migration. A destructive fresh-database cutover requires a separate approved spec with an explicit user-data impact statement, reset behavior, and destructive-path verification.

## Dependency And Patch Policy

- Remove only the three patch entries whose exact versions are absent from the current lock/install graph: `@standard-community/standard-openapi@0.2.9`, `gcp-metadata@8.1.2`, and `pacote@21.5.0`.
- Keep the six live patches until their owning behavior is removed or upstream parity is demonstrated with targeted tests.
- Regenerate the `solid-js` patch without accidental absolute `.bun-tag-*` entries in a separate slice; do not mix that cleanup with stale patch deletion.
- Do not deduplicate the provider manifests while Core and opencode both execute provider-specific code.
- Verify dependency changes through a clean frozen install because workspace hoisting can hide undeclared dependencies.
- Keep package consolidation, root dependency reclassification, SDK process-launcher deduplication, and app/Core process abstraction changes out of the first pass.

## Deterministic Completion Checks

- No production browser-app path contains an implicit request to `app.oc2.ai`.
- Hosted OC2/OpenCode origins are not accepted by CORS unless explicitly configured.
- A canonical config PATCH survives a fresh disk reload and does not create `config.json`.
- Loading every supported config format leaves protected configuration sources byte-for-byte unchanged and does not change their modification times.
- The Core config suite has no pre-existing legacy-name failures.
- The three stale patch versions do not appear in `package.json`, `bun.lock`, or `patches/`.
- Desktop and mobile Chromium can load the retained browser shell.
- V2 contract tests and the new permission HTTP integration tests pass before any legacy cutover work begins.
- Each implementation slice has a fresh read-only diff review against its frozen plan and touched-file manifest.
- A `/spec:implement` run leaves the invoking checkout byte-for-byte unchanged and reports the isolated worktree path, branch, base SHA, and created commits.

## Review Protocol

Before implementation, each slice must record `base_sha`, the intended files, generated or lockfile changes, migration impact, and exact verification commands. Use `origin/master` rather than a local `main` branch for the final cumulative comparison.

Before a slice is checked off, a fresh read-only teammate or sub-agent must inspect the candidate without modifying it and run:

```bash
git status --short
git diff --check <base_sha> <candidate_sha>
git diff --stat <base_sha> <candidate_sha>
git diff --name-status <base_sha> <candidate_sha>
git diff --find-renames <base_sha> <candidate_sha> -- <manifest-paths>
```

Approval is blocked by unplanned files, undeclared generated/lock/patch/migration changes, compatibility or data-loss changes, mixed behavioral axes, unexplained type-safety regressions, or missing targeted verification. Final integration must repeat the review for `origin/master..<candidate_sha>`.

## Spec Implementation Isolation Contract

`/spec:implement` must resolve and read the requested spec before creating one dedicated worktree for the command invocation. It must record the invoking checkout path and status, use the invoking checkout's committed `HEAD` as `base_sha`, create a unique implementation branch and worktree outside that checkout, and perform every edit, generation step, test, review, and commit from the isolated worktree. When no PR number is supplied, all sequential PR slices run in that same worktree so each committed slice becomes the base for the next.

The command must never stash, reset, clean, switch, edit, merge into, or cherry-pick into the invoking checkout. Uncommitted or untracked files there, including the requested spec, remain read-only inputs and must not be copied into the implementation diff unless the selected slice explicitly requires them. If implementation depends on other uncommitted source changes, the command must stop and report the dependency instead of importing or mutating those changes.

Successful completion must leave the worktree and branch available for inspection and report their paths, `base_sha`, final status, and commits. Cleanup or integration into another checkout requires a separate explicit request. Failure must preserve both checkouts and report the isolated worktree state; it must not discard partial work automatically.

## Implementation Slices

### PR 0: Isolate Spec Implementation Changes

- Update `packages/opencode/src/command/template/spec-implement.txt` to enforce the Spec Implementation Isolation Contract before any implementation begins.
- Preserve `$1` and `$2` argument behavior and the existing one-slice or sequential-slice execution rules.
- Make the template require a unique branch and worktree rooted at the invocation's committed `HEAD`, with all implementation commands executed from that worktree.
- Explicitly prohibit mutation of the invoking checkout and automatic cleanup, merge, or cherry-pick behavior.
- Require the final response to identify the worktree, branch, base SHA, commits, verification results, and remaining worktree status.
- Add command-template coverage that locks the isolation requirement without executing real worktree lifecycle operations.

Verification:

- `cd packages/opencode && bun test test/command/command.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh reviewer who did not author the slice must inspect it read-only and verify that the command cannot direct edits into the invoking checkout, does not hide dirty state through stash/reset/clean, preserves existing arguments and slice sequencing, and leaves integration and cleanup explicit.

### PR 1: Stabilize Canonical Config Persistence

- Remove the duplicate `.oc2` discovery target in `packages/core/src/config.ts`.
- Reconcile Core config tests with the canonical names in `packages/core/src/naming.ts`; do not restore `config.json` discovery.
- Make `/config` select only the last project-owned canonical source in the existing opencode merge plan, or create `<routed-directory>/oc2.json` when none exists.
- Make `/global/config` select global JSONC, then global JSON, then create global JSONC.
- Preserve JSONC comments, existing `$schema`, and unrelated target content; write atomically and never serialize resolved values from read-only sources.
- Add table-driven target tests for JSON-only, JSONC-only, both files, root/nested/`.oc2` conflicts, no existing file, and failed writes.
- Add HTTP tests proving both PATCH endpoints, instance disposal, and disk reload observe the updated target while every non-selected source remains byte-identical.
- Add explicit opencode precedence coverage without changing Core's existing conflicting-ancestor behavior.
- Add one sentinel-value test covering every opencode source tier; remove the highest tier one at a time and assert the next tier wins.
- Assert a no-op `/global/config` PATCH does not dispose the instance or rewrite bytes.

Verification:

- `cd packages/core && bun test test/config/config.test.ts`
- `cd packages/core && bun typecheck`
- `cd packages/opencode && bun test test/config/config.test.ts test/server/httpapi-config.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh reviewer who did not author the slice must inspect it read-only and run the Review Protocol against the recorded SHAs and manifest. Reject changes to hosted behavior, V1 schema compatibility, read-only sources, loader precedence, or unrelated config fields.

### PR 2: Make Config Loading Side-Effect Free

- Stop automatic `$schema` insertion and persistence in `packages/opencode/src/config/config.ts`.
- Stop ordinary reads from seeding global config or writing TOML migration output.
- Replace mutation-based TUI migration with pure `LegacyTuiContribution[]` extraction.
- Merge legacy TUI contributions in `TuiConfig.loadState` with the exact precedence defined in Configuration Contract.
- Preserve legacy read compatibility and existing user `$schema` values.
- Add byte and modification-time assertions for every protected source instead of claiming plugin activation is filesystem-side-effect free.
- Use `NpmTest.noop` so source-immutability tests do not install plugin dependencies.

Verification:

- `cd packages/opencode && bun test test/config/config.test.ts test/config/tui.test.ts`
- `cd packages/opencode && bun test test/config/tui-migrate.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh reviewer who did not author the slice must inspect it read-only and run the Review Protocol against the recorded SHAs and manifest. Reject removed read compatibility, protected-source mutation, TUI precedence drift, or plugin lifecycle changes.

### PR 3: Remove Hosted Browser Fallback And Origin Trust

- Remove the managed UI proxy from `packages/opencode/src/server/shared/ui.ts`.
- Implement deterministic local `503` and missing-asset `404` behavior without outbound fetches.
- Remove implicit hosted-domain entries from `packages/opencode/src/server/cors.ts` while preserving local, same-host, no-Origin, and explicit `--cors` behavior.
- Update `README.md` and `packages/app/README.md` to describe embedded production assets and the separate backend plus Vite development flow.
- Add tests that fail if the missing-bundle or missing-asset paths attempt network access.

Verification:

- `cd packages/opencode && bun test test/server/hosted-url.test.ts test/server/httpapi-ui.test.ts test/server/httpapi-cors.test.ts test/server/httpapi-instance.test.ts test/cli/plugin-auth-picker.test.ts`
- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun run build --single --skip-install`

Review:

Apply the mandatory read-only gate. The reviewer must verify `/doc`, `.well-known/oc2`, provider egress, and explicit `--cors` are unchanged.

### PR 4: Add Mobile Browser Coverage

- Add a `mobile-chromium` project to `packages/app/playwright.config.ts` using a Playwright mobile device profile.
- Add or adapt a smoke test that loads the application shell, opens retained navigation, and checks that no fatal overflow blocks primary controls.
- Keep the existing desktop Chromium project and run both projects in CI.
- Do not delete either layout generation in this slice.

Verification:

- `cd packages/app && bun run test:e2e -- --project=chromium`
- `cd packages/app && bun run test:e2e -- --project=mobile-chromium`
- `cd packages/app && bun typecheck`

Review:

Apply the mandatory read-only gate. The reviewer must inspect desktop and mobile artifacts and reject layout deletion or unrelated visual redesign.

### PR 5: Remove Managed Client Egress

- Replace remote notification icons and other managed assets in `packages/app/src/entry.tsx` with repository-local assets.
- Remove the managed changelog request from `packages/app/src/context/highlights.tsx`.
- Replace managed docs and Discord destinations in the app and TUI with maintained repository-local help, or remove the link when no local target exists.
- Do not change product claims, prompt prose, brand allowlists, or build/release metadata in this slice.
- Do not remove provider OAuth, provider-hosted tools, MCP, workspace, or repository network behavior.

Verification:

- `cd packages/app && bun run test:unit`
- `cd packages/app && bun typecheck`
- `cd packages/app && bun run build`
- `cd packages/app && bun run test:e2e -- --project=chromium --project=mobile-chromium`
- `cd packages/tui && bun test`
- `cd packages/tui && bun typecheck`
- `test -z "$(rg -n 'https://oc2\.ai/(changelog\.json|favicon-96x96-v3\.png|favicon\.svg|discord|docs)' packages/app/src packages/tui/src)"`

Review:

A fresh reviewer who did not author the slice must inspect it read-only and run the Review Protocol against the recorded SHAs and manifest. Reject product-copy, build-script, provider-network, or unrelated visual changes.

### PR 6: Correct Managed Product Copy

- Remove false free-model, subscription, and unsupported MCP-authentication claims from app and UI translations, TUI copy, and prompt text.
- Describe retained behavior only when it is verified by the current provider and MCP implementations.
- Keep technical identifiers such as `OpenCodeHttpApi` and persisted theme IDs unchanged.
- Do not change URLs, fetch behavior, assets, or build/release metadata in this slice.

Verification:

- `cd packages/app && bun run test:unit`
- `cd packages/app && bun typecheck`
- `cd packages/app && bun run test:e2e -- --project=chromium --project=mobile-chromium`
- `cd packages/tui && bun test`
- `cd packages/tui && bun typecheck`
- `cd packages/ui && bun test`
- `cd packages/ui && bun typecheck`
- `cd packages/opencode && bun typecheck`
- `test -z "$(rg -n -i 'free models|oc2 does not support mcp authentication' packages/app/src packages/tui/src packages/ui/src packages/opencode/src/session/prompt)"`

Review:

A fresh reviewer who did not author the slice must inspect it read-only and run the Review Protocol against the recorded SHAs and manifest. Reject behavior, URL, asset, release metadata, technical identifier, or unrelated translation changes.

### PR 7: Remove Managed Build And Release Metadata

- Remove hosted documentation metadata from `packages/opencode/script/build.ts` and `packages/opencode/script/publish.ts`.
- Do not change runtime serving, product copy, app assets, dependencies, or publishing behavior beyond the removed managed metadata.

Verification:

- `test -z "$(rg -n 'https://oc2\.ai/docs' packages/opencode/script/build.ts packages/opencode/script/publish.ts)"`
- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun run build --single --skip-install`

Review:

A fresh reviewer who did not author the slice must inspect it read-only and run the Review Protocol against the recorded SHAs and manifest. Reject runtime, product-copy, dependency, or unrelated release changes.

### PR 8: Remove Stale Patch Entries

- Remove the three stale `patchedDependencies` entries from root `package.json`.
- Delete only the matching patch files for `@standard-community/standard-openapi@0.2.9`, `gcp-metadata@8.1.2`, and `pacote@21.5.0`.
- Regenerate `bun.lock` with Bun `1.3.14`.
- Do not modify the six live patches or combine root dependency reclassification with this slice.
- Verify from a disposable clone, empty install tree, and isolated Bun cache so workspace hoisting cannot hide undeclared dependencies.

Verification:

Run this block in one shell with `candidate_sha` set to the reviewed commit:

```bash
test "$(bun --version)" = "1.3.14"
tmp="$(mktemp -d)"
git clone --no-local . "$tmp/repo"
git -C "$tmp/repo" checkout --detach "$candidate_sha"
test ! -e "$tmp/repo/node_modules"
(cd "$tmp/repo" && env BUN_INSTALL_CACHE_DIR="$tmp/bun-cache" bun install --frozen-lockfile)
(cd "$tmp/repo" && bun run check:packages)
(cd "$tmp/repo" && bun run check:generated)
test -z "$(git -C "$tmp/repo" status --short)"
test -z "$(rg '@standard-community/standard-openapi@0\.2\.9|gcp-metadata@8\.1\.2|pacote@21\.5\.0' "$tmp/repo/package.json" "$tmp/repo/bun.lock")"
test ! -e "$tmp/repo/patches/@standard-community%2Fstandard-openapi@0.2.9.patch"
test ! -e "$tmp/repo/patches/gcp-metadata@8.1.2.patch"
test ! -e "$tmp/repo/patches/pacote@21.5.0.patch"
```

Review:

A fresh reviewer who did not author the slice must inspect it read-only and run the Review Protocol against the recorded SHAs and manifest. Reject changes to live patches, unrelated dependencies, generated files, or lockfile entries not explained by the three removals.

### PR 9: Lock V2 Execution And Permission Contracts

- Add direct `/api` integration coverage for permission request, list, and reply wire behavior.
- Preserve exact retry rules for session, prompt, message ID, and delivery mode.
- Preserve coordinator joining, wake coalescing, cross-session concurrency, and active-owner-only interruption.
- Preserve location-scoped runner, model, tool, permission, and filesystem resolution.
- Add a static dependency ratchet that records current V2-to-V1 imports and rejects new ones without claiming existing imports are removable.

Verification:

- `cd packages/core && bun test test/session-prompt.test.ts test/session-run-coordinator.test.ts test/session-runner.test.ts test/session-runner-tool-registry.test.ts test/session-projector.test.ts test/permission.test.ts test/application-tools.test.ts test/location-layer.test.ts test/public-opencode.test.ts`
- `cd packages/core && bun typecheck`
- `cd packages/opencode && bun test test/server/httpapi-session.test.ts test/server/httpapi-public-openapi.test.ts test/server/httpapi-query-schema-drift.test.ts test/server/httpapi-schema-error-body.test.ts test/server/httpapi-authorization.test.ts`
- `cd packages/opencode && bun run test:httpapi`
- `cd packages/opencode && bun typecheck`
- `cd packages/server && bun typecheck`

Review:

A fresh reviewer who did not author the slice must inspect it read-only and run the Review Protocol against the recorded SHAs and manifest. Reject changed execution semantics, a new in-memory tool loop, authorization moved out of built-in tool leaves, or removal of existing V1 compatibility.

### PR 10: Build The Provider Parity Inventory And Harness

- Define the deterministic test catalog from `packages/opencode/test/tool/fixtures/models-api.json` rather than querying live models.dev in CI. The baseline fixture SHA-256 is `d2ea47cabebb5a683cd5d23677dd8f0d597186986da272cc754fda506f7be99b` and contains 120 providers and 4,490 models. This fixture is test evidence only and must not replace or alter the production models.dev integration.
- Generate a sorted `packages/core/test/fixtures/provider-parity-inventory.json` using production ModelsDev canonicalization, including `opencode` to `oc2`.
- Record canonical provider ID, effective model API package and URL after inheritance, credential sources, deterministic batch ID, and representative models for text, tools, structured output, and every declared input modality.
- Classify every built-in plugin and virtual provider as catalog-mapped, generic factory, config-only, or virtual. Add synthetic rows for `dynamic-provider`, `gateway`, `openai-compatible`, and `snowflake-cortex`; cover `fugu` selection without claiming remote parity.
- Partition the catalog into OpenAI-compatible (89), OpenAI direct (3), Anthropic (6), Google/Vertex (3), AWS/Azure (3), dedicated AI SDKs (10), and bespoke SDKs/gateways (6).
- Require each matrix cell to be `parity`, `unsupported` with a stable reason and issue, or `not-applicable` with catalog evidence. Blank, skipped, unclassified, duplicate, or stale rows fail validation.
- Implement a fallback-disabled parity harness that compares canonical wire requests and normalized `LLMEvent` transcripts across AI SDK and native runtimes.
- Require exactly one committed cassette per provider/scenario. Normal CI must not use live network and must fail on a missing required cassette.
- Permit recording only with `RECORD=true` plus explicit provider and scenario filters. Missing credentials for a selected recording must fail.
- Redact secrets, account identifiers, volatile request/event IDs, and timestamps before committing cassettes.
- Keep AI SDK as default and retain provider dependencies and live patches. Do not record all provider evidence in this infrastructure slice.

Verification:

- `cd packages/core && bun run script/provider-parity-inventory.ts --check`
- `cd packages/core && bun test test/provider-parity-catalog.test.ts`
- `cd packages/core && bun typecheck`
- `cd packages/llm && bun typecheck`
- `cd packages/opencode && bun test test/provider/provider.test.ts test/session/llm-provider-parity.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh reviewer who did not author the slice must inspect it read-only and run the Review Protocol against the recorded SHAs and manifest. Reject provider evidence mixed into harness infrastructure, live-network CI, missing-cassette skips, provider removal, production models.dev integration changes, or unexplained fixture hash/count changes.

### PR 11: Record Provider Parity In Capped Batches

- Generate deterministic batches within one protocol family, capped at 10 catalog providers and 30 new or changed cassettes per PR.
- Use these families: OpenAI-compatible, OpenAI direct, Anthropic, Google/Vertex, AWS/Azure, dedicated AI SDKs, and bespoke SDKs/gateways. Do not mix families in one batch.
- Cover catalog/effective API resolution, every declared credential path, canonical request method/URL/auth/body, streamed text and usage, one terminal finish, tools, structured output, declared non-text inputs, abort, and provider-error normalization.
- Run supported scenarios through both runtimes with fallback disabled and compare canonical requests plus normalized `LLMEvent` transcripts.
- Record unsupported native cells with stable reason and tracking issue. Direct invocation must return a typed error containing provider, model, and effective API rather than succeeding through fallback.
- Keep AI SDK as default and retain all provider dependencies and live patches. The full `--require-native` gate is a future cutover requirement, not a batch merge requirement.

Verification:

Run with the deterministic batch ID committed by the candidate:

```bash
batch_id="<committed-batch-id>"
(cd packages/core && bun run script/provider-parity-inventory.ts --check --batch "$batch_id")
(cd packages/core && PROVIDER_PARITY_BATCH="$batch_id" bun test test/provider-parity-native.test.ts test/session-runner-model.test.ts test/session-runner-recorded.test.ts)
(cd packages/core && bun typecheck)
(cd packages/llm && PROVIDER_PARITY_BATCH="$batch_id" bun test test/provider/golden.recorded.test.ts test/generate-object.test.ts)
(cd packages/llm && bun typecheck)
(cd packages/opencode && PROVIDER_PARITY_BATCH="$batch_id" bun test test/session/llm-native.test.ts test/session/llm-native-recorded.test.ts)
(cd packages/opencode && bun typecheck)
```

Review:

A fresh reviewer who did not author the batch must inspect it read-only and run the Review Protocol against the recorded SHAs and manifest. Reject more than 10 providers, more than 30 changed cassettes, mixed protocol families, live-network CI, missing or unredacted cassettes, fallback success presented as native support, provider removal, or unrelated adapter changes.

## Future Cutover Sequence

The baseline series ends after the required PR 11 parity batches. It does not authorize legacy runtime, route, storage, migration, dependency, or V1 config deletion. Continue only through separately approved, review-sized specs in this order:

1. Freeze the retained API, route, import, and consumer inventory.
2. Migrate app, TUI, ACP/CLI, plugin, SDK, and external HTTP consumers in separate surface-specific PRs.
3. Make the native runtime default while retaining fallback and provider dependencies.
4. Name the supported database floor and add artifact-backed Core upgrade fixtures plus forward migrations.
5. Remove runtime fallback only after deterministic zero-use evidence and a passing `provider-parity-inventory.ts --require-native` gate.
6. Remove legacy routes and regenerate the JS SDK only after every retained consumer has migrated.
7. Remove unused provider dependencies and patches in a separate isolated-install PR.
8. Remove V1 config reads last under a separately approved compatibility policy.

## Future Work

- Do not delete `packages/opencode/migration` in this baseline. Two opencode migration tests still load it, no artifact database fixture exists, and the supported database window is undecided.
- Revisit legacy migration assets only after recording the lowest supported producer as release, git SHA, channel, and artifact SHA-256 and checking in a database made by that artifact with its original `__drizzle_migrations` journal and representative rows.
- A future migration deletion gate must apply Core migrations twice, require successful integrity and foreign-key checks, preserve representative project/session/message/part/todo/permission/share/team/memory/root rows, verify required root and usage backfills, port the opencode migration tests to Core, and prove no remaining directory references.
- If the support floor predates `20260519040526_session_roots`, add a Core forward backfill before deleting the legacy migration because the current Core replacement creates `session_root` without reproducing the legacy insert backfill.
- Split `provider.ts`, `prompt.ts`, `session.ts`, `processor.ts`, and tool registry files only after runtime ownership has converged. Keep these refactors behavior-preserving and separate from feature deletion.
- Replace `any`, `Schema.Any`, and `@ts-expect-error` incrementally in touched provider and session seams; do not launch a repository-wide cleanup.
- Regenerate the live `solid-js` patch without absolute `.bun-tag-*` noise after validating patched behavior.
- Audit `@oc2-ai/sdk` and `heap-snapshot-toolkit` root usage under isolated installs before reclassifying or deleting root dependencies.
- Consider inlining `effect-sqlite-node` and `effect-drizzle-sqlite` only after their Core-only boundary is stable.
- Deduplicate Node-compatible SDK v1/v2 server launchers before changing process libraries. Keep SDK launchers Node-compatible.
- Restrict Bun `$` or `Bun.spawn` migration to Bun-only runtime code with lifecycle tests. Do not apply it to Node SDKs or release paths without no-publish verification.
- Remove a browser layout generation only after reachability is eliminated and desktop/mobile coverage proves the retained layout.

## Open Questions

- What is the supported compatibility window for existing databases and V1 public clients? Default: preserve upgrade compatibility and V1 public reads until a separately announced cutover; do not reset data.
- Must legacy TOML and TUI config be persistently migrated? Default: normalize them in memory without writes and persist only through an explicit user update.
- What replaces removed managed help links? Default: link to repository-local README/help where useful and remove links where no maintained local target exists.
- When may the native runner become default? Default: only after all PR 11 batches leave no unsupported case for any retained provider and `provider-parity-inventory.ts --require-native` passes without fallback.
