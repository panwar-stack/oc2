# Logu Tool Policies For All Child Stages

## Goal

Enable configurable tool calling for every Logu child stage: branches, judge, and synthesizer. The Logu lead remains orchestration-only and out of scope.

Add `toolPolicy` to `local_fusion.logu.judge` and `local_fusion.logu.synthesizer`, and add an explicit `"all"` policy for opt-in full tool access. Preserve current defaults: branches default to `readonly`; judge and synthesizer default to `none`.

## Current State

- `packages/core/src/config/local-fusion.ts` defines `ToolPolicy` as `"readonly" | "none" | "parent_without_teams"`.
- `packages/core/src/config/local-fusion.ts` exposes `toolPolicy` only on branch config, not judge or synthesizer.
- `packages/opencode/src/session/compound/config.ts` parses branch `toolPolicy`, but judge and synthesizer types do not include it.
- `packages/opencode/src/session/compound/runner.ts` resolves branch tools through branch-only helpers.
- `packages/opencode/src/session/compound/judge.ts` hardcodes tools disabled with `{ "*": false }`.
- `packages/opencode/src/session/compound/synthesizer.ts` hardcodes tools disabled with `{ "*": false }`.
- `packages/opencode/src/session/logu.ts` validates recursive `logu/logu` use and must keep doing so.
- `packages/web/src/content/docs/local-fusion.mdx` currently documents judge and synthesizer as tools-disabled.

## Non-Negotiables

- Existing configs must keep identical behavior unless users opt in.
- Logu lead/parent normal tool calling remains out of scope.
- Recursive `logu/logu` references must remain rejected for branches, judge, and synthesizer.
- `"parent_without_teams"` must continue disabling `team_create`, `team_spawn`, and `local_fusion`.
- `"all"` must be Logu-only in the first pass.
- Normal non-Logu `/local_fusion` must reject Logu-only policies: `"parent_without_teams"` and `"all"`.
- Tests must run from package directories, not repo root.

## Config Design

Extend Logu stage config:

```jsonc
{
  "local_fusion": {
    "logu": {
      "branches": [
        {
          "model": "anthropic/claude-sonnet-4-5",
          "agent": "build",
          "toolPolicy": "all"
        }
      ],
      "judge": {
        "model": "openai/gpt-5-mini",
        "toolPolicy": "readonly"
      },
      "synthesizer": {
        "model": "anthropic/claude-sonnet-4-5",
        "toolPolicy": "all"
      }
    }
  }
}
```

Expected policy values:

```ts
type ToolPolicy =
  | "none"
  | "readonly"
  | "parent_without_teams"
  | "all"
```

Defaults:

- `branches[*].toolPolicy ?? "readonly"`
- `judge.toolPolicy ?? "none"`
- `synthesizer.toolPolicy ?? "none"`

## Tool Behavior

Policy matrix:

| Policy | Tools Map | Extra Permission Denies | Scope |
| --- | --- | --- | --- |
| `"none"` | `{ "*": false }` | none | Logu and non-Logu |
| `"readonly"` | `{ "*": false, read: true, grep: true, glob: true, webfetch: true, websearch: true, lsp: true }` | none | Logu and non-Logu |
| `"parent_without_teams"` | parent-style tools with delegation allowed when parent permits | deny `team_create`, `team_spawn`, `local_fusion` | Logu-only |
| `"all"` | `{}` | none beyond parent/session permissions | Logu-only |

Important behavior:

- `{}` means unrestricted tool map for that child prompt path.
- `"all"` does not bypass parent permission checks.
- `"all"` does not relax recursive `logu/logu` config validation.
- If `"all"` creates unacceptable nested orchestration risk during review, ship judge/synthesizer `toolPolicy` first and leave `"all"` behind a separate PR.

## Implementation Slices

### PR 1: Config Schema And Defaults

- Update `packages/core/src/config/local-fusion.ts`.
- Add `"all"` to `ToolPolicy`.
- Add optional `toolPolicy` to `Judge` and `Synthesizer`.
- Update `packages/opencode/src/session/compound/config.ts`.
- Add `toolPolicy` to judge and synthesizer types.
- Default judge and synthesizer to `"none"`.
- Keep branch default as `"readonly"`.
- Add config tests for defaults and accepted policy values.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/compound-config.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must confirm existing configs preserve current behavior and no judge/synthesizer tools are enabled by default.

### PR 2: Shared Tool Policy Resolution

- Refactor `packages/opencode/src/session/compound/runner.ts` so branch, judge, and synthesizer use one shared resolver.
- Add `"all"` handling as `{}`.
- Keep `"parent_without_teams"` Logu-only.
- Update validation so non-Logu compound mode rejects `"parent_without_teams"` and `"all"`.
- Preserve existing branch behavior.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/compound-runner.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must confirm `"parent_without_teams"` still denies `team_create`, `team_spawn`, and `local_fusion`, and `"all"` remains Logu-only.

### PR 3: Wire Judge And Synthesizer

- Update `packages/opencode/src/session/compound/judge.ts`.
- Remove hardcoded `{ "*": false }`.
- Resolve tools from `input.judge.toolPolicy`.
- Apply matching child-session permission behavior.
- Update `packages/opencode/src/session/compound/synthesizer.ts` the same way.
- Add tests for:
  - omitted judge policy still disables tools
  - omitted synthesizer policy still disables tools
  - judge `readonly` receives readonly tools
  - synthesizer `parent_without_teams` disables nested team/local-fusion tools
  - branch/judge/synthesizer `"all"` passes `{}` in Logu mode
  - non-Logu mode rejects `"all"`

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/logu.test.ts test/session/compound-runner.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must compare the diff against this spec before merge, focusing on default compatibility and recursive orchestration risk.

### PR 4: Docs

- Update `packages/web/src/content/docs/local-fusion.mdx`.
- Remove the statement that judge and synthesizer always run with tools disabled.
- Document `branches[].toolPolicy`, `judge.toolPolicy`, and `synthesizer.toolPolicy`.
- Document defaults.
- Show a Logu config with explicit policies for all child stages.
- State that the Logu lead still does not use normal tool calling.

Verification:

- `cd packages/web && bun run build`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must confirm docs match exact config names, defaults, and policy behavior.

## Future Work

- Add UI indicators for tool-enabled Logu stages.
- Consider finer-grained write policies, such as readonly plus edit/apply_patch but no bash.
- Add support for equivalent judge/synthesizer policies in one-off inline `local_fusion` tool calls if needed.

## Open Questions

- Should `"all"` allow `team_create`, `team_spawn`, and `local_fusion`? Default: yes, because `"all"` should mean full tool map, but only in Logu mode and only subject to parent/session permissions.
- Should normal non-Logu `/local_fusion` support judge/synthesizer `readonly`? Default: yes for `"none"` and `"readonly"` only; keep `"parent_without_teams"` and `"all"` Logu-only.
