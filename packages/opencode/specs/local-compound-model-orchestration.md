# Local Compound Model Orchestration

## Goal

Add a local Fusion-like compound model feature that can fan out one prompt to multiple configured models, judge the branch outputs, and synthesize one final answer inside opencode.

The first pass should favor explicit local orchestration over provider abstraction. Implement the feature as a small compound runner that composes existing session/model/tool primitives, then expose it through a thin local tool. Defer transparent model-slug routing until the orchestration behavior is proven.

## Current State

- `packages/opencode/src/session/prompt.ts` owns prompt/session orchestration. It selects `input.model ?? agent.model ?? currentModel`, resolves the model, creates assistant messages, resolves tools, and calls the processor.
- `packages/opencode/src/session/processor.ts` consumes one `llm.stream(...)` call and drains normalized `LLMEvent`s into assistant message parts and tool calls.
- `packages/opencode/src/session/llm.ts` owns provider config/auth lookup, language model loading, request prep, telemetry, plugin hooks, and runtime selection.
- `packages/opencode/src/session/llm/request.ts` centralizes request preparation, including system prompts, provider options, headers, tool filtering, and model settings.
- `packages/opencode/src/provider/provider.ts` owns provider/model parsing, defaults, model catalog lookup, and concrete language model loading. It should not own panel fanout or judging policy.
- `packages/opencode/src/session/tools.ts` converts registered tools into AI SDK tools and injects `promptOps`.
- `packages/opencode/src/tool/registry.ts` owns built-in/custom/plugin tool discovery and model/provider-sensitive tool filtering.
- `packages/opencode/src/tool/task.ts` already implements child-session prompting with per-child model override through `TaskPromptOps`.
- `packages/opencode/src/tool/team_spawn.ts` contains useful prior art for multi-agent child sessions, model variants, cancellation, and dependency coordination, but its team UX/persistence should not be required for compound model execution.
- `packages/opencode/package.json` defines package-local verification commands: `bun test --timeout 30000` and `bun typecheck`.

## Non-Negotiables

- Must run entirely locally inside opencode orchestration. Do not depend on OpenRouter Fusion or any remote compound-model API.
- Must not put fanout, judging, or synthesis inside `Provider`. Provider remains responsible for concrete model lookup/loading.
- Must not duplicate model auth/config lookup, tool filtering, provider headers, permission handling, or session persistence.
- Must not bypass `SessionTools.resolve`, `ToolRegistry`, plugin hooks, or existing tool permission behavior.
- Must default branch tool policy to safe behavior. Branches may read/search by default, but must not get mutating tools like write/edit/apply_patch/bash unless explicitly configured.
- Must return one final synthesized response to the parent caller.
- Must not stream branch internals into the parent assistant response in the first pass.
- Must run tests from `packages/opencode`, never from repo root.
- Leave transparent `model: "compound/..."` routing out of the first pass unless the local tool proves insufficient.

## Design

### Module Shape

Add a focused compound orchestration module under:

```txt
packages/opencode/src/session/compound/
```

Suggested files:

```txt
packages/opencode/src/session/compound/config.ts
packages/opencode/src/session/compound/runner.ts
packages/opencode/src/session/compound/judge.ts
packages/opencode/src/session/compound/synthesizer.ts
```

Follow the repo module convention from `packages/opencode/AGENTS.md`:

```ts
export const thing = ...

export * as SessionCompound from "./runner"
```

Do not add a multi-file barrel `index.ts`.

### Config Shape

First-pass config should be explicit and local:

```ts
type CompoundConfig = {
  branches: CompoundBranch[]
  judge: CompoundJudge
  synthesizer: CompoundSynthesizer
  limits?: {
    timeout?: number
    maxBranches?: number
  }
}

type CompoundBranch = {
  model: string
  agent?: string
  prompt?: string
  toolPolicy?: "readonly" | "none"
  timeout?: number
}

type CompoundJudge = {
  model: string
  prompt?: string
}

type CompoundSynthesizer = {
  model: string
  prompt?: string
}
```

Default behavior:

- `limits.maxBranches` defaults to `3`.
- `limits.timeout` defaults to a conservative package-level constant.
- `branch.toolPolicy` defaults to `"readonly"`.
- Judge and synthesizer must run with tools disabled.
- Branch prompts receive the user request plus optional branch-specific guidance.
- Judge receives only branch outputs, branch metadata, and failure summaries.
- Synthesizer receives the original user request, branch outputs, and judge structure.

### Judge Output

The judge must produce structured analysis, not a final answer.

Expected shape:

```ts
type CompoundJudgeResult = {
  consensus: string[]
  contradictions: string[]
  uniqueInsights: Array<{
    branch: string
    insight: string
  }>
  blindSpots: string[]
  failures: Array<{
    branch: string
    reason: string
  }>
  confidence: "low" | "medium" | "high"
}
```

The synthesizer must be instructed to ground the final answer in:

- original prompt
- successful branch outputs
- judge result
- explicit branch failures

### Tool Surface

Expose the first pass as a local tool, for example:

```txt
local_fusion
```

Tool input:

```ts
type LocalFusionInput = {
  prompt: string
  config?: string
  branches?: CompoundBranch[]
  judge?: CompoundJudge
  synthesizer?: CompoundSynthesizer
}
```

Rules:

- If `config` is provided, load the named local compound config.
- If inline `branches`, `judge`, and `synthesizer` are provided, validate and run them directly.
- Do not allow inline branch count above `limits.maxBranches`.
- Do not expose mutating tools to branches in the first pass.
- Tool implementation must be thin and delegate orchestration to `SessionCompound.runner`.

Register through:

```txt
packages/opencode/src/tool/registry.ts
```

Keep orchestration out of the registry.

### Execution Flow

```txt
local_fusion tool
  -> validate compound config/input
  -> expand branch specs
  -> run branch child prompts concurrently
  -> collect successful outputs and failures
  -> run judge model with tools disabled
  -> run synthesizer model with tools disabled
  -> return final answer plus compact metadata
```

The returned metadata should include:

```ts
type CompoundRunMetadata = {
  branchCount: number
  successfulBranchCount: number
  failedBranchCount: number
  judgeModel: string
  synthesizerModel: string
}
```

### Failure Handling

- If config validation fails, fail before starting branches.
- If all branches fail, return a tool error with branch failure summaries.
- If at least one branch succeeds, continue to judge.
- If judge fails, fail the run in the first pass. Do not silently synthesize from raw outputs.
- If synthesizer fails, fail the run.
- If a branch times out, record it as a branch failure and continue if another branch succeeds.
- If the parent session is cancelled, cancel in-flight branch/judge/synth runs.

### Safety

- Branches must not mutate the workspace by default.
- Judge and synthesizer must not receive tools in the first pass.
- Do not use team mailbox, team task persistence, or teammate lifecycle state for compound execution.
- Do not expose branch scratch output as parent assistant text unless returned inside explicit tool metadata.

## Implementation Slices

### PR 1: Compound Config And Validation

- Add `packages/opencode/src/session/compound/config.ts`.
- Define schemas/types for `CompoundConfig`, `CompoundBranch`, `CompoundJudge`, and `CompoundSynthesizer`.
- Validate model strings using existing provider/model parsing where available.
- Enforce default `maxBranches`, default `toolPolicy`, required judge model, and required synthesizer model.
- Add focused tests for valid config, missing judge, missing synthesizer, too many branches, invalid tool policy, and defaulting behavior.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/compound-config.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must compare the diff against this spec and verify that PR 1 only adds config parsing/validation, with no provider, tool registry, session execution, or UI changes.

### PR 2: Compound Runner With Branch Execution

- Add `packages/opencode/src/session/compound/runner.ts`.
- Implement branch expansion from validated config.
- Reuse existing child prompt/session execution patterns from `packages/opencode/src/tool/task.ts` rather than duplicating session mechanics.
- Run branches concurrently with cancellation and timeout handling.
- Return successful branch outputs plus structured branch failures.
- Keep branch tool policy restricted to `"readonly"` or `"none"`.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/compound-runner.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must verify that branch execution reuses existing prompt/session machinery, does not call providers directly, does not bypass tool permissions, and does not introduce team persistence coupling.

### PR 3: Judge And Synthesizer Passes

- Add `packages/opencode/src/session/compound/judge.ts`.
- Add `packages/opencode/src/session/compound/synthesizer.ts`.
- Implement judge prompt construction with structured `CompoundJudgeResult`.
- Implement synthesizer prompt construction from original prompt, branch outputs, branch failures, and judge result.
- Ensure judge and synthesizer execute with tools disabled.
- Add tests for judge prompt construction, synthesizer prompt construction, all-branches-failed behavior, judge failure behavior, and synthesizer failure behavior.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/compound-judge.test.ts test/session/compound-synthesizer.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must verify that judge output is analysis-only, synthesizer owns final answer generation, and neither judge nor synthesizer receives tools.

### PR 4: Local Fusion Tool Surface

- Add `packages/opencode/src/tool/local_fusion.ts`.
- Register the tool in `packages/opencode/src/tool/registry.ts`.
- Keep the tool implementation thin: parse input, load/validate config, call `SessionCompound.runner`, return final text and metadata.
- Do not add transparent `model: "compound/..."` routing in this PR.
- Add tests for tool input validation, inline config execution path, named config lookup path if config storage exists, and safe failure messages.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/tool/local-fusion.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only reviewer must verify that the tool contains no fanout/judge/synthesis policy beyond input handling, and that registry changes only expose the tool.

### PR 5: Documentation And Usage Examples

- Add user-facing documentation for the local compound tool and config shape.
- Document default safety policy: readonly/no tools for branches, no tools for judge/synthesizer.
- Document failure behavior: all branches fail, partial branch failures, judge failure, synthesizer failure, timeout.
- Add one minimal example and one research-panel example.
- Update any config reference docs that currently list available local tool/config capabilities.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test --timeout 30000 test/tool/local-fusion.test.ts`

Review:

A fresh read-only reviewer must verify docs match implemented behavior and do not promise model-slug routing, branch trace UI, crash recovery, or mutating branch tools.

## Future Work

- Add transparent compound model slugs such as `compound/research-panel`.
- Add expandable branch traces in the TUI.
- Add branch quorum settings, scoring, and partial-degradation policy.
- Add mutating branch tool policies with explicit serialization or sandboxing.
- Add durable compound run records for crash recovery and later inspection.
- Add cost/time budget controls per compound config.
- Add model diversity presets based on provider/model metadata.
- Add OpenAPI/SDK support only if compound configs or run metadata become API-visible. If that happens, regenerate the JavaScript SDK with `./packages/sdk/js/script/build.ts`.

## Open Questions

- Should the first public surface be only `local_fusion` tool, or should `model: "compound/..."` ship at the same time? Default: ship only the tool first to keep scope and review size small.
- Where should named compound configs live? Default: add a dedicated config module only if existing config conventions support it cleanly; otherwise start with inline tool config.
- Should branches be allowed to use `bash` in readonly mode? Default: no for first pass, because command safety is hard to prove and parallel shell execution increases risk.
- Should judge failure fall back to raw-output synthesis? Default: no for first pass; fail loudly so quality and safety issues are visible.
