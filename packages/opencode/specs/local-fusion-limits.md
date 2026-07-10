# Local Fusion Limits Enforcement

## Goal

Ensure `local_fusion` consistently respects configured limits:

```json
"limits": {
  "timeout": 180000,
  "maxBranches": 4
}
```

The first pass must make the existing behavior explicit, tested, and complete for named configs. `limits.maxBranches` must cap branch count before execution. `limits.timeout` must bound the full local fusion orchestration, not just individual branch prompts, so branch, judge, and synthesizer work cannot exceed the configured budget.

## Current State

- `packages/core/src/config/local-fusion.ts` already defines `limits.timeout?: PositiveInt` and `limits.maxBranches?: PositiveInt`.
- `packages/opencode/src/session/compound/config.ts` defines `DEFAULT_MAX_BRANCHES = 3`, defaults missing `limits.maxBranches`, and rejects `branches.length > limits.maxBranches`.
- `packages/opencode/src/session/compound/runner.ts` currently applies `branch.timeout ?? input.config.limits.timeout` only to branch prompts.
- `packages/opencode/src/session/compound/judge.ts` and `packages/opencode/src/session/compound/synthesizer.ts` do not accept or apply timeouts.
- `packages/opencode/src/tool/local_fusion.ts` supports named configs with `{ prompt, config }` and inline configs with `{ prompt, branches, judge, synthesizer }`.
- Inline `local_fusion` input does not currently accept `limits`.
- Existing tests:
- `packages/opencode/test/session/compound-config.test.ts`
- `packages/opencode/test/session/compound-runner.test.ts`
- `packages/opencode/test/tool/local-fusion.test.ts`
- Docs to update:
- `packages/web/src/content/docs/local-fusion.mdx`
- `packages/web/src/content/docs/config.mdx`
- `packages/web/src/content/docs/tools.mdx`

## Non-Negotiables

- `limits.maxBranches` must be enforced before any branch execution starts.
- `limits.timeout` must apply to the whole compound run: branches, judge, and synthesizer.
- Branch-specific `branch.timeout` may remain a narrower per-branch override, but it must not extend the total `limits.timeout`.
- Do not change `/local:fusion <config> <prompt>` command syntax.
- Do not add concurrency limiting in this pass; `maxBranches` is a count limit, not a concurrency setting.
- Do not introduce persistence or migration work; this is runtime/config behavior only.
- Tests must run from package directories, not repo root.

## Runtime Behavior

Expected named config behavior:

```ts
type LocalFusionLimits = {
  timeout?: number
  maxBranches?: number
}
```

Rules:

- If `limits.maxBranches` is omitted, default to `DEFAULT_MAX_BRANCHES`.
- If `branches.length > limits.maxBranches`, fail during config parsing before running any branch.
- If `limits.timeout` is set, wrap the entire `SessionCompound.run(...)` flow in that timeout budget.
- If the total timeout expires:
- cancel in-flight branch, judge, or synthesizer work;
- return a deterministic tool failure message;
- avoid returning partial synthesized output as success.
- If `branch.timeout` is set, it applies only to that branch and must still be bounded by the total run timeout.
- If no `limits.timeout` is set, preserve current behavior except for existing branch-level timeouts.

Recommended error text:

```txt
Local fusion timed out after <timeout>ms
```

Branch timeout text can stay as-is:

```txt
Branch timed out after <timeout>ms
```

## Tool Surface

First pass should keep inline tool input unchanged:

```ts
{
  prompt: string
  branches: Branch[]
  judge: Judge
  synthesizer: Synthesizer
}
```

Named config remains the supported way to set:

```json
{
  "limits": {
    "timeout": 180000,
    "maxBranches": 4
  }
}
```

Inline `limits` support should be future work unless reviewers explicitly want tool-call parity now.

## Implementation Slices

### PR 1: Enforce Total Timeout

- Update `packages/opencode/src/session/compound/runner.ts`.
- Apply `input.config.limits.timeout` around the full compound orchestration.
- Keep existing per-branch timeout behavior.
- Add tests in `packages/opencode/test/session/compound-runner.test.ts` for:
- total timeout cancels before judge completes;
- total timeout cancels before synthesizer completes;
- branch-specific timeout still records branch failure when it expires before total timeout.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/compound-runner.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer to inspect the diff against this slice. Reviewer must confirm timeout scope covers branches, judge, and synthesizer, and that branch timeout cannot extend total timeout.

### PR 2: Lock Down Max Branch Enforcement Tests

- Extend `packages/opencode/test/session/compound-config.test.ts` if needed to cover:
- explicit `limits.maxBranches: 4` allows four branches;
- explicit `limits.maxBranches: 4` rejects five branches;
- omitted `limits.maxBranches` keeps current default limit.
- Add a tool-level named config test in `packages/opencode/test/tool/local-fusion.test.ts` proving an over-limit named config fails before execution.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/compound-config.test.ts test/tool/local-fusion.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer to confirm tests prove pre-execution rejection and do not duplicate implementation logic.

### PR 3: Document Exact Limit Semantics

- Update `packages/web/src/content/docs/local-fusion.mdx`.
- Update `packages/web/src/content/docs/config.mdx`.
- Update `packages/web/src/content/docs/tools.mdx`.
- Document:
- `limits.maxBranches` caps branch count;
- `limits.timeout` is a total orchestration timeout;
- `branch.timeout` is a per-branch timeout and cannot exceed the total budget;
- inline `local_fusion` tool calls cannot set `limits` in the first pass.

Verification:

- `cd packages/web && bun run build`

Review:

Use a fresh read-only reviewer to confirm docs match implemented behavior and the example config remains valid.

## Future Work

- Add inline tool support for `limits`:

```ts
{
  prompt: string
  branches: Branch[]
  judge: Judge
  synthesizer: Synthesizer
  limits?: {
    timeout?: number
    maxBranches?: number
  }
}
```

- Add separate concurrency control if needed:

```json
"limits": {
  "maxBranches": 4,
  "maxConcurrency": 2
}
```

- Add telemetry or metadata showing whether a run failed due to branch timeout or total timeout.

## Open Questions

- Should total timeout failure return a structured metadata field like `{ timedOut: true }`?
  Default: yes, if it fits the existing `metadata` shape without expanding public API.
- Should inline tool calls accept `limits` in the same PR?
  Default: no. Keep first pass focused on named config enforcement and docs.
