# Reduce Repeated Tool-Description Guidance

## Goal

Reduce repeated guidance in tool descriptions, starting with Shell and Task, without changing provider prompt alternatives or removing behavior-critical safety constraints.

The implementation strategy is to shorten high-frequency tool-description text that is sent as tool schema metadata on each model call, while preserving the model's ability to use shell/task safely and reliably. First pass must only edit tool descriptions and tests; do not modify `SystemPrompt.provider(...)` or provider prompt files.

## Current State

- `packages/opencode/src/session/prompt.ts:1532` calls `SessionTools.resolve(...)` on each loop before `handle.process`.
- `packages/opencode/src/session/prompt.ts:1607` passes resolved `tools` into the model request.
- `packages/opencode/src/session/tools.ts:78` loads tool definitions from `ToolRegistry.tools(...)`.
- `packages/opencode/src/session/tools.ts:84` converts each definition into an AI SDK `tool({ description, inputSchema, execute })`.
- `packages/opencode/src/session/llm/request.ts:149` filters request tools.
- `packages/opencode/src/session/llm/request.ts:176` sorts tools by name, which is good for stable cache behavior.
- `packages/opencode/src/session/llm.ts:346` and `packages/opencode/src/session/llm.ts:347` pass active tool names and tool definitions to `streamText`.
- `packages/opencode/src/session/llm/native-request.ts:126` converts tool definitions into native `ToolDefinition` values.
- `packages/opencode/src/tool/shell/shell.txt` contains Shell tool template guidance.
- `packages/opencode/src/tool/shell/prompt.ts` renders shell-specific command guidance and parameter descriptions.
- `packages/opencode/src/tool/task.txt` contains static Task tool guidance and examples.
- `packages/opencode/src/tool/registry.ts:385` appends available subagent descriptions to the Task tool description.
- Provider prompt alternatives are selected by `packages/opencode/src/session/system.ts:20`; they are not the target of this work.

## Non-Negotiables

- Must not edit `packages/opencode/src/session/prompt/default.txt`, `gpt.txt`, `codex.txt`, or `SystemPrompt.provider(...)` in the first pass.
- Must preserve Shell safety rules: no destructive git unless explicit, no commits/PRs unless explicit, quote paths with spaces, use `workdir` instead of `cd`, avoid shell for file read/write/search/edit when specialized tools exist.
- Must preserve Task safety rules: use subagents for complex multi-step work, do not duplicate delegated work, trust completed subagent results, resume with `task_id` when needed.
- Must preserve tool schema shape and tool IDs.
- Must keep tool ordering deterministic.
- Must not filter tools or subagents based on guessed relevance in the first pass.
- Must not reduce prompt-cache effectiveness by introducing dynamic ordering or task-specific mutations into stable tool descriptions.

## Tool Description Design

First pass changes are text-only compression.

Shell description must keep:

- Tool purpose: terminal operations only.
- `workdir` requirement instead of `cd`.
- Path quoting rule.
- Output truncation behavior and how to read full output.
- Dedicated-tool preference for file search/content/read/edit/write.
- Parallel independent shell calls.
- Sequential dependent commands through shell-appropriate chaining.
- Git/GitHub guardrails.

Shell description may remove or compress:

- Multiple correct/incorrect quoting examples.
- Repeated command-description examples.
- Long PR body examples.
- Repeated "capture output" and "command argument required" prose.
- Duplicated reminders already present in `shell.txt` and rendered command sections.

Task description must keep:

- `subagent_type` requirement.
- When not to use Task.
- Fresh context vs `task_id` resume behavior.
- Requirement to specify expected result and whether edits are allowed.
- Do not duplicate delegated work.
- Trust subagent results, and delegate again with clearer instructions if insufficient.
- Available agent type list from `ToolRegistry.describeTask`.

Task description may remove or compress:

- Fictional example agents.
- Long prime-number example.
- Greeting example.
- Repeated trust/delegation phrasing.
- Verbose explanation of user visibility, as long as the final-result handoff behavior remains clear.

## Deterministic Checks

Add a small test that asserts rendered descriptions retain required safety phrases and remove the largest low-value examples.

Recommended test coverage:

- Shell render includes `workdir`, path quoting, dedicated tools, output truncation, git explicitness.
- Shell render does not include the long PR heredoc example.
- Task description includes `subagent_type`, `task_id`, "do not duplicate", and "Trust agent results".
- Task description does not include fictional example agent names or prime-number sample code.
- Tool descriptions remain deterministic across repeated render calls.

## Implementation Slices

### PR 1: Compress Shell Tool Guidance

- Edit `packages/opencode/src/tool/shell/shell.txt` to shorten repeated Git/GitHub and terminal-operation guidance.
- Edit `packages/opencode/src/tool/shell/prompt.ts` to compress Bash, PowerShell, and cmd command sections.
- Keep OS/shell-specific guidance where command syntax materially differs.
- Keep parameter schema unchanged.
- Add or update a focused shell prompt render test under `packages/opencode/test/tool/`.

Verification:

- `bun typecheck`
- `bun test`

Review:

Ask a fresh read-only reviewer to compare the diff against this spec and verify that the required Shell safety phrases remain present while removed examples are only low-value repetition.

### PR 2: Compress Task Tool Guidance

- Edit `packages/opencode/src/tool/task.txt` to remove fictional examples and compress usage notes.
- Keep dynamic agent list behavior in `packages/opencode/src/tool/registry.ts:385`.
- Do not filter the available subagent list in this PR.
- Add or update a focused Task tool description test under `packages/opencode/test/tool/`.

Verification:

- `bun typecheck`
- `bun test`

Review:

Ask a fresh read-only reviewer to confirm Task guidance still explains when not to use Task, `task_id` resume behavior, no duplicate work, and expected-output instructions.

### PR 3: Add Request-Shape Guardrails

- Add a small test around tool description assembly or request prep to ensure tool IDs and sorted order remain stable.
- Do not snapshot full long descriptions; assert required phrases and ordering only.
- Confirm no provider prompt files changed.

Verification:

- `bun typecheck`
- `bun test`

Review:

Ask a fresh read-only reviewer to verify the test protects cache-sensitive ordering without freezing the full prompt text.

## Future Work

- Compact skills listing in `packages/opencode/src/session/system.ts:81`.
- Shorten environment prompt in `packages/opencode/src/session/system.ts:49`.
- Audit provider prompt alternatives separately after measuring tool-description reduction.
- Consider tool-output replay truncation only behind a flag and after eval coverage exists.

## Open Questions

- Should PR 1 preserve PR creation instructions inside the Shell tool? Default: keep a one-line `Use gh for GitHub tasks; return the PR URL` rule and remove heredoc/body examples.
- Should tests assert exact token/character budgets? Default: avoid brittle token counts; assert required phrases and absence of removed examples first.
