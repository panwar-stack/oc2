# Model & Variant Picker

## Goal

Bring opencode's model and variant picker experience into oc2 as a focused TUI feature: users can open a keyboard-driven picker, search available providers/models, choose a model, choose a model variant when one exists, and have that selection apply to subsequent prompts in the current session.

Implement this separately from `specs/03-slash-commands.md`. Slash commands own `/` prefix parsing, command autocomplete, and prompt-template dispatch. This spec owns provider/model/variant discovery, TUI picker state, display, and run-time model selection.

## Current State

- `src/model/provider.ts:33-40` defines `ModelInfo` with `id`, `name`, `contextWindow`, `maxOutputTokens`, `supportsTools`, and `supportsReasoning`; there is no variant metadata.
- `src/model/provider.ts:43-52` defines `ModelRequest.providerOptions`, which can carry provider-specific runtime options without changing every provider signature.
- `src/model/provider.ts:128-134` defines `ModelProvider.listModels()` and `ModelProvider.stream()`; the picker can reuse the existing provider abstraction.
- `src/model/model-service.ts:21-29` exposes `listProviders()` and `listModels(providerId)`.
- `src/model/model-service.ts:46-57` throws a recoverable `RuntimeError` for unknown providers.
- `src/model/model-service.ts:147-149` delegates listing to the provider on each call; there is no model-list cache.
- `src/model/fake-provider.ts:36-47` supports deterministic model fixtures for tests.
- `src/config/schema.ts:62-66` only configures `model.provider` and `model.model`.
- `src/config/schema.ts:94-98` defaults to `fake/test`.
- `src/config/env.ts:20-33` supports `OC2_MODEL=provider/model`.
- `src/session/run.ts:39-49` accepts `RunPromptInput.model?: string`.
- `src/session/run.ts:94-106` resolves `input.model ?? profile.defaultModel ?? config.model`, persists provider/model only when creating a new session, and ignores `input.model` for resumed sessions because `resumeSession()` returns the existing persisted session.
- `src/agent/agent.ts:78-85` sends requests using `input.session.providerId` and `input.session.modelId`; it does not receive a selected variant.
- `src/persistence/schema.ts:26-38` persists `provider_id`, `model_id`, and `metadata_json` on sessions.
- `src/persistence/repositories/sessions.ts:71-94` writes provider/model at session creation; there is no method to update a session's model selection.
- `src/tui/app.tsx:23-33` accepts `TuiLaunchOptions.model?: string` and injected providers.
- `src/tui/app.tsx:91-123` submits prompts with `model: options.model`; there is no runtime-selected model state.
- `src/tui/state.ts:108-126` has no provider/model/variant fields, picker mode, picker query, selected index, loading state, or model-list error state.
- `src/tui/keymap.ts:1-37` has no picker key actions and does not parse arrow keys.
- `src/tui/components/SessionView.tsx:22-31` hides side panels below width `80`; picker rendering must define behavior for narrow terminals.
- `src/tui/components/Footer.tsx:3-5` is the current place to show TUI key hints.
- `src/cli/commands.ts:128-140`, `src/cli/commands.ts:184-206`, and `src/cli/commands.ts:209-225` already parse `--model` for `tui`, `run`, and `resume`.
- `src/cli/index.ts:190-204` passes TUI `--model` to `launchTui()`.
- `src/cli/index.ts:269-292` passes CLI run/resume `--model` to `SessionRunService.run()`.
- `specs/03-slash-commands.md:31-35` requires slash autocomplete to be a unified overlay for TUI-local and backend slash commands; do not reuse that overlay for model selection.
- `specs/03-slash-commands.md:40-61` allows `SlashCommand.model` as a command metadata override; this spec must not redefine slash command data types.
- `specs/03-slash-commands.md:248` removes `--provider`; keep `provider/model` as the canonical model string.
- OpenCode reference behavior lives in `/Users/srpanwar/Documents/Workspace/brain/opencode/packages/tui/src/component/dialog-model.tsx:12-185`, `packages/tui/src/component/dialog-variant.tsx:6-39`, `packages/tui/src/context/local.tsx:133-402`, `packages/tui/src/app.tsx:596-693`, and `packages/tui/src/component/prompt/index.tsx:1340-1508`. Use these as behavior references only; do not copy code.

## Non-Negotiables

- Do not merge this into `specs/03-slash-commands.md`; model selection is not slash-command parsing.
- Do not add `/model`, `/models`, `/variant`, or slash autocomplete behavior in the first pass.
- Keep `provider/model` as the canonical external model string for CLI, env, config, and TUI launch options.
- Do not add `--provider`; `--model <provider/model>` remains the CLI surface.
- Do not add web/server/generated SDK dependencies; oc2 stays dependency-light and local.
- Do not persist API keys, provider headers, or provider config in picker state.
- Variant runtime options must be non-secret provider-authored knobs only; providers must not put auth values, request headers, base URLs, or full provider config in model metadata.
- Do not write to `oc2.jsonc` from the TUI picker in the first pass; picker changes affect the active session, not global defaults.
- Do not copy opencode source code. Adapt behavior and data contracts to oc2's plain TypeScript/text-rendered TUI.
- The first pass must be deterministic with the fake provider and testable without network access.
- Unknown provider/model or model-list failure must render a recoverable TUI error, not crash the process.
- Picker UI must be mutually exclusive with side panel content while open.
- Picker UI must also be mutually exclusive with slash suggestions from `specs/03-slash-commands.md`; priority order is `modelPickerOpen`, then `slashActive`, then side panel/question close handling.
- Variant support must be optional. Providers with no variants continue to work unchanged.

## Reference Behavior To Adapt

- OpenCode has a model picker and a separate variant picker. Selecting a model can immediately open the variant picker when that model has variants and the previous variant is no longer valid.
- OpenCode displays active provider/model in the prompt/footer area and displays variant metadata only when a non-default variant is active.
- OpenCode variant selection includes a synthetic `Default` option plus one row per variant.
- OpenCode variant cycling uses the order `default -> first variant -> next variant -> default`.
- OpenCode has recents/favorites and connected-provider filtering. Leave persistent recents/favorites out of oc2's first pass; keep them in Future Work.

## Data Model

### Provider Model Metadata

Extend `src/model/provider.ts` with a small optional variant shape:

```ts
export type ShallowJsonValue = string | number | boolean | null | readonly ShallowJsonValue[]
export type ShallowJsonObject = Readonly<Record<string, ShallowJsonValue>>

export interface ModelVariantInfo {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly runtimeOptions?: ShallowJsonObject
}

export interface ModelInfo {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly supportsTools?: boolean
  readonly supportsReasoning?: boolean
  readonly variants?: readonly ModelVariantInfo[]
}
```

Rules:

- `variants` defaults to `[]` when absent.
- `variant.id` must be unique within one model.
- Use an array, not `Record<string, unknown>`, because oc2 TUI needs stable display order and does not use generated SDK types.
- `runtimeOptions` is shallow JSON-compatible and non-secret; providers may ignore it until they support variants.
- Add a runtime validator for `runtimeOptions` before passing it into `ModelRequest.providerOptions`; reject functions, symbols, class instances, and cyclic values with a recoverable error.
- `src/model/fake-provider.ts` must accept variants through its existing `models` fixture input for deterministic tests.

### Active Selection

Add a TUI-level selection type in `src/tui/state.ts` or a new `src/tui/model-picker.ts` if helper functions become easier to test independently:

```ts
export interface TuiModelSelection {
  readonly providerId: string
  readonly providerName?: string
  readonly modelId: string
  readonly modelName?: string
  readonly variantId?: string
  readonly variantName?: string
}

export interface TuiModelOption {
  readonly providerId: string
  readonly providerName: string
  readonly model: ModelInfo
}

export interface TuiVariantOption {
  readonly id?: string // undefined means Default
  readonly label: string
  readonly description?: string
  readonly runtimeOptions?: ShallowJsonObject
}
```

### TuiState Extensions

Keep fields flat, consistent with `src/tui/state.ts:108-126`:

```ts
readonly modelSelection: TuiModelSelection
readonly modelPickerOpen: boolean
readonly modelPickerMode: "model" | "variant"
readonly modelPickerQuery: string
readonly modelPickerSelectedIndex: number
readonly modelPickerLoading: boolean
readonly modelPickerError?: string
readonly modelOptions: readonly TuiModelOption[]
readonly variantOptions: readonly TuiVariantOption[]
```

Initial values:

- `modelSelection` comes from launch `--model`, then agent profile default, then `config.model`.
- If only `provider/model` is known and model metadata has not loaded, display IDs as labels.
- `modelPickerOpen: false`.
- `modelPickerMode: "model"`.
- `modelPickerQuery: ""`.
- `modelPickerSelectedIndex: 0`.
- `modelPickerLoading: false`.
- `modelPickerError: undefined`.
- `modelOptions: []`.
- `variantOptions: []`.

### Session Selection Input

Extend `RunPromptInput` in `src/session/run.ts`:

```ts
export interface RunPromptInput {
  readonly prompt: string
  readonly sessionId?: string
  readonly model?: string
  readonly modelVariant?: string
  readonly modelVariantOptions?: ShallowJsonObject
  readonly enabledTools?: readonly string[]
  readonly disabledTools?: readonly string[]
  readonly enabledMcp?: readonly string[]
  readonly disabledMcp?: readonly string[]
  readonly roots?: readonly string[]
  readonly signal?: AbortSignal
}
```

Rules:

- `model` remains `provider/model`.
- `modelVariant` is the selected variant ID; `undefined` means default.
- `modelVariantOptions` is copied from the selected `ModelVariantInfo.runtimeOptions` after runtime validation.
- `modelVariantOptions` must be shallow JSON-compatible data only. Add tests that invalid values are rejected before reaching `ModelRequest.providerOptions`.

## TUI Behavior

### Key Bindings

Add to `src/tui/keymap.ts`:

| Key                      | Action                    | Notes                                                                                           |
| ------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `Ctrl+P` (`\u0010`)      | `model-picker-toggle`     | Opens model picker; closes it if already open.                                                  |
| `Ctrl+V` (`\u0016`)      | `variant-cycle`           | Cycles current model variant without opening picker.                                            |
| `ArrowUp` (`\u001b[A`)   | `picker-up`               | Only affects picker when open; otherwise `noop` for first pass.                                 |
| `ArrowDown` (`\u001b[B`) | `picker-down`             | Only affects picker when open; otherwise `noop` for first pass.                                 |
| `Enter`                  | `submit` or picker select | Existing `submit` action remains; `app.tsx` routes it to picker selection while picker is open. |
| `Escape`                 | close picker              | Picker close has priority over panel/question close.                                            |
| `Backspace`              | edit picker query         | While picker is open, edits `modelPickerQuery`, not prompt input.                               |
| printable ASCII          | edit picker query         | While picker is open, appends to `modelPickerQuery`, not prompt input.                          |

Do not use `Ctrl+M` because it conflicts with Enter on many terminals and current MCP behavior. Do not use `Ctrl+T` because it already toggles the team panel.

### Overlay Priority

If `specs/03-slash-commands.md` is already implemented, the model picker and slash suggestions must not render at the same time.

- Opening the model picker clears `slashActive`, `slashQuery`, and `slashMatches`.
- Slash detection is disabled while `modelPickerOpen` is true.
- Escape handling priority is: close model picker, then clear slash suggestions, then answer/close question or panel.
- `SessionView` renders at most one transient overlay in this order: `ModelPicker`, then `SlashSuggestions`, then `SidePanel`.

### Opening The Picker

When `model-picker-toggle` opens the picker:

- Set `modelPickerOpen: true`, `modelPickerMode: "model"`, `modelPickerQuery: ""`, `modelPickerSelectedIndex: 0`, and clear `modelPickerError`.
- If `modelOptions` is empty, call a new TUI-facing service method that lists providers and models.
- While loading, render `Loading models...` and do not block existing streaming output.
- If provider/model listing fails, set `modelPickerError` to the redacted error message and keep the picker open so the user can press Escape.
- If one provider fails to list but others succeed, include successful providers and show a footer warning like `1 provider failed to list`.

### Filtering And Sorting

Flatten provider/model options from `ModelService.listProviders()` and `listModels(providerId)`.

Default sorting:

- Sort providers by `provider.name`, then `provider.id`.
- Within each provider, sort models by `model.name ?? model.id`.
- Keep provider groups visible in the renderer through each option's `providerId` and `providerName`.

Filtering:

- `modelPickerQuery` matches case-insensitively against `providerId`, `providerName`, `model.id`, and `model.name`.
- Empty query shows all options.
- Cap visible rows to `min(10, terminalHeightIndependentCap)` because the current renderer does not know terminal height.
- Clamp `modelPickerSelectedIndex` after every query change.

### Selecting A Model

When Enter is pressed in model mode:

- If there are no filtered rows, keep picker open and show `No matching models`.
- Set `modelSelection.providerId`, `modelSelection.providerName`, `modelSelection.modelId`, and `modelSelection.modelName` from the selected row.
- If the selected model has variants, switch to `modelPickerMode: "variant"`, build `variantOptions`, clear `modelPickerQuery`, and keep picker open.
- If the selected model has no variants, clear `variantId` and `variantName`, close the picker, and use the selection for subsequent prompts.
- Selecting a different model must clear an incompatible previous variant.

### Selecting Or Cycling A Variant

Build variant options from the selected model:

```ts
const options = [
  { id: undefined, label: "Default" },
  ...model.variants.map((variant) => ({
    id: variant.id,
    label: variant.name ?? variant.id,
    description: variant.description,
    runtimeOptions: variant.runtimeOptions,
  })),
]
```

When Enter is pressed in variant mode:

- Apply the selected variant.
- Close the picker.
- `Default` clears `variantId`, `variantName`, and `modelVariantOptions`.
- Non-default variants copy validated `runtimeOptions` into `modelVariantOptions`.

When `variant-cycle` is pressed:

- If the active model has no variants or model metadata is not loaded, append a local diagnostic message or footer error: `No variants for current model`.
- Cycle in order: default, first variant, next variant, default.
- Do not open the picker.

### Rendering

Create `src/tui/components/ModelPicker.tsx`:

```ts
export function ModelPicker({ state, width }: { readonly state: TuiState; readonly width?: number }): string
```

Rendering behavior:

- Return `""` when `modelPickerOpen` is false.
- Render below `MessageList` and above `PromptInput`, replacing `SidePanel` while open.
- For width `<80`, render the same picker in full width; unlike side panels, the picker must remain usable on narrow terminals.
- Header examples: `Select model`, `Select variant for fake/test`.
- Query line: `Search: <query>`.
- Selected row prefix: `>`.
- Unselected row prefix: two spaces.
- Model row format: `<providerName>/<modelName>  <providerId>/<modelId>  [tools] [reasoning]`.
- Variant row format: `<label>  <description>`.
- Footer: `Up/Down move | Enter select | Esc close | Ctrl+V cycle variant`.
- Truncate long model names/descriptions to fit `width` with an ASCII `...` suffix.

Update existing components:

- `src/tui/components/SessionView.tsx`: render `ModelPicker` instead of `SidePanel` when `modelPickerOpen` is true.
- `src/tui/components/Footer.tsx`: include active model as `model <provider>/<model>` and append `:<variant>` only when a variant is active.
- `src/tui/components/SidePanel.tsx`: add active provider/model/variant lines to the session panel.

Example:

```text
oc2 tui

--- model picker ---
Select model
Search: sonnet
> Anthropic/Claude Sonnet 4  anthropic/claude-sonnet-4  [tools] [reasoning]
  Anthropic/Claude 3.7 Sonnet  anthropic/claude-3-7-sonnet  [tools]
Up/Down move | Enter select | Esc close | Ctrl+V cycle variant

Prompt>
Enter submit | Ctrl+P model | Ctrl+V variant | Ctrl+S side panel | Ctrl+C cancel/exit | model anthropic/claude-sonnet-4
```

## Session, Config, And Persistence

### Applying Selection To Runs

`src/tui/app.tsx` must keep the active model selection in `TuiState`, not only in `TuiLaunchOptions.model`.

On submit:

- Pass `model: `${providerId}/${modelId}``from`state.modelSelection`.
- Pass `modelVariant` and `modelVariantOptions` when a non-default variant is selected.
- If no picker interaction has occurred, this preserves existing `--model`, agent default, and config default behavior.

### Existing Sessions

Changing model in an existing session must affect the next prompt in that session.

Add a narrow session update path instead of creating a new session:

```ts
// src/persistence/repositories/sessions.ts
updateModelSelection(input: {
  readonly sessionId: string
  readonly providerId: string
  readonly modelId: string
  readonly variantId?: string
  readonly now?: string
}): SessionRecord
```

Storage rules:

- Update `sessions.provider_id` and `sessions.model_id`.
- Store variant in `sessions.metadata_json.modelVariant` when present.
- Remove `metadata_json.modelVariant` when default variant is selected.
- Do not add a SQLite migration in the first pass; use existing `metadata_json`.
- If the session is currently running, reject model update with a recoverable `RuntimeError` using `details.reason = "run_already_active"`.

`SessionRunService.run()` behavior:

- For a new session, create with selected provider/model and `metadata.modelVariant` when provided.
- For a resumed session with `input.model`, validate/resume the session, reject if it is active or already persisted as `running`, update model selection, then call `tryStartRun()`.
- For a resumed session with no `input.model`, keep the persisted session model.
- Pass `modelVariant` to the agent for provider options.

### Provider Options

Extend `MainAgentRunInput` in `src/agent/agent.ts`:

```ts
readonly modelVariant?: string
readonly modelVariantOptions?: ShallowJsonObject
```

When collecting from the model, merge provider options as:

```ts
providerOptions: {
  ...input.modelVariantOptions,
  ...(input.modelVariant ? { variant: input.modelVariant } : {}),
  timeoutMs: input.profile.timeoutMs ?? input.config.runtime.defaultTimeoutMs,
}
```

Rules:

- `timeoutMs` must keep existing precedence and must not be overwritten by variant options.
- `variant` must be omitted when `modelVariant` is undefined.
- Providers that do not recognize `variant` ignore it.
- Provider-authored `runtimeOptions` must be validated before this merge and must never contain secrets or transport configuration.

### Config

Do not extend `Oc2Config` in the first pass.

Rationale:

- `model.provider` and `model.model` already define the global default.
- TUI picker selection is session-local.
- Persistent recents/favorites and default variants can be added later without blocking picker basics.

## Error Handling And Edge Cases

- Empty provider list: render `No providers configured` and keep picker open until Escape.
- Provider exists but `listModels()` returns empty: render the provider with no selectable rows and show `No models available` if all providers are empty.
- Unknown `--model` provider: keep existing `RuntimeError` behavior and display it in the TUI error banner.
- Unknown model ID from `--model`: allow it as an active selection by ID until model metadata loads; if the user opens the picker and chooses a listed model, replace it.
- Variant selected, then model changed: clear variant unless the new model has the same variant ID.
- Variant selected, then provider listing fails: keep the active selected IDs, but disable cycling with a footer error.
- Prompt running: do not allow picker selection to update session model while `state.running` is true; render `Cannot change model while a run is active`.
- Narrow terminal: picker remains visible; side panel remains hidden as it is today.
- Multi-byte input: keep current ASCII-only limitation from `src/tui/keymap.ts:35` for first pass.

## Implementation Slices

### PR 1: Variant Metadata And Selection Plumbing

- Extend `src/model/provider.ts` with `ModelVariantInfo` and optional `ModelInfo.variants`.
- Extend `src/model/fake-provider.ts` tests/fixtures to cover models with variants.
- Extend `RunPromptInput` in `src/session/run.ts` with `modelVariant` and `modelVariantOptions`.
- Extend `MainAgentRunInput` in `src/agent/agent.ts` with variant fields.
- Merge variant provider options into `providerOptions` while preserving `timeoutMs` precedence.
- Add tests that verify fake-provider requests receive `providerOptions.variant` when a variant is selected and omit it for default.
- Add tests that invalid `runtimeOptions` values are rejected before reaching `ModelRequest.providerOptions`.

Verification:

- `bun test test/model test/session`
- `bun run typecheck`
- `bun run format:check`
- `bun run lint`

Review:

Before merging, a fresh read-only reviewer must compare the PR diff against this slice and verify: variant fields are optional, providers without variants still typecheck, `timeoutMs` cannot be overwritten by variant options, invalid runtime options are rejected, and fake-provider tests do not require network access.

### PR 2: Persist Session Model Selection Updates

- Add `SessionRepository.updateModelSelection()` in `src/persistence/repositories/sessions.ts` using existing `metadata_json`; do not change `CURRENT_SCHEMA_VERSION`.
- Add a `SessionService` wrapper for model-selection updates if the service layer is the existing call site pattern.
- Update `SessionRunService.run()` so resumed sessions with `input.model` validate active/running status, then update persisted provider/model before the run starts.
- Store selected variant as `metadata.modelVariant` when present and remove it for default.
- Reject updates while the session is already running with a recoverable `RuntimeError`.
- Add tests for new session selection, resumed session selection override, resumed session without override, running-session rejection without metadata mutation, and variant metadata clearing.

Verification:

- `bun test test/session test/persistence`
- `bun run typecheck`
- `bun run format:check`
- `bun run lint`

Review:

Before merging, a fresh read-only reviewer must verify: no SQLite migration was added, `metadata_json` merges preserve unrelated metadata, existing `resume` behavior remains unchanged when no model override is provided, running-session rejection does not mutate model metadata, and `resume --model` now intentionally applies to the next run.

### PR 3: Picker State, Filtering, And Keymap

- Add flat picker fields and model selection fields to `TuiState` in `src/tui/state.ts`.
- Initialize `modelSelection` from a new helper that resolves launch model, profile default, and config default in the same order as `SessionRunService.run()`.
- Add pure helper functions for filtering, clamping selected index, applying model selection, building variant options, and cycling variants.
- Extend `src/tui/keymap.ts` with `model-picker-toggle`, `variant-cycle`, `picker-up`, and `picker-down`.
- Parse `ArrowUp` and `ArrowDown` escape sequences.
- Update `src/tui/app.tsx` input routing so picker-open state consumes printable input, Backspace, Escape, arrows, and Enter before prompt editing/submission.
- If slash-command state from `specs/03-slash-commands.md` exists, clear slash state when opening the picker and keep slash detection disabled while the picker is open.
- Add tests in `test/tui/state.test.ts` and `test/tui/keymap.test.ts` for picker opening, query filtering, selected-index clamping, variant cycling, and key parsing.

Verification:

- `bun test test/tui/state.test.ts test/tui/keymap.test.ts`
- `bun run typecheck`
- `bun run format:check`
- `bun run lint`

Review:

Before merging, a fresh read-only reviewer must verify: picker key handling has priority only while picker is open, Escape closes picker before slash suggestions and other panels, prompt input is not mutated while searching, and existing `Ctrl+S`, `Ctrl+T`, `Ctrl+M`, Enter, and Ctrl+C behaviors remain covered.

### PR 4: Model Listing And Picker Rendering

- Add a TUI-facing method near `SessionRunService` or a small helper in `src/tui/app.tsx` that calls `service.models.listProviders()` and `service.models.listModels(providerId)` without exposing provider secrets.
- If `SessionRunService.models` is private, add a minimal method such as `listModelOptions(): Promise<readonly TuiModelOption[]>`; do not expose the entire `ModelService` to the TUI.
- Implement provider/model listing with tolerant per-provider error handling, such as `Promise.allSettled`, so one failing provider does not hide successful providers.
- Create `src/tui/components/ModelPicker.tsx` with the rendering behavior defined above.
- Update `src/tui/components/SessionView.tsx` so `ModelPicker` replaces `SidePanel` while open and remains visible below width `80`.
- Update `src/tui/components/Footer.tsx` to show `Ctrl+P model`, `Ctrl+V variant`, and active `provider/model[:variant]`.
- Update `src/tui/components/SidePanel.tsx` to show active provider/model/variant in the session panel.
- Add render tests in `test/tui/app.test.tsx` or a new `test/tui/model-picker.test.ts` for loading, empty list, filtered rows, selected row marker, variant rows, width truncation, footer display, unknown provider error banner, unknown model ID fallback, and partial provider-list failure.

Verification:

- `bun test test/tui`
- `bun run typecheck`
- `bun run format:check`
- `bun run lint`
- Manual: `bun run smoke:tui`, press `Ctrl+C` to exit after verifying the picker hint is visible.

Review:

Before merging, a fresh read-only reviewer must verify: model-list failures render as recoverable UI errors, partial provider-list failures keep successful providers visible, picker rendering does not hide the prompt, narrow width keeps the picker visible, long text is truncated deterministically, and no opencode UI code was copied.

### PR 5: End-To-End Picker Application

- Wire picker selection in `src/tui/app.tsx` so subsequent prompt submission passes selected `model`, `modelVariant`, and `modelVariantOptions` to `service.run()`.
- Prevent model changes while a run is active.
- Add an integration test with injected fake providers: open picker, filter, select a model with variants, select a variant, submit a prompt, and assert the resulting session provider/model/metadata.
- Add an integration test for `Ctrl+V` variant cycling and default clearing.
- Add a regression test that launching `tui --model fake/test` still uses `fake/test` before any picker interaction.
- Update `README.md` TUI section with `Ctrl+P` and `Ctrl+V` behavior.
- Do not update slash-command docs except for a one-line cross-reference if needed.

Verification:

- `bun test test/tui test/session test/cli`
- `bun run check`
- Manual: `bun run start tui --model fake/test`, press `Ctrl+P`, verify the picker opens, press `Escape`, verify prompt input still works.

Review:

Before merging, a fresh read-only reviewer must verify: selected model applies to existing sessions, default variant clears metadata, CLI `--model` remains canonical, slash command spec behavior is untouched, and README instructions match implemented keys.

## Future Work

- Persistent recent models and favorites, stored in a small TUI-local data file under oc2 data dir.
- Recent/favorite cycling keys after persistence exists.
- `oc2 models list` CLI command for non-TUI discovery.
- Config-level default variant, if real providers expose stable variant IDs.
- Provider-specific variant adapters for OpenAI-compatible reasoning effort, Anthropic thinking budgets, or other provider-native knobs.
- Slash-command alias such as `/models` only after `specs/03-slash-commands.md` lands and only as a TUI-local command that opens the same picker.
- Fuzzy ranking; first pass uses simple case-insensitive substring matching.
- Persist per-message variant metadata if transcript export needs to show exact variant per assistant response.

## Open Questions

- **Should changing the picker update the global config default?** Default: no. Keep picker selection session-local to avoid surprising writes to `oc2.jsonc`.
- **Should `resume --model` update the resumed session model?** Default: yes. This fixes the current mismatch where `RunPromptInput.model` is ignored for resumed sessions and makes CLI/TUI selection behavior consistent.
- **Should variants be represented as an array or object?** Default: array. oc2 has no generated SDK constraint, and arrays preserve display order.
- **Should model listing be cached?** Default: no cache in the first pass. The picker can keep loaded options in TUI state for the current process; persistent caching is future work.
