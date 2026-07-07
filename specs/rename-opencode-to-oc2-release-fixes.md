# oc2 Rename Release Fixes

## Goal

Close the remaining release-readiness gaps in the `opencode` to `oc2` rename while preserving compatibility for existing users.

This spec extends `specs/rename-opencode-to-oc2.md`. It is limited to the concrete blockers found in the audit: installer behavior, desktop sidecar/runtime surfaces, public package naming, CLI help, schema URLs, provider identity review, and regenerated artifacts.

## Current State

- `install` still treats `opencode` as canonical: `APP=opencode`, fresh installs use `~/.opencode/bin`, downloaded artifacts are `opencode-*`, local binary installs write `opencode`, PATH comments say `# opencode`, the final command is `opencode`, and docs point at `https://opencode.ai/docs`.
- `packages/opencode/script/build.ts` now emits `oc2-*` package/artifact names and installs an `opencode` compatibility shim beside `oc2`.
- `packages/opencode/bin/oc2` resolves both `oc2-*` and `opencode-*` native packages, and `packages/opencode/bin/opencode` shims to `oc2`.
- `packages/opencode/script/publish.ts` writes both `oc2-ai` and `opencode-ai` wrapper packages, publishes Docker images for both `ghcr.io/anomalyco/oc2` and `ghcr.io/anomalyco/opencode`, and generates Homebrew/AUR outputs around `oc2` with `opencode` compatibility.
- `packages/opencode/package.json` is named `oc2` and exposes both `bin.oc2` and `bin.opencode`, but internal workspace dependencies still use mixed `@oc2-ai/*` and `@opencode-ai/*` scopes.
- `packages/desktop/scripts/utils.ts` still expects sidecar release assets named `opencode-*`, while `copyBinaryToSidecarFolder` writes `resources/oc2-cli`.
- `packages/desktop/electron-builder.config.ts` emits `oc2-desktop-*` desktop artifacts and registers both `oc2://` and `opencode://`, but Linux `executableName`, deb/rpm package names, app IDs, updater repos, and channel env still use `opencode` names.
- `packages/desktop/src/main/server.ts` uses `opencode server` as the utility process service name, sets `OPENCODE_*` env vars, and sends Basic auth as `opencode:${password}`.
- `packages/desktop/src/main/sidecar.ts` starts the embedded server with username `opencode` and sets `OPENCODE_SERVER_*` env vars.
- `packages/desktop/src/main/wsl/runtime.ts` installs via `https://opencode.ai/install` and only resolves `$HOME/.opencode/bin/opencode`.
- `packages/desktop/src/main/wsl/sidecar.ts` reports “OpenCode is not installed”, runs the resolved `opencode` path, and exports `OPENCODE_*` env vars for the WSL sidecar.
- `packages/desktop/src/main/logging.ts` already exports `oc2-debug-*` archives, but server log collection only checks `opencode/log` roots.
- `packages/opencode/src/index.ts` still uses `scriptName("opencode")` and suppresses the logo only for help text starting with `opencode `.
- User-facing CLI strings still present `opencode` or `OpenCode` as canonical in commands such as `uninstall`, `serve`, `attach`, `upgrade`, `run`, `tui`, `pr`, and GitHub command output.
- `packages/core/src/naming.ts` has canonical `oc2` constants, dual headers, dual config names, and dual env helpers, but `configSchemaURL` still points to `https://opencode.ai/config.json`.
- `packages/opencode/src/installation/index.ts` detects and upgrades both `oc2` and `opencode` package-manager installs, but curl upgrades still fetch `https://opencode.ai/install`.
- `packages/opencode/src/provider/provider.ts` still sends legacy provider identity headers for `llmgateway`, `openrouter`, `nvidia`, `vercel`, `zenmux`, `cerebras`, and `kilo`.
- `packages/sdk/js/script/build.ts` generates `Oc2Client` and keeps `OpencodeClient` as a compatibility export, but `packages/sdk/openapi.json` and generated JS SDK comments still contain legacy `OpenCode`, `opencode`, and `opencode.ai` strings.

## Non-Negotiables

- Do not perform a blind global replacement.
- Keep `opencode` CLI, package, config, env var, header, protocol, and provider aliases working for existing users.
- Make `oc2` canonical for new installs, new docs, help output, release artifacts, and generated client names.
- Do not remove `OPENCODE_*`, `.opencode`, `opencode.json[c]`, `x-opencode-*`, `opencode://`, or `opencode-ai` support in this release.
- Do not hand-edit generated OpenAPI or SDK files when a generator exists.
- Do not change desktop app IDs or updater repositories unless the same PR includes an explicit migration and updater-continuity plan.
- Do not replace third-party provider identity headers until partner allow-list or billing compatibility is confirmed.
- Keep old hosted URLs redirecting indefinitely, especially install, docs, schema, and shared-session URLs.

## Compatibility Decisions

| Surface | Canonical | Compatibility |
| --- | --- | --- |
| CLI command | `oc2` | `opencode` shim remains installed |
| Curl install dir | `~/.oc2/bin` for fresh installs | Detect/adopt `~/.opencode/bin` for existing installs |
| NPM wrapper | `oc2-ai` | `opencode-ai` wrapper remains published |
| Native npm packages | `oc2-*` | launchers may still resolve `opencode-*` |
| Config schema URL | `https://oc2.ai/config.json` | `https://opencode.ai/config.json` redirects |
| Env vars | `OC2_*` | `OPENCODE_*` fallback remains |
| HTTP headers | `x-oc2-*` | `x-opencode-*` accepted |
| Desktop protocol | `oc2://` | `opencode://` remains registered |
| Desktop app IDs | unchanged for first release | rename only with migration plan |
| Provider identity | use `oc2` where approved | keep legacy identity where provider compatibility requires it |

## Implementation Slices

### PR 1: Installer And Curl Upgrade

Make curl installs produce `oc2` as the canonical command without stranding existing `opencode` installs.

Primary files:

- `install`
- `packages/opencode/src/installation/index.ts`
- `packages/opencode/test/installation/**`

Required behavior:

- Download `oc2-*` release assets by default.
- Install `oc2` as the canonical binary.
- Install or preserve an `opencode` shim next to `oc2`.
- Use `~/.oc2/bin` for fresh installs.
- Detect `~/.opencode/bin` and existing `opencode` binaries for upgrades; do not force a path move unless it is non-destructive.
- Support `--binary` by populating both `oc2` and `opencode` entries.
- Update installer usage, examples, temp names, progress text, PATH comments, banner, final command, and docs URL to `oc2`/`OC2`.
- Switch in-app curl upgrade fetches to the canonical install URL after that URL exists, while keeping the old install URL redirect-compatible.

Verification:

- `cd packages/opencode && bun test test/installation --timeout 30000`
- `cd packages/opencode && bun typecheck`
- Manual macOS/Linux dry run for fresh install, old-only install, and `--binary` install.
- Confirm both `oc2 --version` and `opencode --version` work after install.

Review:

- Confirm the PR does not delete existing `~/.opencode` data.
- Confirm release asset names match `packages/opencode/script/build.ts` output.

### PR 2: Desktop Sidecar, Runtime, And WSL

Finish desktop runtime rename surfaces while keeping desktop updater and protocol continuity safe.

Primary files:

- `packages/desktop/scripts/utils.ts`
- `packages/desktop/electron-builder.config.ts`
- `packages/desktop/src/main/server.ts`
- `packages/desktop/src/main/sidecar.ts`
- `packages/desktop/src/main/index.ts`
- `packages/desktop/src/main/logging.ts`
- `packages/desktop/src/main/wsl/runtime.ts`
- `packages/desktop/src/main/wsl/sidecar.ts`
- `packages/desktop/src/main/wsl/servers.ts`
- `packages/desktop/src/renderer/i18n/en.ts`

Required behavior:

- Change sidecar release artifact inputs from `opencode-*` to `oc2-*`.
- Keep fallback to old sidecar artifact names only when bundling older release assets is required.
- Prefer `OC2_CHANNEL` in desktop scripts and build config; keep `OPENCODE_CHANNEL` fallback during migration.
- Change Linux `executableName`, deb package names, and rpm package names to `oc2` names.
- Keep existing desktop app IDs and updater repositories unless the PR includes data migration, package upgrade, protocol, and updater continuity handling.
- Keep `oc2://` canonical and keep `opencode://` registered.
- Use `oc2` for sidecar service names, default Basic auth username, and desktop-owned env vars.
- Continue accepting or setting legacy auth/env values where the embedded server still needs them.
- In WSL, install via the canonical installer, resolve `~/.oc2/bin/oc2` first, and fall back to `~/.opencode/bin/opencode`.
- Update WSL and renderer English strings to `OC2`/`oc2`; leave locale sync to the docs/UI pass unless translators are available.
- Include both `oc2/log` and `opencode/log` server log roots in debug exports.

Verification:

- `cd packages/desktop && bun typecheck`
- `cd packages/desktop && OPENCODE_CHANNEL=dev bun ./scripts/prepare.ts`
- `cd packages/desktop && OC2_CHANNEL=dev bun ./scripts/prepare.ts`
- `cd packages/desktop && bun run build`
- Manual WSL check: install, detect, spawn sidecar, health check, and upgrade.

Review:

- Confirm old desktop users can still update or launch.
- Confirm both old and new protocols work.
- Confirm debug export collects old and new server logs.

### PR 3: Public Package Naming Consistency

Finalize the public package and artifact naming story before release.

Primary files:

- `packages/opencode/package.json`
- `packages/opencode/script/build.ts`
- `packages/opencode/script/publish.ts`
- `packages/opencode/script/postinstall.mjs`
- `packages/opencode/bin/oc2`
- `packages/opencode/bin/opencode`
- `package.json`
- `bun.lock`

Required behavior:

- Treat `oc2-ai` as the canonical global npm wrapper unless release leadership chooses a different public name.
- Keep `opencode-ai` as a compatibility wrapper that installs both `oc2` and `opencode` bins.
- Keep native optional package names aligned with `oc2-*` release assets.
- Keep launcher fallback to `opencode-*` native packages for compatibility.
- Keep internal `@opencode-ai/*` workspace scopes for this release unless a dedicated package-scope migration PR is approved.
- Ensure package metadata, publish scripts, Homebrew, AUR, Docker, docs, and generated asset names agree.

Verification:

- `bun install`
- `bun run check:packages`
- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun run build --single --skip-embed-web-ui`
- Inspect generated `dist/*/package.json` files and wrapper packages.

Review:

- Confirm `npm install -g oc2-ai` exposes `oc2` and `opencode`.
- Confirm `npm install -g opencode-ai` remains usable as compatibility.

### PR 4: CLI Help And User-Facing Branding

Make CLI help and command copy present `oc2` as canonical.

Primary files:

- `packages/opencode/src/index.ts`
- `packages/opencode/src/cli/cmd/**/*.ts`
- `packages/opencode/test/cli/help/**`
- `packages/tui/**`

Required behavior:

- Change yargs `scriptName` to `oc2`.
- Update help/logo suppression logic for `oc2` help output.
- Update command descriptions such as “run opencode”, “headless opencode server”, “upgrade opencode”, and “start opencode tui”.
- Update `uninstall` prompts from `OpenCode`/`opencode` to `OC2`/`oc2`, while still removing legacy data and package aliases.
- Update user-facing CLI text in `pr`, GitHub, MCP, TUI splash, permission prompts, and debug output where `opencode` is not an internal metric key, package scope, provider ID, or compatibility example.
- Mention `opencode` only as a compatibility alias where useful.
- Update snapshots intentionally.

Verification:

- `cd packages/opencode && bun test test/cli/help --timeout 30000`
- `cd packages/opencode && bun test --timeout 30000`
- `cd packages/opencode && bun typecheck`
- `cd packages/tui && bun test --timeout 30000`

Review:

- Confirm help output shows `oc2` as canonical.
- Confirm legacy aliases are documented but not presented as the primary command.

### PR 5: Config Schema URL And Hosted Domains

Move generated config metadata to the canonical domain without breaking existing configs.

Primary files:

- `packages/core/src/naming.ts`
- `packages/opencode/src/config/config.ts`
- `packages/web/src/content/docs/**`
- Hosting or redirect configuration for `opencode.ai`, if present outside this package tree.

Required behavior:

- Change `Naming.configSchemaURL` to `https://oc2.ai/config.json`.
- Keep `https://opencode.ai/config.json` redirected indefinitely.
- Ensure fresh generated configs write the new `$schema` URL.
- Keep `.opencode`, `opencode.json[c]`, and `OPENCODE_*` compatibility.
- Update docs links to canonical `oc2` docs URLs after redirects exist.

Verification:

- `cd packages/core && bun typecheck`
- `cd packages/core && bun test`
- `cd packages/opencode && bun test --timeout 30000`
- Manual fresh config creation and `$schema` check.

Review:

- Confirm old configs still load.
- Confirm old schema URL redirects rather than 404s.

### PR 6: Provider Identity Compatibility Review

Resolve provider identity headers deliberately instead of replacing them blindly.

Primary files:

- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/session/llm/request.ts`
- `packages/core/src/catalog.ts`
- `packages/core/src/plugin/provider/opencode.ts`
- Provider header tests under the relevant package.

Required behavior:

- Inventory current third-party identity headers for `llmgateway`, `openrouter`, `nvidia`, `vercel`, `zenmux`, `cerebras`, and `kilo`.
- Confirm whether partner billing, rate limits, allow-lists, analytics, or support flows depend on legacy `opencode`, `OpenCode`, or `opencode.ai` values.
- Change provider headers to `oc2`, `OC2`, and `https://oc2.ai/` only after compatibility is approved for that provider.
- Keep persisted provider ID `opencode` and `OPENCODE_API_KEY` support.
- Keep or add the `oc2` provider alias that maps to the managed provider implementation.
- Add focused tests for managed provider header names and provider ID aliasing.

Verification:

- `cd packages/opencode && bun test --timeout 30000`
- `cd packages/core && bun test`
- Focused provider tests added or updated in the same PR.

Review:

- Confirm each provider identity change has an explicit compatibility note.
- Confirm no provider account migration is required.

### PR 7: OpenAPI, SDK, Docs, And Snapshots

Regenerate generated artifacts and update docs after runtime naming decisions land.

Primary files:

- `packages/sdk/openapi.json`
- `packages/sdk/js/script/build.ts`
- `packages/sdk/js/src/**`
- `packages/web/src/content/docs/**`
- `README.md`
- `README.*.md`
- `github/action.yml`
- `github/README.md`
- Snapshots under `packages/opencode/test/**` and `packages/tui/test/**`

Required behavior:

- Regenerate OpenAPI and the JS SDK with `./packages/sdk/js/script/build.ts`.
- Keep `OpencodeClient` as a compatibility export unless a separate external-consumer migration says otherwise.
- Update generated examples and docs to import the canonical SDK package.
- Update install and run docs to use `oc2` and `oc2-ai`.
- Keep migration docs explicit that `opencode` remains an alias.
- Update GitHub Action docs after deciding whether the action path remains under `anomalyco/opencode` for compatibility.

Verification:

- `./packages/sdk/js/script/build.ts`
- `cd packages/sdk/js && bun typecheck`
- `cd packages/opencode && bun test --timeout 30000`
- `cd packages/tui && bun test --timeout 30000`
- `cd packages/app && bun run test:unit`

Review:

- Confirm generated files were regenerated, not hand-edited.
- Confirm docs no longer present `opencode` as the primary command except migration notes.

## Final Release Checklist

- Fresh curl install downloads `oc2-*`, installs `oc2`, and leaves `opencode` callable.
- Existing curl installs under `~/.opencode/bin` can upgrade or remain callable.
- `npm install -g oc2-ai` provides both `oc2` and `opencode`.
- `npm install -g opencode-ai` remains a compatibility path.
- Desktop sidecar bundles `oc2-*` artifacts.
- Desktop Linux package/executable names use `oc2`.
- Desktop updater continuity is confirmed before any app ID or updater repo change.
- WSL desktop sidecar detects both `~/.oc2/bin/oc2` and `~/.opencode/bin/opencode`.
- CLI help presents `oc2` as canonical.
- Fresh configs use `https://oc2.ai/config.json` and old schema URLs redirect.
- Managed provider IDs, aliases, and auth still work for both `oc2` and `opencode` paths.
- OpenAPI, SDK, help snapshots, TUI snapshots, README files, docs, and release notes are regenerated or reviewed.

## Open Questions

- What is the final canonical hosted install URL: `https://oc2.ai/install` or another domain? Default recommendation: `https://oc2.ai/install`, with `https://opencode.ai/install` redirecting indefinitely.
- Should desktop app IDs move from `ai.opencode.desktop*` to `ai.oc2.desktop*` in this release? Default recommendation: no, keep app IDs stable until a dedicated migration/updater plan is ready.
- Which provider identity headers can safely change to `oc2` immediately? Default recommendation: keep legacy provider identity until each provider compatibility note is recorded.
- Should internal workspace package scopes migrate from `@opencode-ai/*` to `@oc2-ai/*` now? Default recommendation: defer broad internal scope migration to a separate PR after release blockers are fixed.
