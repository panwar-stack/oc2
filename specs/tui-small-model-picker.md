# TUI Small Model Picker

## Goal

Add a TUI command that lets users configure the existing project-level `small_model` setting through a picker similar to `/models`.

The first pass must use the current config field, not introduce `small_models`. Selecting a model persists:

```json
{
  "small_model": "provider/model-id"
}
```

This makes title generation and any future `Provider.getSmallModel(...)` consumers use the selected small model.

## Current State

- `packages/opencode/src/config/config.ts` defines `small_model?: string` next to `model`.
- `packages/opencode/src/provider/provider.ts` reads `cfg.small_model` in `Provider.getSmallModel(providerID)`.
- `packages/opencode/src/session/prompt.ts` uses small models for title generation after `agent.title.model` and before falling back to the session model.
- `packages/opencode/src/cli/cmd/tui/app.tsx` registers `/models` as `model.list`.
- `packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx` implements the current model picker.
- `packages/opencode/src/cli/cmd/tui/context/local.tsx` stores active TUI model state, recents, favorites, and variants, but does not write config.
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx` already exposes `sync.data.config` and provider catalogs.
- `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts` exposes `PATCH /config`.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts` marks the instance for disposal after config updates.
- `packages/web/src/content/docs/config.mdx` documents `small_model`.
- `packages/web/src/content/docs/tui.mdx` documents TUI commands like `/models`.

## Non-Negotiables

- Must use existing `small_model`; do not add a new `small_models` config field in the first pass.
- Must not mutate primary model state through `local.model.set`.
- Must not pollute primary model recents, favorites, or variants.
- Must allow small candidates such as `opencode/*-nano`; do not inherit the `/models` nano disable rule.
- Must filter deprecated models before writing config.
- Must write only a valid `provider/model` string selected from `sync.data.provider`.
- Must run tests from package directories, never from repo root.
- Leave global config writes, per-agent title model config, and multiple small-model slots out of the first pass.

## Session Usage

No extra session-level wiring is needed for the current title-generation behavior.

- Individual sessions keep using their normal active model for chat.
- When title generation runs, `packages/opencode/src/session/prompt.ts` chooses the model in this order:
  - `agent.title.model`, when configured.
  - `Provider.getSmallModel(input.providerID)`.
  - The current session model.
- `Provider.getSmallModel(...)` reads the current workspace config and honors `small_model` when it is set.
- The configured `small_model` is project/config-level, not per-session.
- A configured `small_model` can point to a different provider than the active session provider.
- Today, `Provider.getSmallModel(...)` is only called by title generation.
- Future small-model tasks must explicitly call `Provider.getSmallModel(...)`; do not assume the setting affects normal chat.

## TUI Behavior

Add a slash command:

```ts
{
  name: "small_model.list",
  title: "Configure small model",
  category: "Agent",
  slashName: "small-models"
}
```

Behavior:

- `/small-models` opens a new `DialogSmallModel`.
- The dialog uses the same visual picker pattern as `/models`.
- The dialog lists provider models grouped by provider.
- The dialog marks `sync.data.config.small_model` as the configured selection when it exists and is valid.
- If `small_model` is unset, show copy indicating opencode will auto-select a small model per provider.
- If `small_model` points to a missing provider/model, show a non-selectable warning row and let the user replace it.
- Selecting an option sends `PATCH /config` with `{ "small_model": "provider/model-id" }`.
- After a successful update, refresh TUI sync config state and close the dialog.
- On update failure, keep the dialog open and show the existing TUI error notification pattern.
- Do not open `DialogVariant`; variants are not part of `small_model` config today.
- Do not add a default keybind; slash command discovery is enough for the first pass.

## API And Config

Use the existing config API:

```http
PATCH /config
Content-Type: application/json

{
  "small_model": "anthropic/claude-haiku-4-5"
}
```

Implementation constraints:

- Use the generated SDK config update call already available to the TUI.
- Send a minimal patch payload; do not send the full current config back from TUI.
- Refresh or reload TUI sync state after update because config updates dispose the current instance.
- No OpenAPI or SDK regeneration is required unless a new TUI HTTP endpoint is added.

## Implementation Slices

### PR 1: Small Model Picker UI

- Add `packages/opencode/src/cli/cmd/tui/component/dialog-small-model.tsx`.
- Reuse existing provider catalog data from `useSync()`.
- Reuse `DialogSelect` and provider connection affordances from the `/models` flow.
- Share only small, behavior-preserving model option utilities from `dialog-model.tsx` if needed.
- Add tests for option filtering, current `small_model` marking, deprecated exclusion, and nano model availability.

Verification:

- `cd packages/opencode && bun test test/cli/cmd/tui/model-options.test.ts`
- `cd packages/opencode && bun test test/cli/cmd/tui/small-model-dialog.test.tsx`
- `cd packages/opencode && bun typecheck`

Review:

Before checking off this slice, have a fresh read-only reviewer compare the diff against this plan and confirm `/models` behavior did not change.

### PR 2: Command Wiring And Config Persistence

- Register `small_model.list` in `packages/opencode/src/cli/cmd/tui/app.tsx`.
- Add keybind config support only if required by the command system, defaulting to `none`.
- On selection, call the existing config update API with `{ small_model: `${providerID}/${modelID}` }`.
- Refresh `sync.data.config` after update so the selected row reflects the persisted config.
- Add focused coverage for command/keymap wiring and config update behavior.

Verification:

- `cd packages/opencode && bun test test/cli/tui/keymap.test.tsx`
- `cd packages/opencode && bun test test/server/httpapi-config.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Before checking off this slice, have a fresh read-only reviewer verify the diff never calls `local.model.set`, never writes model recents/favorites, and persists only `small_model`.

### PR 3: Docs

- Update `packages/web/src/content/docs/tui.mdx` to document `/small-models`.
- Update `packages/web/src/content/docs/config.mdx` to mention that `small_model` can be configured from the TUI.
- Do not update generated SDK docs unless a public API surface changes.

Verification:

- `cd packages/web && bun run build`
- `cd packages/opencode && bun typecheck`

Review:

Before checking off this slice, have a fresh read-only reviewer confirm the docs distinguish `model` from `small_model` and do not imply multiple small-model slots.

## Future Work

- Add `/open-small-models` TUI HTTP endpoint parity with `/open-models`; if added, regenerate SDK with `./packages/sdk/js/script/build.ts`.
- Add a “Reset to auto” option after config update supports deleting optional keys through the API.
- Add global config targeting if users need `small_model` shared across projects.
- Add small-model-specific recents or favorites only if usage proves it is needed.
- Add a picker for `agent.title.model` if users need per-agent title model overrides.
- Add additional runtime consumers by explicitly calling `Provider.getSmallModel(...)` at those call sites.

## Open Questions

- Should `/small-models` write project config by default? Default: yes, because `PATCH /config` already exists and matches current project-scoped behavior.
- Should the command name be `/small-models` or `/small_models`? Default: `/small-models` for slash-command readability while keeping the config key as `small_model`.
- Should reset-to-auto ship in the first pass? Default: no, because the current JSON API patch shape does not clearly support deleting `small_model`.
