# Local Fusion Write Isolation

## Goal

Update `local_fusion` so branch and judge sessions stay research-only for workspace files, even when configured with write-capable tool policies. Branches may create scratch files only inside an isolated temporary folder. The judge must not edit workspace files. The synthesizer is the only stage allowed to apply final workspace edits, using judge output, branch outputs, and its own reasoning.

This prevents parallel branches from making the same repository edits and overwriting each other while preserving scratch-file workflows for models that need temporary artifacts.

## Current State

- `packages/core/src/config/local-fusion.ts` defines `ToolPolicy` as `"readonly" | "none" | "parent_without_teams" | "all"` for branches, judge, and synthesizer.
- `packages/opencode/src/session/compound/config.ts` defaults branches to `"readonly"` and judge/synthesizer to `"none"`.
- `packages/opencode/src/session/compound/runner.ts` runs branches concurrently with unbounded concurrency and creates a child session for each branch.
- `packages/opencode/src/session/compound/judge.ts` creates a child judge session and requests structured JSON.
- `packages/opencode/src/session/compound/synthesizer.ts` creates the final child synthesizer session and returns final text.
- `packages/opencode/src/session/compound/tool-policy.ts` maps tool policies to prompt tools and child permissions.
- `packages/opencode/src/permission/index.ts` centralizes permission evaluation. `write` and `apply_patch` are treated as `edit` for disabled-tool checks.
- `packages/opencode/src/tool/write.ts`, `packages/opencode/src/tool/edit.ts`, and `packages/opencode/src/tool/apply_patch.ts` all gate mutations through permission `"edit"`.
- `packages/opencode/src/tool/external-directory.ts` requires `external_directory` permission for absolute temp paths outside session roots.
- Docs needing updates:
- `packages/web/src/content/docs/local-fusion.mdx`
- `packages/web/src/content/docs/tools.mdx`
- `packages/web/src/content/docs/config.mdx`

## Non-Negotiables

- Branch and judge sessions must not modify files under any session root.
- Branch temp writes must be isolated per branch so two branches cannot overwrite each other's scratch files.
- Judge temp writes, if enabled by policy, must use its own isolated temp directory.
- Synthesizer is the only compound stage allowed to make workspace edits.
- Parent deny rules remain ceilings. A parent/session edit deny must not be bypassed by local fusion temp-write behavior.
- Do not change existing `"readonly"` semantics. It must remain non-mutating.
- Do not enable write-capable policies for normal `/local_fusion` if they are currently Logu-only; keep existing validation unless a later slice explicitly changes it.
- Leave branch patch application and workspace diff merging out of the first pass.

## Permission Design

Add role-aware compound permissions without adding a new public policy in the first pass.

Internal role shape:

```ts
type CompoundRole =
  | { type: "branch"; index: number }
  | { type: "judge" }
  | { type: "synthesizer" }
```

For branch and judge roles with write-capable policy:

- Expose only research tools plus scratch-file tools.
- Allow `write` and `edit` only for the role's temp directory.
- Do not expose `apply_patch`.
- Add broad workspace/root edit denies before temp-specific allows.
- Add `external_directory` allow for the temp directory.
- Keep `team_create`, `team_spawn`, and `local_fusion` disabled.

For synthesizer with write-capable policy:

- Preserve current write-capable behavior, subject to parent/session denies.
- Keep nested team/local-fusion protections from existing policy handling.

Temp directory shape:

```text
<base>/opencode-local-fusion/<parent-session-id>/<compound-run-id>/branch-<index>/
<base>/opencode-local-fusion/<parent-session-id>/<compound-run-id>/judge/
```

The default `<base>` is `os.tmpdir()`. If `<base>/opencode-local-fusion` would be inside any registered session root, OpenCode falls back to a sibling base outside the containing root using `<root-basename>-opencode-local-fusion`, repeating until the scratch root is outside every session root. If no outside base can be found, local fusion fails instead of creating a scratch directory inside a session root. The synthesizer does not use a local fusion scratch directory.

Failure modes:

- Branch or judge writes to a repo-relative path must fail with an edit-permission denial.
- Branch or judge writes to an absolute path outside its assigned temp directory must fail with either `external_directory` or `edit` denial.
- Branch or judge `apply_patch` calls must be unavailable or denied.
- Mixed-path edit attempts must deny the whole operation.

## Prompt Behavior

Branch prompts should explicitly say:

- "Use tools to research and propose changes."
- "Do not edit workspace files."
- "If scratch files are needed, write only under `<temp-dir>`."
- "Return recommended edits as text, file paths, and rationale."

Judge prompts should explicitly say:

- "Evaluate branch outputs and produce structured guidance for the synthesizer."
- "Do not edit workspace files."
- "If scratch files are needed, write only under `<temp-dir>`."

Synthesizer prompts should explicitly say:

- "You are the only stage that may make final workspace edits when tools permit."
- "Use judge output and branch findings as inputs, but independently verify before editing."

## Implementation Slices

### PR 1: Role-Aware Compound Scratch Permissions

- Add role-aware inputs to `SessionCompoundToolPolicy.resolvePromptTools(...)` and `resolveChildPermission(...)` in `packages/opencode/src/session/compound/tool-policy.ts`.
- Generate isolated temp directories for branch and judge children in `packages/opencode/src/session/compound/runner.ts` and `packages/opencode/src/session/compound/judge.ts`.
- For branch/judge write-capable policies, deny workspace edits and allow `edit` plus `external_directory` only under the assigned temp directory.
- Ensure `apply_patch` is unavailable for branch/judge roles.
- Preserve synthesizer behavior in `packages/opencode/src/session/compound/synthesizer.ts`.

Verification:

- From `packages/opencode`: `bun test --timeout 30000 test/session/compound-runner.test.ts test/session/compound-judge.test.ts test/session/compound-synthesizer.test.ts`
- From `packages/opencode`: `bun typecheck`

Review:

Before merge, run a fresh read-only sub-agent against the PR diff. It must verify that branch/judge cannot edit session roots, temp dirs are per child, parent deny rules remain ceilings, and synthesizer remains the only workspace-writing stage.

### PR 2: Tool Exposure And Permission Tests

- Add or update tests covering `Permission.disabled(...)` behavior when broad edit denies coexist with temp-specific edit allows.
- Add tests for `write` and `edit` allowing branch/judge temp paths while denying repo paths.
- Add tests that branch/judge `apply_patch` is not exposed or is denied.
- Add tests that normal `/local_fusion` still rejects non-Logu `"all"` and `"parent_without_teams"` if current behavior remains unchanged.

Verification:

- From `packages/opencode`: `bun test --timeout 30000 test/tool/local-fusion.test.ts test/session/compound-config.test.ts`
- From `packages/opencode`: `bun test --timeout 30000 test/tool/write.test.ts test/tool/edit.test.ts test/tool/external-directory.test.ts`
- From `packages/opencode`: `bun typecheck`

Review:

Use a fresh read-only sub-agent to inspect the tests against the requirement. It must confirm tests fail without the permission change and cover repo-path denial, temp-path allow, and branch/judge patch prevention.

### PR 3: Prompt And Documentation Updates

- Update branch, judge, and synthesizer prompt text in:
- `packages/opencode/src/session/compound/runner.ts`
- `packages/opencode/src/session/compound/judge.ts`
- `packages/opencode/src/session/compound/synthesizer.ts`
- Update docs:
- `packages/web/src/content/docs/local-fusion.mdx`
- `packages/web/src/content/docs/tools.mdx`
- `packages/web/src/content/docs/config.mdx`
- Document that branches and judge are research stages and only the synthesizer should apply final edits.

Verification:

- From `packages/opencode`: `bun test --timeout 30000 test/session/compound-runner.test.ts test/session/compound-judge.test.ts test/session/compound-synthesizer.test.ts`
- From `packages/opencode`: `bun typecheck`
- From `packages/web`: `bun run build`

Review:

Use a fresh read-only sub-agent to compare docs and prompts against implemented behavior. It must flag any doc implying branches or judge can edit workspace files.

## Future Work

- Add first-class UI/reporting for branch scratch directories.
- Add automatic cleanup policy for old local-fusion temp folders.
- Add optional branch-generated patch artifacts that the synthesizer can inspect without applying.
- Consider a public policy name such as `"research_with_temp_write"` only if users need to configure this behavior outside existing write-capable Logu policies.

## Open Questions

- Should branch/judge temp directories be retained after the run for debugging? Default recommendation: retain initially under `os.tmpdir()` and document the path; add cleanup later.
- Should branch/judge expose `edit` as well as `write` for temp files? Default recommendation: expose both for temp paths, but keep `apply_patch` unavailable because patch semantics target workspace-style edits.
