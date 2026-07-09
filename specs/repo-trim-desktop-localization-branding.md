# Repo Trim: Desktop, Localization, And Branding

## Goal

Trim the repo to keep CLI, TUI, SDK, and Web surfaces while removing the desktop app, non-English localization, and opencode branding assets. The implementation must be incremental: delete high-confidence isolated code first, then prune shared Web/UI references without breaking retained builds.

## Current State

- Root `package.json` has `dev:desktop` and trusts `electron`.
- `packages/desktop/package.json` defines the Electron desktop app with `electron-vite`, `electron-builder`, updater, native packaging, icons, and desktop-only scripts.
- `packages/app` is retained Web UI, but `packages/app/package.json` exports `./desktop-menu`, `./updater`, `./wsl/types`, and many locale files.
- `packages/opencode/script/build.ts` embeds `packages/app/dist` into CLI builds unless `--skip-embed-web-ui` is used.
- `packages/web/astro.config.mjs` configures Starlight locales and OpenCode branding.
- `script/ci-scope.ts` includes `@oc2-ai/desktop` in `e2ePackages`.
- `script/publish.ts` calls `packages/desktop/scripts/finalize-latest-json.ts` and `finalize-latest-yml.ts`.
- Branding assets exist in `packages/identity`, `packages/ui/src/assets`, `packages/web/src/assets`, and Web/app manifests.

## Non-Negotiables

- Keep working surfaces: `packages/opencode`, `packages/cli`, `packages/tui`, `packages/sdk/js`, `packages/app`, `packages/web`.
- Do not delete `packages/app`; it is the retained Web app.
- Do not rename published packages, binaries, or compatibility aliases in the first pass unless explicitly approved.
- Replace active Web/UI branding assets before deleting them if builds reference them.
- Convert localization to English-only; do not leave broken locale exports.
- Each PR must get a fresh read-only review before being checked off.

## Design

### Retained Surface

Keep these packages and their shared dependencies:

- `packages/opencode`
- `packages/cli`
- `packages/tui`
- `packages/sdk/js`
- `packages/app`
- `packages/web`
- Shared packages required by those surfaces: `packages/core`, `packages/server`, `packages/ui`, `packages/plugin`, `packages/llm`, `packages/script`, SQLite/effect support packages.

### Removed Surface

Remove desktop distribution and build support:

- `packages/desktop/**`
- `nix/desktop.nix`
- `packages/containers/tauri-linux/**`
- Desktop CI/release jobs and artifacts
- Desktop updater finalizers
- Desktop app docs/download routes

### Localization

Default to English-only:

- Keep English copy/dictionaries.
- Remove localized docs directories and Starlight locale config.
- Remove non-English app/UI locale files and package exports.
- Remove language picker/provider code only after call sites use static English safely.

### Branding

Remove standalone opencode brand assets and replace active app/site assets:

- Delete `packages/identity/**`.
- Delete console brand-kit route/assets only if console is outside retained Web scope.
- Replace required favicons, logo components, social images, manifests, and page titles with neutral/approved assets before deleting old files.

## Implementation Slices

### PR 1: Remove Desktop Package And Release Wiring

- Delete `packages/desktop/**`.
- Remove `dev:desktop` and `electron` trusted dependency from root `package.json`.
- Remove desktop release jobs/artifact handling from `.github/workflows/publish.yml`.
- Remove desktop finalizers from `script/publish.ts`.
- Remove `@oc2-ai/desktop` from `script/ci-scope.ts`.
- Remove desktop CODEOWNERS entry.
- Remove `nix/desktop.nix` and `packages/containers/tauri-linux/**`.
- Regenerate `bun.lock` and any generated Nix dependency files touched by workspace removal.

Verification:

- `bun install --frozen-lockfile`
- `bun --cwd packages/opencode typecheck`
- `bun --cwd packages/app typecheck`

Review:

Use a fresh read-only reviewer to confirm no `packages/desktop` references remain in workspace manifests, CI, publish scripts, Nix, or container scripts.

### PR 2: Prune Desktop-Only Code From Retained Web App

- Remove `./desktop-menu`, `./updater`, and desktop-only WSL exports from `packages/app/package.json`.
- Remove or simplify desktop-only files:
  - `packages/app/src/desktop-menu.ts`
  - `packages/app/src/updater.ts`
  - `packages/app/src/components/updater-action.ts`
  - `packages/app/src/components/windows-app-menu.tsx`
  - `packages/app/src/wsl/**`
- Simplify `packages/app/src/context/platform.tsx` to Web-only behavior.
- Remove Tauri/window-drag compatibility from `packages/app/src/components/titlebar.tsx`.
- Remove desktop update/display/zoom settings from app settings pages.
- Remove desktop/Tauri origins from `packages/opencode/src/server/cors.ts` if no retained client needs them.

Verification:

- `bun --cwd packages/app typecheck`
- `bun --cwd packages/app build`
- `bun --cwd packages/opencode typecheck`

Review:

Use a fresh read-only reviewer to compare the diff against the retained Web behavior and confirm no desktop-only UI/settings remain.

### PR 3: Make Web Docs English-Only

- Remove localized docs under `packages/web/src/content/docs/{ar,bs,da,de,es,fr,it,ja,ko,nb,pl,pt-br,ru,th,tr,zh-cn,zh-tw}/**`.
- Remove non-English Starlight locale entries from `packages/web/astro.config.mjs`.
- Remove non-English JSON files from `packages/web/src/content/i18n/**`, keeping English if still required.
- Update English docs to remove desktop app download/support claims while preserving TUI desktop-notification docs.

Verification:

- `bun --cwd packages/web build`

Review:

Use a fresh read-only reviewer to confirm the docs site has no non-English routes and no desktop app marketing/download claims.

### PR 4: Make App And UI English-Only

- Remove non-English exports from `packages/app/package.json`.
- Delete non-English dictionaries from `packages/app/src/i18n/**`, keeping `en.ts`.
- Delete non-English dictionaries from `packages/ui/src/i18n/**`, keeping `en.ts`.
- Replace runtime locale selection with static English defaults.
- Update or remove locale parity tests such as `packages/app/src/i18n/parity.test.ts`.
- Remove `@solid-primitives/i18n` dependencies only if no retained code imports them.

Verification:

- `bun --cwd packages/app test:unit`
- `bun --cwd packages/app typecheck`
- `bun --cwd packages/tui typecheck`

Review:

Use a fresh read-only reviewer to confirm no broken locale exports/imports remain and that retained UI renders with English strings.

### PR 5: Remove Or Replace Branding Assets

- Delete unreferenced standalone marks in `packages/identity/**`.
- Replace active branding references in:
  - `packages/app/index.html`
  - `packages/web/astro.config.mjs`
  - `packages/web/config.mjs`
  - `packages/web/public/site.webmanifest`
  - `packages/ui/src/components/logo.tsx`
  - `packages/ui/src/components/favicon.tsx`
- Replace or remove referenced favicon/social/logo assets in:
  - `packages/app/public/**`
  - `packages/web/public/**`
  - `packages/web/src/assets/**`
  - `packages/ui/src/assets/**`
- Keep package names and legacy binary aliases unless separately approved.

Verification:

- `bun run check:brand`
- `bun --cwd packages/app build`
- `bun --cwd packages/web build`

Review:

Use a fresh read-only reviewer to search for remaining opencode logo/brand asset references and classify any remaining text references as compatibility, docs, or blockers.

### PR 6: Final Retained-Surface Verification

- Run focused builds/typechecks for retained surfaces.
- Regenerate SDK if generated clients changed.
- Remove stale docs/spec references only when they are not migration history.
- Produce final deletion summary with retained packages and intentionally kept compatibility names.

Final deletion summary:

- Retained packages: `packages/opencode`, `packages/cli`, `packages/tui`, `packages/sdk/js`, `packages/app`, `packages/web`, and shared packages required by those surfaces.
- Removed surfaces: desktop package and release wiring, desktop-only retained app code, non-English docs/app/UI localization, and standalone or active OpenCode branding assets replaced with neutral OC2 assets.
- Intentionally kept compatibility names: legacy `opencode` binaries/aliases, `.opencode`, `opencode.json[c]`, `OPENCODE_*` environment/config names, `x-opencode-*` protocol/header names, `opencode.ai` compatibility links or redirects, and generated SDK compatibility names such as `OpencodeClient`.
- Deferred future work: package-scope renames and console, stats, enterprise, Slack, or GitHub workspace pruning remain outside this repo-trim slice.

Verification:

- `bun --cwd packages/opencode run build --single`
- `bun --cwd packages/cli typecheck`
- `bun --cwd packages/tui typecheck`
- `bun --cwd packages/sdk/js typecheck`
- `bun --cwd packages/web build`

Review:

Use a fresh read-only reviewer to verify the repo contains no desktop package/build path, no non-English localization surface, and no active opencode branding assets.

## Future Work

- Rename published packages or compatibility aliases such as legacy `opencode` binaries.
- Remove console, stats, enterprise, Slack, or GitHub workspaces if they are confirmed outside retained Web scope.
- Replace product copy and domains beyond static branding assets.

## Open Questions

- Does “Web” mean only `packages/app` and `packages/web`? Default: yes; leave console/stats/enterprise removal for a follow-up decision.
- What should replace active branding assets? Default: neutral/OC2 placeholders so Web builds keep valid favicons, manifests, and social images.
- Should the legacy `opencode` binary alias be removed? Default: no, keep compatibility in the first pass.
