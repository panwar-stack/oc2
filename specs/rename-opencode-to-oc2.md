# Rename opencode To oc2

## Goal

Rename the product, CLI, package surfaces, runtime identifiers, docs, and release artifacts from `opencode` to `oc2` without breaking existing users. The implementation must be compatibility-first: introduce `oc2` as the canonical name, keep legacy `opencode` entry points as aliases during migration, and only remove old names in a later explicit cleanup.

This is not a safe global text replacement. `opencode` is persisted in config paths, auth and database locations, package names, desktop app IDs, protocols, generated SDKs, HTTP headers, CI, docs, and user workflows.

## Current State

- `package.json` uses root package name `opencode`, repo URL `anomalyco/opencode`, and workspace dependencies under `@opencode-ai/*`.
- `packages/opencode/package.json` publishes the main CLI as package `opencode` with `bin.opencode`.
- `packages/opencode/bin/opencode` resolves native optional packages named `opencode-${platform}-${arch}`, binary `opencode`/`opencode.exe`, and `OPENCODE_BIN_PATH`.
- `packages/opencode/script/build.ts` emits `bin/opencode`, `dist/opencode-*`, `opencode/${version}` user agent, and `OPENCODE_*` compile-time constants.
- `packages/opencode/script/publish.ts` publishes native npm packages, wrapper package `opencode-ai`, Homebrew/AUR artifacts, Docker image `ghcr.io/anomalyco/opencode`, and GitHub release assets named `opencode-*`.
- `packages/core/src/global.ts` hard-codes app slug `opencode`, driving XDG paths such as `~/.config/opencode`, `~/.local/share/opencode`, `~/.cache/opencode`, `~/.local/state/opencode`, and `/tmp/opencode`.
- `packages/core/src/database/database.ts` defaults to `opencode.db` and `opencode-${channel}.db`, with `OPENCODE_DB` override.
- `packages/opencode/src/config/config.ts` discovers `opencode.json[c]`, `.opencode`, `OPENCODE_CONFIG*`, schema URL `https://opencode.ai/config.json`, and `/.well-known/opencode`.
- `packages/opencode/src/config/paths.ts` searches project and global `.opencode` directories for commands, agents, plugins, skills, tools, themes, and config.
- Runtime env vars are broadly `OPENCODE_*` across `packages/core/src/flag/flag.ts` and `packages/opencode/src/effect/runtime-flags.ts`.
- Server/client integration uses headers such as `x-opencode-directory`, `x-opencode-workspace`, `x-opencode-sync`, and `x-opencode-ticket`.
- Built-in provider identity includes persisted provider ID `opencode` in `packages/opencode/src/provider/provider.ts`, `packages/core/src/catalog.ts`, and `packages/core/src/plugin/provider/opencode.ts`.
- Desktop metadata in `packages/desktop/electron-builder.config.ts` uses app IDs `ai.opencode.desktop*`, product names `OpenCode*`, protocol scheme `opencode`, updater repos `anomalyco/opencode*`, and package names `opencode*`.
- SDK generation in `packages/sdk/js/script/build.ts` creates `OpencodeClient`; `packages/sdk/openapi.json` contains `opencode` metadata and examples importing `@opencode-ai/sdk`.
- VS Code extension metadata in `sdks/vscode/package.json` uses package/display names and command IDs under `opencode.*`; `sdks/vscode/src/extension.ts` launches `opencode --port`.
- GitHub Action metadata in `github/action.yml` installs from `https://opencode.ai/install`, caches `~/.opencode/bin`, and runs `opencode github run`.
- Docs and brand surfaces include root `README*.md`, `packages/web/src/content/docs/**`, `packages/console/app/src/i18n/*.ts`, TUI tips/errors, desktop/app i18n, and brand assets named `opencode-*`.
- Rename-sensitive tests include CLI help snapshots, TUI snapshots, install tests, config fixtures, env-var tests, and CI workflows.

## Non-Negotiables

- Do not perform a blind global replacement.
- Keep existing users working during the first migration release.
- `oc2` names must be preferred for new installs and new docs.
- Legacy `opencode` names must remain readable or callable where persisted user data, workflows, or external integrations depend on them.
- Do not rename persisted provider ID `opencode` without a dedicated alias and data migration plan.
- Keep old hosted URLs redirecting where feasible, especially schema URLs, API endpoints, install URLs, and docs links.
- Keep `opencode` CLI as a shim to `oc2` for at least one major release.
- Generated files must be regenerated, not hand-edited, where generation paths exist.
- Run tests from package directories. Use `./packages/sdk/js/script/build.ts` for JS SDK generation.

## Compatibility Policy

| Surface | New canonical | Legacy support |
| --- | --- | --- |
| Display name | `oc2` or `OC2` | Mention `OpenCode` only in migration docs |
| CLI binary | `oc2` | Keep `opencode` shim |
| Env vars | `OC2_*` | Keep `OPENCODE_*` fallback |
| Project config dir | `.oc2/` | Read `.opencode/` fallback |
| Config file | `oc2.json[c]` | Read `opencode.json[c]` fallback |
| Global paths | `~/.config/oc2`, `~/.local/share/oc2`, `~/.cache/oc2`, `~/.local/state/oc2` | Migrate or read old `opencode` paths |
| HTTP headers | `x-oc2-*` | Accept `x-opencode-*` |
| Protocol | `oc2://` | Keep `opencode://` |
| Provider ID | Add `oc2` alias | Keep persisted `opencode` ID |
| Hosted URLs | New `oc2` domains | Redirect old `opencode.ai` URLs |

## Implementation Slices

### PR 1: Naming Constants And Compatibility Layer

- Add canonical naming constants for app slug, display name, env prefix, config names, header names, and domains.
- Add helpers for reading env vars with `OC2_*` preferred and `OPENCODE_*` fallback.
- Add config discovery priority: `.oc2` then `.opencode`, `oc2.json[c]` then `opencode.json[c]`.
- Add HTTP header compatibility for `x-oc2-*` and `x-opencode-*`.
- Add provider alias `oc2` mapping to the existing provider implementation, without removing persisted `opencode`.
- Keep changes minimal and avoid broad package metadata changes in this PR.

Primary files:

- `packages/core/src/global.ts`
- `packages/core/src/database/database.ts`
- `packages/core/src/flag/flag.ts`
- `packages/opencode/src/config/config.ts`
- `packages/opencode/src/config/paths.ts`
- `packages/opencode/src/effect/runtime-flags.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/core/src/catalog.ts`

Verification:

- `cd packages/core && bun typecheck`
- `cd packages/core && bun test`
- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test --timeout 30000`

Review:

- Confirm `OC2_*` values win over `OPENCODE_*` values.
- Confirm old config files and directories still load.
- Confirm persisted provider IDs remain valid.

### PR 2: Storage And Migration

- Change new default global paths to `oc2`.
- Add non-destructive migration or adoption for old `opencode` global paths when new paths do not exist.
- Cover `auth.json`, `opencode.db*`, logs, repo cache, binary cache, and config directories.
- Prefer copy/adopt behavior over delete/move behavior to avoid data loss.
- Keep old locations readable as fallbacks.

Primary files:

- `packages/core/src/global.ts`
- `packages/core/src/database/database.ts`
- `packages/opencode/src/auth/index.ts`
- `packages/opencode/src/installation/index.ts`
- `packages/opencode/src/cli/cmd/uninstall.ts`

Verification:

- `cd packages/opencode && bun test --timeout 30000`
- `cd packages/core && bun test`

Review:

- Test fresh install paths.
- Test old-only install paths.
- Test both-old-and-new paths, where new paths must win.

### PR 3: CLI Binary And Package Metadata

- Rename canonical CLI binary to `oc2`.
- Keep `opencode` as a shim invoking `oc2`.
- Update launcher native package resolution from `opencode-*` to the chosen new artifact names.
- Decide npm naming before implementation: `oc2`, `oc2-ai`, `@oc2/*`, or `@oc2-ai/*`.
- Keep old `opencode-ai` and `@opencode-ai/*` compatibility packages or deprecation stubs if public installs must keep working.
- Update user agent from `opencode/${version}` to `oc2/${version}`, while accepting old integrations.

Primary files:

- `package.json`
- `packages/opencode/package.json`
- `packages/opencode/bin/opencode`
- `packages/opencode/script/build.ts`
- `packages/opencode/script/publish.ts`
- `packages/script/src/index.ts`
- `packages/script/src/bun-target.ts`
- `bun.lock`

Verification:

- `bun install`
- `bun run check:packages`
- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun run build --single --skip-embed-web-ui`

Review:

- Confirm both `oc2` and `opencode` launch.
- Confirm generated native package names and binary paths match the release plan.
- Confirm package names match the chosen npm strategy.

### PR 4: Server, API, Auth, And Hosted URLs

- Add `OC2_SERVER_*` env vars while keeping `OPENCODE_SERVER_*`.
- Accept both `oc2` and `opencode` server usernames if the default username changes.
- Add `*.oc2.*` CORS origins while keeping `*.opencode.ai`.
- Add `/.well-known/oc2` while keeping `/.well-known/opencode`.
- Add `oc2.local` mDNS while optionally advertising old `opencode.local`.
- Update OpenAPI title and description to `oc2`.
- Keep old schema URLs redirecting indefinitely.

Primary files:

- `packages/opencode/src/server/auth.ts`
- `packages/opencode/src/server/cors.ts`
- `packages/opencode/src/server/mdns.ts`
- `packages/opencode/src/server/routes/instance/httpapi/api.ts`
- `packages/opencode/src/server/routes/instance/httpapi/public.ts`
- `packages/opencode/src/cli/cmd/providers.ts`
- `packages/opencode/src/account/account.ts`
- `packages/opencode/src/account/repo.ts`
- `packages/opencode/src/cli/cmd/account.ts`

Verification:

- `cd packages/opencode && bun run test:httpapi`
- `./packages/sdk/js/script/build.ts`
- `cd packages/sdk/js && bun typecheck`

Review:

- Confirm new and old well-known URLs work.
- Confirm generated SDK changes are intentional.
- Confirm old clients can still authenticate and connect.

### PR 5: SDK, Plugin, VS Code, And GitHub Action

- Rename generated SDK client names only after deciding whether `OpencodeClient` remains as a compatibility export.
- Update package imports in docs and examples from `@opencode-ai/sdk` to the chosen new package.
- Keep old SDK/plugin packages as compatibility wrappers if possible.
- Update VS Code extension display name and terminal command to `oc2`.
- Keep old VS Code command IDs or add aliases because `opencode.*` commands may be referenced by user keybindings.
- Update GitHub Action metadata to use `oc2`, but preserve old action path and tags if existing workflows must continue.

Primary files:

- `packages/sdk/js/package.json`
- `packages/sdk/js/script/build.ts`
- `packages/sdk/openapi.json`
- `packages/plugin/package.json`
- `sdks/vscode/package.json`
- `sdks/vscode/src/extension.ts`
- `sdks/vscode/script/publish`
- `github/action.yml`
- `github/README.md`

Verification:

- `./packages/sdk/js/script/build.ts`
- `cd packages/sdk/js && bun typecheck`
- `cd packages/plugin && bun typecheck`
- `cd packages/plugin && bun run build`
- `cd sdks/vscode && bun install && bun run compile`

Review:

- Confirm generated OpenAPI and SDK diffs are regenerated, not hand-edited.
- Confirm old VS Code commands continue to work or are intentionally documented as breaking.

### PR 6: Desktop Rename

- Rename desktop product metadata to `oc2`.
- Add `oc2://` protocol registration while keeping `opencode://`.
- Decide whether app IDs change from `ai.opencode.desktop*` to an `oc2` ID.
- If app IDs change, implement explicit migration for Electron `userData`, updater channels, protocol handlers, Linux package upgrades, and desktop logs.
- Update sidecar binary names from `opencode-*` to `oc2-*`.
- Update debug export name from `opencode-debug-*` to `oc2-debug-*`.

Primary files:

- `packages/desktop/package.json`
- `packages/desktop/electron-builder.config.ts`
- `packages/desktop/scripts/utils.ts`
- `packages/desktop/scripts/copy-metainfo.ts`
- `packages/desktop/src/main/server.ts`
- `packages/desktop/src/main/logging.ts`
- `packages/desktop/src/renderer/i18n/en.ts`

Verification:

- `cd packages/desktop && bun typecheck`
- `cd packages/desktop && OPENCODE_CHANNEL=dev bun ./scripts/prepare.ts`
- `cd packages/desktop && bun run build`

Review:

- Confirm auto-update continuity.
- Confirm old and new protocol handlers work.
- Confirm app data migration is non-destructive.

### PR 7: Docs, Website, UI Strings, And Assets

- Update canonical English docs first.
- Update locale docs or mark them for translation sync.
- Update README install commands after package and release names are final.
- Update TUI tips, help text, errors, and terminal title.
- Update app and desktop i18n strings.
- Replace brand assets, screenshots, videos, and downloadable ZIP names.
- Keep migration docs explicit about old names that still work.

Primary paths:

- `README.md`
- `README.*.md`
- `packages/web/src/content/docs/**`
- `packages/web/src/content/i18n/*.json`
- `packages/console/app/src/i18n/*.ts`
- `packages/console/app/src/routes/brand/index.tsx`
- `packages/console/app/src/routes/legal/terms-of-service/index.tsx`
- `packages/tui/src/app.tsx`
- `packages/tui/src/feature-plugins/home/tips-view.tsx`
- `packages/tui/src/util/error.ts`
- `packages/app/src/i18n/*.ts`
- `packages/console/app/src/asset/brand/*`

Verification:

- Search for `opencode`.
- Search for `OpenCode`.
- Search for `@opencode-ai`.
- Search for `opencode.ai`.
- Search for `.opencode`.
- Search for `opencode.json`.
- Search for `OPENCODE_`.
- Manually review PNG, SVG, and MP4 assets for embedded old branding.

Review:

- Confirm user-facing docs match actual compatibility behavior.
- Confirm locale changes are either updated or intentionally deferred.

### PR 8: CI, Release, And Snapshots

- Update publish workflows and artifact names.
- Update Homebrew, AUR, Docker, GitHub release, Windows signing, and desktop release references.
- Regenerate lockfiles and generated artifacts.
- Update snapshots and fixtures.
- Avoid blanket re-recording LLM cassettes unless request bodies or headers actually change.

Primary files:

- `.github/workflows/publish.yml`
- `.github/workflows/test.yml`
- `.github/workflows/typecheck.yml`
- `.github/workflows/opencode.yml`
- `.github/workflows/containers.yml`
- `.github/workflows/publish-vscode.yml`
- `packages/opencode/test/cli/help/__snapshots__/help-snapshots.test.ts.snap`
- `packages/tui/test/cli/tui/__snapshots__/inline-tool-wrap-snapshot.test.tsx.snap`
- `packages/opencode/test/fixture/fixture.ts`
- `packages/opencode/test/installation/installation.test.ts`

Verification:

- `bun run check:packages`
- `bun run check:generated`
- `bun turbo typecheck`
- `cd packages/opencode && bun test --timeout 30000`
- `cd packages/tui && bun test --timeout 30000`
- `cd packages/app && bun run test:unit`
- `cd packages/llm && bun test --timeout 30000`

Review:

- Confirm CI names and artifact names match the release plan.
- Confirm snapshots reflect intentional UI/CLI rename changes.
- Confirm lockfiles were regenerated by package-manager commands.

## Final Audit Checklist

- Search source and docs for `opencode`.
- Search source and docs for `OpenCode`.
- Search source and docs for `@opencode-ai`.
- Search source and docs for `opencode.ai`.
- Search source and docs for `.opencode`.
- Search source and docs for `opencode.json`.
- Search source and docs for `OPENCODE_`.
- Inspect generated files and confirm they were regenerated.
- Inspect binary, image, and video assets for embedded old branding.
- Confirm new `oc2` names are canonical in fresh install docs.
- Confirm old `opencode` names are documented only as compatibility aliases or migration references.

## Open Questions

- Should the public npm package be `oc2`, `oc2-ai`, `@oc2/*`, or `@oc2-ai/*`? Default recommendation: use the shortest available public package for the CLI, and a scoped namespace for libraries.
- Should the repo and source directory `packages/opencode` be renamed immediately? Default recommendation: defer path/repo renames until runtime compatibility and release migration are complete.
- Should desktop app IDs change? Default recommendation: avoid changing app IDs unless there is a dedicated desktop migration release.
- What is the canonical new domain? Default recommendation: pick the domain before docs and release PRs, then redirect old `opencode.ai` URLs indefinitely.
- How long should `opencode` CLI, env, config, package, and protocol aliases remain? Default recommendation: at least one major release, with explicit deprecation messaging before removal.

## Future Work

- Remove legacy `opencode` aliases after the supported deprecation window.
- Rename source directories and repository slugs only after external integrations are stable.
- Publish migration telemetry or diagnostics to detect users still relying on old names before removal.
