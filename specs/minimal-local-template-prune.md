# Minimal Local Template Prune

## Goal

Turn this repo into a minimal cloneable template that keeps the local core, CLI, TUI, and local app surfaces, while deleting hosted web, docs, deployment, social, GitHub Action, and OC2-hosted service features.

Default assumption: keep `packages/app` as the local app because the requirement excludes "non-app" features. Delete `packages/web` and every project whose only purpose is hosted web, docs, deployment, or `oc2.ai` service integration.

## Current State

- Root `package.json:8-24` includes hosted/non-core scripts: `dev:web`, `dev:console`, `dev:stats`, and `dev:storybook`.
- Root `package.json:26-34` includes workspace globs for `packages/console/*`, `packages/stats/*`, `github`, `packages/sdk/js`, and `packages/slack`.
- `packages/web/package.json:2-12` is `@oc2-ai/web`, an Astro docs/site project with `dev:remote` using `https://api.oc2.ai`.
- `packages/app/package.json:2-25` is the local Solid/Vite app; keep it unless reviewers choose CLI/TUI-only later.
- `packages/opencode/src/server/shared/ui.ts` proxies fallback UI to `https://app.oc2.ai` and embeds generated app UI.
- `packages/core/src/naming.ts:13-18` defines `https://oc2.ai/config.json` and `oc2.ai` as canonical domain values.
- `packages/opencode/src/cli/cmd/account.ts` and `packages/opencode/src/account/account.ts` implement hosted device login against `https://console.oc2.ai`.
- `packages/opencode/src/share/share-next.ts` and `packages/opencode/src/share/session.ts` implement hosted share/cloud sync through `opncd.ai` or account-backed share APIs.
- `packages/opencode/src/cli/cmd/github.handler.ts` and `github/` implement hosted GitHub Action/OIDC/share flows through `https://api.oc2.ai` and `https://oc2.ai`.
- `packages/tui/src/attention.ts:17-22` imports TUI audio assets from `@oc2-ai/ui`, so `packages/ui` is not web-only in the first pass.
- `turbo.json:28-45` has explicit `@oc2-ai/app` and `@oc2-ai/ui` test tasks.
- `script/check-generated.ts` checks SDK OpenAPI output and UI theme/tailwind generated files.

## Non-Negotiables

- Must delete `packages/web`.
- Must delete or rewrite all hosted OC2 URL references, including `https://oc2.ai`, `console.oc2.ai`, `api.oc2.ai`, `app.oc2.ai`, `opncd.ai`, and legacy hosted `opencode.ai` URLs.
- Must not remove local CLI/TUI/app functionality in the first pass.
- Must not treat provider tools named `webfetch`, `websearch`, or provider-hosted web search as the "web project".
- Keep `packages/server` while local app/server mode remains.
- Keep `packages/ui` until TUI audio assets are moved or `packages/app` is deleted.
- Defer deleting `packages/http-recorder`; it is test-only but used by `packages/core`, `packages/llm`, and `packages/opencode`.
- Every implementation slice must get a fresh read-only adversarial diff review before it is checked off.

## Pruning Map

Delete in first pass:

- `packages/web`
- `packages/console/*`
- `packages/stats/*`
- `packages/enterprise`
- `packages/function`
- `infra/*`
- `sst.config.ts`
- `packages/slack`
- `packages/storybook`
- `packages/docs`
- `packages/containers`
- `github`
- Hosted deploy, Storybook, container, GitHub Action publish/release workflows

Keep in first pass:

- `packages/opencode`
- `packages/cli`
- `packages/core`
- `packages/server`
- `packages/tui`
- `packages/app`
- `packages/ui`
- `packages/sdk/js`
- `packages/plugin`
- `packages/llm`
- `packages/script`
- Effect/SQLite helper packages

Decision-needed:

- `packages/sdk-legacy`
- `packages/plugin-legacy`
- Historical DB migrations for deleted share tables

## Hosted Feature Removal

Remove these from retained packages:

- Hosted account login:
  - Remove `console.oc2.ai` device login as a default path.
  - Delete or hide account commands that only authenticate to OC2-hosted services.
- Hosted share:
  - Remove `/share` commands, auto-share config behavior, local server share endpoints, TUI/app share actions, and share tests.
  - Remove hosted share sync code and generated SDK routes.
- Hosted GitHub Action:
  - Delete the `github/` package.
  - Remove `packages/opencode/src/cli/cmd/github*` code paths that call `api.oc2.ai`, create hosted app installs, or produce hosted share links.
- Managed OC2 provider:
  - Remove `oc2`/Zen/Go managed provider autoloading and upsell links.
  - Keep ordinary provider configuration through user-owned API keys.
- Hosted app fallback:
  - Remove proxy fallback to `https://app.oc2.ai`.
  - Local app must work against a local backend only.
- Hosted docs/help:
  - Rewrite `README.md`, `CONTRIBUTING.md`, and retained docs to avoid hosted OC2 links.
  - Delete docs that only describe hosted share, hosted GitHub Action, Zen/Go, console, stats, enterprise, or hosted install flows.

## Implementation Slices

### PR 1: Delete Hosted Web And Deploy Surfaces

- Delete `packages/web`, `packages/console/*`, `packages/stats/*`, `packages/enterprise`, `packages/function`, `infra/*`, and `sst.config.ts`.
- Remove root scripts for deleted surfaces from `package.json`: `dev:console`, `dev:stats`, and hosted docs/web scripts.
- Remove deleted workspace globs from `package.json`.
- Remove SST/deploy-only dependencies from root catalog/dev dependencies when no retained package uses them.
- Update `turbo.json`, `script/ci-scope.ts`, and workflows that reference deleted packages.

Verification:

- `bun install --frozen-lockfile`
- `bun run check:packages`
- `bun run typecheck`

Review:

Fresh read-only reviewer checks the diff for deleted-package imports, workspace drift, CI references to deleted packages, and accidental removal of retained local app/server code.

### PR 2: Remove Hosted Account, Share, GitHub Action, And Managed Provider Code

- Remove hosted account login paths from `packages/opencode/src/cli/cmd/account.ts` and `packages/opencode/src/account/account.ts`.
- Remove hosted share implementation from `packages/opencode/src/share/*`, server routes, app/TUI commands, config schema, tests, and generated API surface.
- Remove hosted GitHub Action command paths from `packages/opencode/src/cli/cmd/github*`.
- Remove managed `oc2`/Zen/Go provider behavior from `packages/opencode/src/provider/provider.ts`, retry actions, app dialogs, and TUI dialogs.
- Regenerate OpenAPI and JS SDK if server routes or schemas change.

Verification:

- `bun run check:generated`
- `bun run --cwd packages/opencode typecheck`
- `bun run --cwd packages/opencode test`
- `bun run --cwd packages/opencode test:httpapi`
- `bun run --cwd packages/server typecheck`
- `bun run --cwd packages/sdk/js typecheck`
- `bun run --cwd packages/sdk/js build`

Review:

Fresh read-only reviewer checks removed routes/config against generated SDK diffs and confirms no retained command still calls OC2-hosted domains.

### PR 3: Keep Local App, Remove Hosted App Fallback

- Remove `https://app.oc2.ai` proxy fallback from `packages/opencode/src/server/shared/ui.ts`.
- Update CORS and hosted-origin tests that allow `oc2.ai` app domains.
- Remove app changelog, favicon, Discord/help, share, Zen, and Go links that point to hosted OC2 URLs.
- Preserve local app dev/build flow from `packages/app/package.json`.
- Keep `packages/ui` because `packages/app` and TUI audio still use it.

Verification:

- `bun run --cwd packages/app typecheck`
- `bun run --cwd packages/app test:ci`
- `bun run --cwd packages/app build`
- `bun run --cwd packages/ui typecheck`
- `bun run --cwd packages/ui test:ci`
- `bun run --cwd packages/tui typecheck`
- `bun run --cwd packages/tui test`

Review:

Fresh read-only reviewer verifies the app still targets local backend behavior only and that no app/server fallback reaches hosted OC2 URLs.

### PR 4: Delete Non-Core Integrations And Docs-Only Trees

- Delete `packages/slack`, `packages/storybook`, `packages/docs`, `packages/containers`, and `github`.
- Delete Storybook, GitHub Action publish/release, deploy, and container workflows.
- Remove root scripts `dev:storybook` and remaining workspace entries for deleted packages.
- Remove package catalog dependencies used only by deleted projects.
- Decide and apply treatment for `packages/sdk-legacy` and `packages/plugin-legacy`.

Verification:

- `bun install --frozen-lockfile`
- `bun run check:packages`
- `bun run typecheck`
- `bun run --cwd packages/cli typecheck`
- `bun run --cwd packages/llm typecheck`
- `bun run --cwd packages/llm test`

Review:

Fresh read-only reviewer checks package boundaries, lockfile changes, workflow references, and confirms no retained package imports deleted integrations.

### PR 5: Final URL Sweep And Template Docs

- Rewrite `README.md`, `CONTRIBUTING.md`, and `packages/onboarding.md` for a local template.
- Remove or rewrite generated docs/tests/fixtures that still contain hosted OC2 URL references.
- Replace config/schema URLs with local or relative schema references.
- Ensure final search returns no hosted OC2 URL/domain references.

Verification:

- `rg -n "https://([^/]+\\.)?oc2\\.ai|https://opncd\\.ai|https://opencode\\.ai|console\\.oc2\\.ai|api\\.oc2\\.ai|app\\.oc2\\.ai|opncd\\.ai" .`
- `bun run lint`
- `bun run check:packages`
- `bun run check:generated`
- `bun run typecheck`

Review:

Fresh read-only reviewer checks the final URL sweep output, docs accuracy, generated file consistency, and absence of hidden hosted behavior.

## Future Work

- Delete `packages/app` and split `packages/ui` audio into `packages/tui` if the template later becomes CLI/TUI-only.
- Reset DB migrations after deciding this repo no longer supports existing local databases.
- Rename package scopes away from `@oc2-ai` if the template wants full brand removal, not just hosted URL removal.
- Replace release automation with a minimal fork-owned publish workflow.

## Open Questions

- Should `packages/sdk-legacy` and `packages/plugin-legacy` be deleted? Default: delete unless reviewers require published compatibility.
- Should old share DB migrations be removed or left inert? Default: leave migrations until a dedicated DB-reset PR.
- Should `packages/app` remain in scope? Default: keep it as the local app because the requirement excludes non-app features.
