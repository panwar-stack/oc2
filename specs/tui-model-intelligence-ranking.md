# TUI Model Intelligence Ranking

## Goal

Add a local TUI slash command, `/intelligence`, that ranks models available to the current session's connected providers by a deterministic "intelligence proxy" score.

First pass must be small and reviewable: no new HTTP endpoint, no SDK regeneration, no live benchmark calls, and no claim that the score is an absolute benchmark. The command should help users compare connected models using existing model metadata, then optionally switch to a selected model.

## Current State

- `packages/opencode/src/cli/cmd/tui/app.tsx` registers local TUI commands in `appCommands`; `/models` is wired as `model.list` with `slashName: "models"` and opens `DialogModel`.
- `packages/opencode/src/cli/cmd/tui/keymap.tsx` exposes slash commands through `useCommandSlashes()` by reading command entries with `slashName`.
- `packages/opencode/src/command/index.ts` defines prompt-backed LLM commands like `init`, `review`, and `spec-planner`; `/intelligence` should not use this path in the first pass because it needs local provider/model metadata.
- `packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx` already flattens `sync.data.provider`, filters deprecated models, sorts model options, and switches models through `local.model.set(...)`.
- `packages/opencode/src/cli/cmd/tui/util/model.ts` provides provider/model lookup helpers for TUI code.
- `packages/opencode/src/provider/provider.ts` defines model metadata fields: `capabilities.reasoning`, `capabilities.toolcall`, input/output modalities, `limit.context`, `limit.output`, `cost`, `status`, `release_date`, and `variants`.
- `packages/opencode/src/provider/provider.ts` has no benchmark or intelligence score field today.
- Tests must run from `packages/opencode`; root `bun test` intentionally exits.

## Non-Negotiables

- `/intelligence` must be TUI-local in the first pass; do not add HTTP/OpenAPI routes or generated SDK changes.
- Ranking must be deterministic and based only on already-loaded provider/model metadata.
- The UI must label the score as a heuristic, not an absolute intelligence benchmark.
- Deprecated models must be excluded, matching `DialogModel`.
- The command must not spend tokens, call model APIs, or run eval prompts.
- Selecting a ranked model may switch the current model, but opening the dialog must not mutate session/local state.
- Leave benchmark-backed scoring, provider-specific leaderboards, and user-configurable weights out of the first pass.

## TUI Behavior

Add a new command entry near `model.list` in `packages/opencode/src/cli/cmd/tui/app.tsx`:

```ts
{
  name: "model.intelligence",
  title: "Rank models by intelligence",
  category: "Agent",
  slashName: "intelligence",
  run: () => {
    dialog.replace(() => <DialogIntelligence />)
  },
}
```

Create `packages/opencode/src/cli/cmd/tui/component/dialog-intelligence.tsx`.

Dialog behavior:

- Title: `Model intelligence`
- Subtitle/empty hint: `Heuristic ranking from connected model metadata.`
- Source models from `sync.data.provider`.
- Include only models where `model.status !== "deprecated"`.
- Show each option with:
- title: model display name
- category: provider name
- description: short reason string, for example `reasoning, tools, 200k context`
- footer: `Score 82`
- value: `{ providerID: string; modelID: string }`
- Selecting an option must call `local.model.set({ providerID, modelID }, { recent: true })` and close the dialog.
- If no connected providers/models exist, show an empty state and guide the user to `/connect`.

## Ranking Heuristic

Add the ranking logic close to the dialog unless tests or reuse justify a small exported helper.

Use this shape internally:

```ts
type IntelligenceRank = {
  providerID: string
  modelID: string
  score: number
  reasons: string[]
  releaseDate: string
  title: string
}
```

Score must be deterministic:

- `+30` when `model.capabilities.reasoning` is true.
- `+20` when `model.capabilities.toolcall` is true.
- `+15` when `model.limit.context >= 200_000`.
- `+10` when `model.limit.context >= 100_000` and `< 200_000`.
- `+10` when `model.limit.output >= 16_000`.
- `+5` when image or PDF input is supported.
- `+5` when `model.release_date` is present and not empty.

Sort order:

1. `score` descending.
2. `release_date` descending.
3. provider name ascending.
4. model title ascending.

Reason labels must come from the same fields used in the score so users can audit why a model ranked highly.

## Implementation Slices

### PR 1: Add `/intelligence` Dialog

- Add `DialogIntelligence` under `packages/opencode/src/cli/cmd/tui/component/dialog-intelligence.tsx`.
- Compute ranked options from `sync.data.provider`.
- Exclude deprecated models.
- Display score and reason labels.
- Let users select a model using `local.model.set(..., { recent: true })`.
- Register `model.intelligence` in `packages/opencode/src/cli/cmd/tui/app.tsx` with `slashName: "intelligence"`.
- Add the command to `appBindingCommands` if required by the keymap registration path.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/cli/tui/keymap.test.tsx`
- `cd packages/opencode && bun test --timeout 30000 test/cli/cmd/tui/model-options.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer to compare the diff against this slice. The reviewer must confirm there is no HTTP/OpenAPI/SDK change, the dialog excludes deprecated models, and score reasons match score inputs.

### PR 2: Add Focused Ranking Tests

- Add focused tests for the ranking helper if it is exported.
- Cover reasoning/tool/context scoring.
- Cover stable tie-breaking by release date, provider name, and model title.
- Cover deprecated model exclusion.
- Cover empty connected-model behavior if the existing TUI test harness supports it without heavy setup.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/cli/cmd/tui/model-options.test.ts`
- `cd packages/opencode && bun test --timeout 30000 test/cli/tui/keymap.test.tsx`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer to check that tests assert observable ranking behavior instead of duplicating the full implementation. The reviewer must also check that no mocks are added when existing TUI/model fixtures can be reused.

### PR 3: Optional Docs Note

- If the command is user-visible in docs, update the relevant TUI command documentation.
- Document that `/intelligence` is a metadata heuristic and not a benchmark leaderboard.
- Do not add provider-specific benchmark claims.

Verification:

- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer to check wording for overclaiming. The docs must not imply opencode has measured model intelligence.

## Future Work

- Add benchmark-backed scores from a maintained catalog if the project chooses a trusted source.
- Add user-configurable ranking weights.
- Add filters for cost, context size, free models, multimodal support, or provider.
- Add a public API only if non-TUI clients need the same ranking. If that happens, regenerate the JS SDK with `./packages/sdk/js/script/build.ts`.

## Open Questions

- Should selecting a ranked model switch immediately? Default: yes, because `/models` already behaves this way and it keeps the command useful.
- Should the first score include cost? Default: no, because the command is about intelligence; cost belongs in a future filter or secondary sort.
- Should this be exposed outside the TUI? Default: no for first pass to avoid OpenAPI and SDK churn.
