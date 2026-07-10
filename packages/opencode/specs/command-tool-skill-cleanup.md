# Command, Tool, And Skill Cleanup

## Goal

Remove the requested deprecated slash commands and GitHub custom tools, convert `/team-report` from a built-in command to the existing skill surface, and rename selected built-in commands to colon-separated names.

First pass must change only command/tool/skill registration, tests, repo-local config, and docs. Do not rename the `local_fusion` tool id or config key.

## Current State

- `.oc2/command/ai-deps.md`, `.oc2/command/commit.md`, `.oc2/command/issues.md`, and `.oc2/command/rmslop.md` are repo-local commands loaded by `packages/opencode/src/config/command.ts`.
- `/review` is built in at:
  - `packages/opencode/src/command/index.ts`
  - `packages/opencode/src/command/template/review.txt`
  - `packages/core/src/plugin/command.ts`
  - `packages/core/src/plugin/command/review.txt`
- `/local_fusion`, `/spec-implement`, `/spec-planner`, and `/team-report` are built-in command registrations in `packages/opencode/src/command/index.ts`.
- Built-in skills already exist for `spec-planner` and `team-report` in:
  - `packages/opencode/src/skill/index.ts`
  - `packages/core/src/plugin/skill.ts`
  - `packages/core/src/plugin/skill/spec-planner.md`
  - `packages/core/src/plugin/skill/team-report.md`
- `Command.layer` in `packages/opencode/src/command/index.ts` projects skills as slash commands only when no same-name command exists.
- `.oc2/tool/github-pr-search.ts` and `.oc2/tool/github-triage.ts` are repo-local custom tools discovered by `packages/opencode/src/tool/registry.ts`.
- `.oc2/agent/duplicate-pr.md`, `.oc2/agent/triage.md`, and `.oc2/oc2.jsonc` reference those GitHub tools.
- `packages/opencode/src/tool/local_fusion.ts`, `packages/opencode/test/tool/local-fusion.test.ts`, `packages/sdk/openapi.json`, and generated SDK types use `local_fusion` as a tool/config name.
- Colon command names are parse-safe in current prompt paths because command parsing splits on whitespace, not `:`.

## Non-Negotiables

- Removed commands must not remain user-facing as slash commands.
- Do not add aliases for old command names.
- Keep `local_fusion` as the tool id, permission id, config key, OpenAPI config field, and generated SDK field.
- `/team-report` must no longer be `source: "command"`; it may remain directly executable only as `source: "skill"`.
- `/spec-planner` must not reappear as a skill-projected slash command after `/spec:planner` is added.
- Do not regenerate SDKs unless an API schema changes.
- Leave migration warnings, telemetry, and compatibility aliases out of the first pass.

## Command, Tool, And Skill Behavior

- Delete repo-local command files for:
  - `.oc2/command/ai-deps.md`
  - `.oc2/command/commit.md`
  - `.oc2/command/issues.md`
  - `.oc2/command/rmslop.md`
- Remove `/review` from both command systems:
  - `packages/opencode/src/command/index.ts`
  - `packages/core/src/plugin/command.ts`
- Rename built-in command ids:
  - `/local_fusion` -> `/local:fusion`
  - `/spec-implement` -> `/spec:implement`
  - `/spec-planner` -> `/spec:planner`
- Keep `packages/opencode/src/command/template/local-fusion.txt` calling the `local_fusion` tool exactly once.
- Remove the built-in `/team-report` command and template so the existing `team-report` skill is exposed as `source: "skill"`.
- Suppress skill-to-command projection for the built-in `spec-planner` skill so old `/spec-planner` fails, while the skill remains loadable through the skill tool.
- Delete `.oc2/tool/github-pr-search.ts` and `.oc2/tool/github-triage.ts`.
- Remove all `github-pr-search` and `github-triage` references from `.oc2/oc2.jsonc`, `.oc2/agent/duplicate-pr.md`, and `.oc2/agent/triage.md`.

## Docs To Update

- `README.md`
- `packages/web/src/content/docs/commands.mdx`
- `packages/web/src/content/docs/tui.mdx`
- `packages/web/src/content/docs/tools.mdx`
- `packages/web/src/content/docs/config.mdx`
- `packages/web/src/content/docs/local-fusion.mdx`
- `packages/tui/src/feature-plugins/home/tips-view.tsx`
- `packages/opencode/src/command/template/clarify.txt`

Docs must use `/local:fusion`, `/spec:implement`, and `/spec:planner` for slash commands. References to the tool/config/API name must remain `local_fusion`.

## Implementation Slices

### PR 1: Built-In Command Cleanup

- Remove `/review` from `packages/opencode/src/command/index.ts`.
- Delete `packages/opencode/src/command/template/review.txt`.
- Remove core plugin `review` registration from `packages/core/src/plugin/command.ts`.
- Delete `packages/core/src/plugin/command/review.txt`.
- Rename built-in command ids in `packages/opencode/src/command/index.ts` to `local:fusion`, `spec:implement`, and `spec:planner`.
- Remove built-in `team-report` command registration and template.
- Add or update tests proving:
  - `command.get("team-report")?.source === "skill"`
  - `command.get("spec-planner")` is absent or not slash-projected
  - `command.get("spec:planner")`, `command.get("spec:implement")`, and `command.get("local:fusion")` exist
- Update affected tests:
  - `packages/opencode/test/command/command.test.ts`
  - `packages/opencode/test/session/prompt.test.ts`
  - `packages/opencode/test/cli/run/footer.view.test.tsx`
  - `packages/core/test/plugin/command.test.ts`
  - `packages/core/test/command.test.ts`
  - `packages/core/test/config/command.test.ts`

Verification:

- From `packages/opencode`: `bun test --timeout 30000 test/command/command.test.ts test/session/prompt.test.ts test/cli/run/footer.view.test.tsx test/skill/skill.test.ts test/tool/skill.test.ts test/cli/acp/skills.test.ts`
- From `packages/opencode`: `bun typecheck`
- From `packages/core`: `bun test test/plugin/command.test.ts test/command.test.ts test/config/command.test.ts`
- From `packages/core`: `bun typecheck`

Review:

A fresh read-only teammate must review the diff for accidental aliases, old slash names, `/team-report` skill behavior, and `/spec-planner` projection suppression.

### PR 2: Repo-Local Command And GitHub Tool Removal

- Delete:
  - `.oc2/command/ai-deps.md`
  - `.oc2/command/commit.md`
  - `.oc2/command/issues.md`
  - `.oc2/command/rmslop.md`
  - `.oc2/tool/github-pr-search.ts`
  - `.oc2/tool/github-triage.ts`
- Remove `github-pr-search` and `github-triage` from `.oc2/oc2.jsonc`.
- Delete or rewrite `.oc2/agent/duplicate-pr.md` and `.oc2/agent/triage.md` so they no longer enable or instruct removed tools.

Verification:

- From repo root: `rg -n -uu "github-pr-search|github-triage|/ai-deps|/commit|/issues|/rmslop" .oc2 packages README.md --glob '!**/node_modules/**' --glob '!packages/web/dist/**'`
- From `packages/opencode`: `bun typecheck`

Review:

A fresh read-only teammate must review the search output and confirm removed tools are not registered, disabled, enabled by agents, or documented.

### PR 3: Docs, TUI Copy, And Final Search Cleanup

- Update README and web docs for new slash command names.
- Keep `local_fusion` only where it means tool/config/API/schema.
- Move `/team-report` wording out of built-in command docs and into skill-oriented docs.
- Remove `/review` tips from TUI copy.
- Update `packages/opencode/src/command/template/clarify.txt` to use `/spec:planner`.
- Add or update UI/autocomplete coverage for colon command names where practical.

Verification:

- From repo root: `rg -n -uu "/ai-deps|/commit|/issues|/review|/rmslop|/local_fusion|/spec-implement|/spec-planner" README.md packages .oc2 --glob '!**/node_modules/**' --glob '!packages/web/dist/**'`
- From `packages/web`: `bun run build`
- From `packages/tui`: `bun typecheck`
- From `packages/app`: `bun typecheck`

Review:

A fresh read-only teammate must review the docs diff and final search output. Any retained `local_fusion` match must clearly be a tool/config/API reference, not a slash command.

## Future Work

- Add migration warnings only if users need old-name discoverability.
- Consider a general command deprecation registry only if more built-in commands are renamed later.
- Consider a broader skill naming policy for colon-separated names; leave out of first pass.

## Open Questions

- Should `.oc2/agent/duplicate-pr.md` and `.oc2/agent/triage.md` be deleted or rewritten? Default: delete if their only purpose is the removed GitHub tool workflow.
- Should template filenames be renamed away from old strings? Default: no, unless filename matches block the final search policy.
