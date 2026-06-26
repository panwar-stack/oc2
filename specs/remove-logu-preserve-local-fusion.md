# Remove Logu, Preserve Local Fusion

## Goal

Remove the synthetic `logu/logu` model and all Logu-specific runtime, config, docs, TUI, and tests. Keep Local Fusion as an explicit `/local_fusion` tool and generalize the useful Logu-era Local Fusion improvements to normal Local Fusion runs.

The first pass must not introduce a replacement assistant model. Local Fusion remains invoked through the existing tool, slash command, and `local_fusion` config.

## Current State

- `packages/opencode/src/provider/provider.ts` defines and injects the synthetic `logu/logu` provider/model.
- `packages/opencode/src/session/llm.ts` special-cases `logu/logu`, routes through `SessionLogu`, and emits synthetic LLM stream events.
- `packages/opencode/src/session/logu.ts` owns adaptive routing, transcript rendering, `local_fusion.logu` lookup, and recursive `logu/logu` validation.
- `packages/core/src/config/logu.ts` defines top-level Logu config.
- `packages/core/src/v1/config/config.ts` exposes top-level `logu` and `local_fusion`.
- `packages/opencode/src/tool/local_fusion.ts` already supports named and inline Local Fusion execution.
- `packages/opencode/src/session/compound/tool-policy.ts` already has `readonly`, `none`, `parent_without_teams`, and `all`, but rejects `parent_without_teams` and `all` outside `mode === "logu"`.
- `packages/opencode/src/session/compound/runner.ts`, `judge.ts`, and `synthesizer.ts` contain Logu-specific child titles and `metadata.logu`.
- `packages/tui/src/util/logu.ts` and `packages/tui/src/feature-plugins/sidebar/logu.tsx` render Logu-specific child session UI.
- `packages/web/src/content/docs/local-fusion.mdx`, `tools.mdx`, `config.mdx`, and `models.mdx` contain Logu references.

## Non-Negotiables

- Remove `logu/logu` from provider/model discovery and model picker behavior.
- Remove top-level `logu` config support.
- Configs using top-level `logu` must fail schema or config validation.
- Runtime use of `model: "logu/logu"` must fail; do not silently route or fallback.
- Remove reserved `local_fusion.logu` behavior from docs and tests.
- Keep `local_fusion.<name>` as ordinary named configs; `logu` must not be special if a user happens to choose that key.
- Make `parent_without_teams` and `all` valid for normal named and inline Local Fusion runs.
- Keep branch and judge scratch write isolation for write-capable policies.
- Keep `apply_patch` and workspace edits denied for branch and judge scratch stages.
- Keep synthesizer write behavior controlled by tool policy and existing parent/session permissions.
- Do not preserve historical `metadata.logu` TUI behavior; old child sessions may lose labels or fail to render specialized UI.
- Do not add a generic Local Fusion sidebar/progress panel in this first pass.

## Config And Tool Surface

Local Fusion remains the only public compound config surface:

```ts
local_fusion?: Record<string, {
  branches: {
    model: string
    variant?: string
    agent?: string
    prompt?: string
    toolPolicy?: "readonly" | "none" | "parent_without_teams" | "all"
    timeout?: number
  }[]
  judge: {
    model: string
    variant?: string
    prompt?: string
    toolPolicy?: "readonly" | "none" | "parent_without_teams" | "all"
  }
  synthesizer: {
    model: string
    variant?: string
    prompt?: string
    toolPolicy?: "readonly" | "none" | "parent_without_teams" | "all"
  }
  limits?: {
    timeout?: number
    maxBranches?: number
  }
}>
```

Tool policy behavior:

| Policy | Branch | Judge | Synthesizer |
| --- | --- | --- | --- |
| `none` | No tools | No tools | No tools |
| `readonly` | Read/search/web/LSP tools | Read/search/web/LSP tools | Read/search/web/LSP tools |
| `parent_without_teams` | Scratch-scoped write/edit, no `apply_patch`, no teams, no nested Local Fusion | Scratch-scoped write/edit, no `apply_patch`, no teams, no nested Local Fusion | Parent-style tools with `team_create`, `team_spawn`, and `local_fusion` disabled |
| `all` | Scratch-scoped write/edit, no `apply_patch` | Scratch-scoped write/edit, no `apply_patch` | Unrestricted tool map subject to existing permissions |

## Error Handling

- Top-level `logu` config must fail config validation. Default message: `logu config has been removed; use local_fusion instead`.
- `model: "logu/logu"` must fail model resolution or runtime validation. Default message: `logu/logu has been removed; use /local_fusion instead`.
- Negative tests may retain `logu` literals only to verify removed-feature failures.
- Positive docs, examples, feature tests, and TUI labels must not describe Logu as supported.

## Implementation Slices

### PR 1: Generalize Local Fusion Policies

- Update `packages/opencode/src/session/compound/tool-policy.ts` so `parent_without_teams` and `all` are valid without Logu mode.
- Rename Logu-specific helper names like `loguDelegatedTools` to generic Local Fusion names.
- Keep branch and judge write-capable policies scratch-scoped through `tempDirectory`.
- Keep branch and judge permissions denying workspace edits and `apply_patch`.
- Keep `team_create`, `team_spawn`, and `local_fusion` disabled for `parent_without_teams`.
- Update `packages/opencode/test/tool/local-fusion.test.ts` so named and inline Local Fusion configs accept `parent_without_teams` and `all`.
- Update compound/tool permission tests in `packages/opencode/test/session/compound-runner.test.ts`, `compound-judge.test.ts`, `compound-synthesizer.test.ts`, and tool permission tests.

Verification:

- `cd packages/opencode && bun test test/tool/local-fusion.test.ts test/session/compound-runner.test.ts test/session/compound-config.test.ts test/session/compound-judge.test.ts test/session/compound-synthesizer.test.ts test/tool/write.test.ts test/tool/edit.test.ts test/tool/apply_patch.test.ts test/tool/external-directory.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Before checking off this slice, run a fresh read-only reviewer against the diff and this spec. The reviewer must confirm write-capable branch/judge policies cannot edit workspace files and normal `/local_fusion` accepts all four policies.

### PR 2: Remove Logu Runtime And Config

- Delete `packages/opencode/src/session/logu.ts`.
- Remove `SessionLogu`, `runLogu`, `runLoguFusion`, `loguEvents`, and `isLoguModel` from `packages/opencode/src/session/llm.ts`.
- Remove synthetic Logu provider/model constants, loader, catalog injection, and default-model special cases from `packages/opencode/src/provider/provider.ts`.
- Delete `packages/core/src/config/logu.ts`.
- Remove `ConfigLogu` import and top-level `logu` field from `packages/core/src/v1/config/config.ts`.
- Add explicit config validation for top-level `logu` if removing the schema field does not reject unknown config keys.
- Remove or rewrite Logu-specific tests in `packages/opencode/test/session/logu.test.ts`, `llm.test.ts`, `provider.test.ts`, and `server/httpapi-provider.test.ts`.
- Update `packages/app/src/context/models.test.tsx` so model picker expectations no longer include `logu/logu`.
- Update `packages/core/test/session-runner-model.test.ts` by deleting Logu-specific V2 exclusion coverage or replacing it with a generic unsupported-model test.

Verification:

- `cd packages/opencode && bun test test/session/llm.test.ts test/provider/provider.test.ts test/server/httpapi-provider.test.ts`
- `cd packages/core && bun test test/session-runner-model.test.ts`
- `cd packages/app && bun test --preload ./happydom.ts ./src/context/models.test.tsx`
- `cd packages/opencode && bun typecheck`
- `cd packages/core && bun typecheck`
- `cd packages/app && bun typecheck`

Review:

Before checking off this slice, run a fresh read-only reviewer. The reviewer must confirm `logu/logu` cannot appear in provider/model lists, top-level `logu` config fails, and Local Fusion still runs through `/local_fusion`.

### PR 3: Remove Logu TUI And Docs

- Remove `packages/tui/src/util/logu.ts`.
- Remove `packages/tui/src/feature-plugins/sidebar/logu.tsx`.
- Remove Logu sidebar registration from `packages/tui/src/feature-plugins/builtins.ts`.
- Delete or rewrite TUI tests under `packages/tui/test/util/logu.test.ts`, `feature-plugins/sidebar/logu.test.tsx`, and `routes/session/logu-prompts.test.tsx`.
- Remove Logu model references from `packages/web/src/content/docs/models.mdx`.
- Rewrite `packages/web/src/content/docs/local-fusion.mdx` to describe Local Fusion only.
- Generalize `packages/web/src/content/docs/tools.mdx` and `packages/web/src/content/docs/config.mdx` so scratch isolation is a Local Fusion behavior, not a Logu behavior.
- Delete or mark obsolete Logu specs in `specs/logu-local-proxy-model.md`, `specs/logu-local-proxy-completion.md`, `packages/opencode/specs/adaptive-logu-routing.md`, `packages/opencode/specs/logu-tool-policies-all-child-stages.md`, and `packages/opencode/specs/logu-lead-progress-panel.md`.
- Preserve Local Fusion specs such as `specs/local-fusion-write-isolation.md` and `specs/local-fusion-limits.md`.

Verification:

- `cd packages/tui && bun test test/feature-plugins/builtins.test.ts`
- `cd packages/tui && bun typecheck`
- `cd packages/web && bun run build`
- `rg -n "Logu|logu/logu|metadata\\.logu|sidebar-logu|\\bConfigLogu\\b|\\bSessionLogu\\b|local_fusion\\.logu|\"logu\"" packages/opencode packages/core packages/tui packages/app packages/web/src/content/docs specs`

Review:

Before checking off this slice, run a fresh read-only reviewer. The reviewer must confirm remaining `logu` matches are limited to intentional negative removal tests or explicit validation guards.

### PR 4: Final Cleanup And Generated Artifacts

- Run the full relevant test matrix after source, TUI, docs, and config changes land.
- Regenerate the JS SDK only if public HTTP/OpenAPI schema output changes.
- If SDK regeneration is needed, run `./packages/sdk/js/script/build.ts`.
- Confirm no positive Logu docs, model picker entries, provider entries, TUI plugins, or tests remain.
- Confirm Local Fusion named configs, inline tool calls, branch timeouts, tool policies, and scratch isolation remain covered.

Verification:

- `cd packages/opencode && bun test test/tool/local-fusion.test.ts test/session/compound-runner.test.ts test/session/compound-config.test.ts test/session/compound-judge.test.ts test/session/compound-synthesizer.test.ts test/config/config.test.ts test/command/command.test.ts`
- `cd packages/opencode && bun typecheck`
- `cd packages/core && bun typecheck`
- `cd packages/tui && bun typecheck`
- `cd packages/app && bun typecheck`
- `cd packages/web && bun run build`

Review:

Before checking off this slice, run a fresh read-only reviewer over the final diff. The reviewer must verify Logu removal is complete and Local Fusion behavior is not narrowed.

## Future Work

- Add a generic Local Fusion progress/sidebar panel keyed off non-Logu metadata.
- Add migration docs for users moving from `model: "logu/logu"` to explicit `/local_fusion`.
- Define scratch directory cleanup or retention guarantees.

## Open Questions

- Should negative tests be allowed to contain `logu` literals? Default: yes, but only for removed-feature failure coverage.
- Should `model: "logu/logu"` get a custom error or rely on normal unknown-provider failure? Default: custom error if it can be implemented without reintroducing provider/model support.
