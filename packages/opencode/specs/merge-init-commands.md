# Merge Init And Init V2 Commands

## Goal

Merge `/init_v2` behavior into `/init` so there is one guided `AGENTS.md` setup command. The merged `/init` must keep the existing `/init` entry points while adopting the `init_v2` required engineering principles and memory-index guidance.

Default implementation: replace the current `/init` template with the `init_v2` template behavior, remove the public `init_v2` built-in command, and update tests/docs to describe `/init` as the canonical command.

## Current State

- `packages/opencode/src/command/index.ts` defines two built-in slash commands: `Command.Default.INIT = "init"` and `Command.Default.INIT_V2 = "init_v2"`.
- `commands[Default.INIT]` uses `packages/opencode/src/command/template/initialize.txt` with description `guided AGENTS.md setup`.
- `commands[Default.INIT_V2]` uses `packages/opencode/src/command/template/initialize-v2.txt` with description `guided AGENTS.md setup with required engineering principles`.
- `initialize-v2.txt` is mostly `initialize.txt` plus memory-index guidance, required engineering principles, and instructions to preserve existing init output while appending or merging the principles.
- `packages/opencode/src/project/project.ts` marks `time_initialized` only when the executed command name is `Command.Default.INIT`.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` exposes `POST /session/:sessionID/init`, hardwired to `Command.Default.INIT`.
- `packages/opencode/test/command/command.test.ts` currently asserts that `init_v2` exists without changing `init`.
- `packages/opencode/test/acp/service-session.test.ts` confirms ACP text `/init now` invokes command `init` with args `now`.
- `README.md` mentions `/init_v2` as a contributor helper.
- Docs that already describe `/init` include `packages/web/src/content/docs/rules.mdx`, `packages/web/src/content/docs/tui.mdx`, `packages/web/src/content/docs/commands.mdx`, `packages/web/src/content/docs/server.mdx`, and `packages/web/src/content/docs/sdk.mdx`.
- TUI tips mention `/init` in `packages/opencode/src/cli/cmd/tui/feature-plugins/home/tips-view.tsx`.

## Non-Negotiables

- `/init` must remain the canonical user-facing slash command.
- `/init` must include the required principles exactly in spirit: think before coding, simplicity first, surgical changes, and goal-driven execution.
- `POST /session/:sessionID/init` must continue to invoke the merged `/init` behavior.
- Running `/init` must continue to mark the project initialized through the existing `Command.Default.INIT` path.
- Do not change OpenAPI schemas or SDK generated types unless a route/schema change becomes necessary.
- Do not add a hidden command system only for `init_v2` compatibility in the first pass.
- Leave localized docs sync out of the first pass unless this repo requires it in the docs workflow.

## Command Behavior

`/init` should become the only built-in init command.

Expected built-in command shape in `packages/opencode/src/command/index.ts`:

```ts
commands[Default.INIT] = {
  type: "local",
  name: Default.INIT,
  description: "guided AGENTS.md setup with required engineering principles",
  arguments: ["$ARGUMENTS"],
  template: await Bun.file(import.meta.dir + "/template/initialize.txt").text(),
}
```

Implementation details:

- Move the contents of `initialize-v2.txt` into `initialize.txt`, or update `initialize.txt` to include the same behavior.
- Remove `Default.INIT_V2` from the built-in enum/object if no alias is kept.
- Remove the `commands[Default.INIT_V2]` registration.
- Delete `packages/opencode/src/command/template/initialize-v2.txt` if no code references it remain.
- Keep `${path}` replacement behavior unchanged.
- Keep `$ARGUMENTS` support unchanged.

Compatibility behavior:

- Default: `/init_v2` should no longer appear in `/command` results.
- Default: invoking `/init_v2` should behave like any unknown command.
- If reviewers require compatibility, keep `init_v2` as a temporary alias only after explicitly accepting that it will remain visible in runtime command lists unless a separate hidden/deprecated-command design is added.

## Docs Updates

Update docs and contributor references to point to `/init` only.

- `README.md`: replace `/init_v2` contributor-helper mention with `/init`.
- `packages/web/src/content/docs/rules.mdx`: mention that `/init` creates or updates `AGENTS.md` with required engineering principles.
- `packages/web/src/content/docs/tui.mdx`: keep `/init`, update description only if it lists behavior.
- `packages/web/src/content/docs/commands.mdx`: keep built-in command examples aligned with `/init`.
- `packages/web/src/content/docs/server.mdx`: no endpoint rename; clarify that `POST /session/:id/init` uses merged `/init` behavior only if behavior is described.
- `packages/web/src/content/docs/sdk.mdx`: no SDK method rename; clarify `session.init` behavior only if behavior is described.

## Implementation Slices

### PR 1: Merge Built-In Command Behavior

- Update `packages/opencode/src/command/template/initialize.txt` to include the `initialize-v2.txt` behavior.
- Remove `Command.Default.INIT_V2` from `packages/opencode/src/command/index.ts`.
- Remove the `commands[Default.INIT_V2]` registration.
- Delete `packages/opencode/src/command/template/initialize-v2.txt`.
- Update `packages/opencode/test/command/command.test.ts` to assert `init` contains the required principles, contains memory-index guidance if that remains part of the merged behavior, still exposes `["$ARGUMENTS"]`, and `init_v2` is absent if removal is accepted.
- Do not change `packages/opencode/src/project/project.ts` unless an alias is kept.

Verification:

- `cd packages/opencode && bun test test/command/command.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer before merge. The reviewer must compare the diff against this slice and specifically check that `/init` received all `init_v2` behavior, `init_v2` was intentionally removed or retained, and no unrelated command behavior changed.

### PR 2: Update User-Facing Docs

- Replace `/init_v2` references in `README.md` with `/init`.
- Update English docs that describe `/init` behavior: `packages/web/src/content/docs/rules.mdx`, `packages/web/src/content/docs/tui.mdx`, `packages/web/src/content/docs/commands.mdx`, `packages/web/src/content/docs/server.mdx`, and `packages/web/src/content/docs/sdk.mdx`.
- Keep endpoint and SDK method names unchanged: `POST /session/:id/init` and `session.init`.

Verification:

- `cd packages/web && bun run build`

Review:

Use a fresh read-only reviewer before merge. The reviewer must check that docs do not advertise `/init_v2`, do not imply a new top-level CLI command, and do not describe any unimplemented compatibility alias.

### PR 3: Integration Regression Check

- Verify ACP slash command behavior still routes `/init now` to command `init`.
- Verify HTTP init still invokes the merged command through `Command.Default.INIT`.
- Verify project initialization timestamp behavior remains tied to `/init`.

Verification:

- `cd packages/opencode && bun test test/acp/service-session.test.ts`
- `cd packages/opencode && bun run test:httpapi`
- `cd packages/opencode && bun test test/project/project.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

Use a fresh read-only reviewer before merge. The reviewer must check the runtime paths in `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`, and `packages/opencode/src/project/project.ts` for accidental behavior drift.

## Future Work

- Add a formal deprecated or hidden command mechanism if compatibility aliases are needed without listing aliases in `/command`.
- Add telemetry or migration messaging for removed built-in slash commands if command removals become common.
- Sync localized docs after English docs land, if the docs workflow requires manual locale updates.

## Open Questions

- Should `/init_v2` be removed immediately or kept as a temporary alias? Default: remove it. This matches “merge commands,” avoids duplicate command list entries, and keeps `/init` as the only canonical command.
- Should the memory-index instruction from `init_v2` stay in the merged `/init` template? Default: yes. It is part of the current `init_v2` behavior and should move with the merge unless reviewers decide it is too contributor-specific.
