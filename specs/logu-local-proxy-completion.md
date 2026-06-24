# Logu Local Proxy Completion

## Goal

Finish the missing pieces from the Logu/local proxy audit against `specs/logu-local-proxy-model.md`. The first pass must keep the existing design: `logu/logu` remains a synthetic local model that routes through `local_fusion.logu` and `SessionCompound`, with no new proxy process or provider runner.

The implementation strategy is to make timeout/interruption state visible where the original spec requires it, then add targeted regression coverage for behavior that appears implemented but unverified.

## Current State

- `packages/opencode/src/session/compound/runner.ts` creates Logu branch sessions with `metadata.logu.stage`, `index`, `model`, `variant`, `parentRunID`, and `parentSessionID`.
- `packages/opencode/src/session/compound/runner.ts` returns `timedOut: true` in `BranchFailure` after branch timeout, but does not update the child session metadata.
- `packages/opencode/src/session/session.ts` exposes `Session.Service.setMetadata(...)`, which can update child session metadata after creation.
- `packages/tui/src/feature-plugins/sidebar/logu.tsx` lists Logu child sessions, status, pending permission/question counts, and navigation, but does not render timed-out branch state.
- `packages/opencode/src/session/logu.ts` forwards `abort` into `SessionCompound.run(...)`.
- `packages/opencode/src/session/compound/runner.ts`, `judge.ts`, and `synthesizer.ts` register abort listeners, but there is no direct abort/interruption regression test.
- `packages/app/src/hooks/use-providers.ts`, `packages/app/src/context/models.tsx`, and `packages/app/src/components/dialog-select-model.tsx` drive app-side model selection from connected providers.
- `packages/opencode/test/server/httpapi-provider.test.ts` covers server provider exposure, but no app-side Logu picker test exists.
- `packages/tui/src/routes/session/permission.tsx` and `packages/tui/src/routes/session/question.tsx` render Logu labels, but current tests mostly cover `packages/tui/src/util/logu.ts`.
- `packages/opencode/test/tool/local-fusion.test.ts` covers inline rejection of `parent_without_teams` outside Logu mode, but not named `local_fusion` configs.
- `packages/core/src/session/runner/model.ts` owns V2 model resolution, but there is no explicit regression test that V2 excludes `logu/logu`.
- `packages/web/src/content/docs/local-fusion.mdx` is the docs page to update if timeout/sidebar behavior becomes user-facing documentation.

## Non-Negotiables

- Do not redesign Logu, local fusion, provider registration, or model picker data flow.
- Do not expose `logu/logu` through V2 available models.
- Do not add a new public API field for timeout state; use existing opaque `session.metadata.logu`.
- Do not make `/local_fusion` outside Logu mode accept `parent_without_teams`.
- Abort handling must cancel active child sessions and must not start judge or synthesizer after the root signal is aborted.
- Run tests from package directories, not from the repository root.
- If a public SDK schema is changed despite this plan, regenerate the JavaScript SDK with `./packages/sdk/js/script/build.ts` from the repository root.

## Runtime Metadata

Extend Logu child metadata minimally:

```ts
metadata: {
  logu: {
    stage: "branch" | "judge" | "synthesizer"
    index?: number
    model: string
    variant?: string
    parentRunID: string
    parentSessionID: string
    timedOut?: true
    timeoutMS?: number
  }
}
```

- `timedOut` and `timeoutMS` must be written only for branch children that actually time out.
- Preserve existing metadata keys and values for all Logu children.
- When calling `Session.Service.setMetadata(...)`, merge with the existing metadata object instead of replacing unrelated metadata.
- Do not add branch failure reasons to metadata in the first pass.

## Abort Semantics

- Add an explicit aborted-signal check in `packages/opencode/src/session/compound/runner.ts` before branch fan-out, before judge, and before synthesizer.
- Add the same check inside branch/judge/synth child execution before calling `promptOps.prompt(...)`.
- Keep existing `promptOps.cancel(child.id)` listener behavior for active child sessions.
- Treat abort as interruption/cancellation, not as an all-branches-failed Logu answer.

## TUI And App Behavior

- `packages/tui/src/feature-plugins/sidebar/logu.tsx` must show timed-out branch rows when `session.metadata.logu.timedOut === true`.
- Timed-out rows should render `timed out` instead of generic idle status and use an existing warning/error color.
- Parent sidebar summary may include a timeout count if it stays local to the sidebar.
- Rendered permission/question prompt tests must assert visible Logu child/model labels, not just helper return values.
- App picker tests must assert `logu` appears from connected providers without auth/connect UI.

## Implementation Slices

### PR 1: Persist Timed-Out Branch Metadata

- Update `packages/opencode/src/session/compound/runner.ts` to call `Session.Service.setMetadata(...)` when a branch timeout occurs.
- Preserve the existing `BranchFailure.timedOut` return value and timeout error message.
- Add or extend `packages/opencode/test/session/compound-runner.test.ts` to assert the timed-out branch child has `metadata.logu.timedOut === true`.
- Assert `metadata.logu.timeoutMS` equals the configured timeout.
- Assert non-timeout branch failures do not get timeout metadata.

Verification:

- From `packages/opencode`: `bun test test/session/compound-runner.test.ts`
- From `packages/opencode`: `bun typecheck`

Review:

Before checking off this slice, run a fresh read-only review against the diff and confirm only timeout metadata behavior changed.

### PR 2: Render Timeout State In The TUI Sidebar

- Update `packages/tui/src/feature-plugins/sidebar/logu.tsx` to derive timeout state from `session.metadata.logu.timedOut`.
- Render timed-out branch rows as `timed out` even when the session status is otherwise idle.
- Add `packages/tui/test/feature-plugins/sidebar/logu.test.tsx`.
- Cover child ordering, timed-out label, pending counts, and navigation callback.
- Update `packages/web/src/content/docs/local-fusion.mdx` if it describes Logu timeout behavior without sidebar visibility.

Verification:

- From `packages/tui`: `bun test test/feature-plugins/sidebar/logu.test.tsx test/feature-plugins/builtins.test.ts`
- From `packages/tui`: `bun typecheck`
- If docs changed, from `packages/web`: `bun build`

Review:

Before checking off this slice, run a fresh read-only review and confirm the sidebar remains ungated by `experimental.agent_teams`.

### PR 3: Harden And Verify Abort Handling

- Add explicit aborted-signal checks in `packages/opencode/src/session/compound/runner.ts`.
- Add explicit aborted-signal checks in `packages/opencode/src/session/compound/judge.ts`.
- Add explicit aborted-signal checks in `packages/opencode/src/session/compound/synthesizer.ts`.
- Add Logu abort tests in `packages/opencode/test/session/logu.test.ts` or `packages/opencode/test/session/compound-runner.test.ts`.
- Cover an already-aborted signal.
- Cover abort during a hanging branch.
- Assert `promptOps.cancel(...)` is called for active child sessions.
- Assert judge and synthesizer are not started after the root abort signal is set.

Verification:

- From `packages/opencode`: `bun test test/session/logu.test.ts test/session/compound-runner.test.ts`
- From `packages/opencode`: `bun typecheck`

Review:

Before checking off this slice, run a fresh read-only review and confirm abort paths interrupt instead of converting cancellation into `logu failed`.

### PR 4: Add Rendered TUI Prompt Tests

- Add `packages/tui/test/routes/session/logu-prompts.test.tsx`.
- Render the permission prompt path from `packages/tui/src/routes/session/permission.tsx`.
- Render the question prompt path from `packages/tui/src/routes/session/question.tsx`.
- Assert visible output includes the Logu child label and model.
- Keep existing `packages/tui/test/util/logu.test.ts` helper tests.

Verification:

- From `packages/tui`: `bun test test/routes/session/logu-prompts.test.tsx test/util/logu.test.ts`
- From `packages/tui`: `bun typecheck`

Review:

Before checking off this slice, run a fresh read-only review and confirm tests assert rendered user-visible text, not duplicated helper logic.

### PR 5: Add App Picker Regression Test

- Add `packages/app/src/context/models.test.tsx` or a focused picker test near `packages/app/src/components/dialog-select-model.tsx`.
- Prove `logu` appears when returned by connected providers.
- Prove `logu` does not require auth/connect UI.
- Prefer existing app test utilities and avoid mocking implementation logic.

Verification:

- From `packages/app`: `bun test --preload ./happydom.ts ./src/context/models.test.tsx`
- From `packages/app`: `bun typecheck`

Review:

Before checking off this slice, run a fresh read-only review and confirm the test exercises the same connected-provider path used by the app.

### PR 6: Add Compatibility And V2 Exclusion Tests

- Add a named-config regression test in `packages/opencode/test/tool/local-fusion.test.ts`.
- The named config must contain a branch with `toolPolicy: "parent_without_teams"`.
- Calling `/local_fusion` with that named config outside Logu mode must fail with the existing unsupported-policy error.
- Add a V2 exclusion regression test near `packages/core/src/session/runner/model.ts`.
- The V2 test must prove available model resolution does not return `logu/logu`.

Verification:

- From `packages/opencode`: `bun test test/tool/local-fusion.test.ts`
- From `packages/opencode`: `bun typecheck`
- From `packages/core`: `bun test test/session/runner/model.test.ts`
- From `packages/core`: `bun typecheck`

Review:

Before checking off this slice, run a fresh read-only review and confirm the tests preserve existing Logu V1 selectability while preventing V2 exposure.

## Future Work

- Aggregate usage/cost across Logu branches if compound accounting is added separately.
- Show richer branch failure reasons in the sidebar after deciding what error text is safe to persist in metadata.
- Count pending permissions/questions from branch-spawned descendant subagents in the Logu sidebar if users report hidden pending prompts.
- Add dedicated app-side compound visualization; leave this out of the first pass.

## Open Questions

- Should Logu sidebar pending counts include descendant subagent sessions, not only direct branch/judge/synth children? Default: no for the first pass.
- Should timeout metadata include the human-readable failure reason? Default: no. Store only `timedOut: true` and `timeoutMS` to avoid persisting provider/error strings in session metadata.
