# Manual Smoke Checklist

Run these checks before cutting a release or considering PR 16 complete:

```sh
bun test
bun run typecheck
bun run lint
bun run diagnostics
bun run check
bun run start version --json
bun run start diagnostics --json
bun run start commands
bun run start run "hello" --json --model fake/test
bun run start run "/review smoke diff" --json --model fake/test
```

Expected smoke output highlights:

- `version --json` prints `{ "name": "oc2", "version": "0.0.0" }` for the current package version.
- `diagnostics --json` prints `generatedAt`, `environment`, and `diagnostics` fields.
- `commands` lists built-in slash commands including `/review`, `/clarify`, `/spec-planner`, `/spec-implement`, `/team-report`, and `/init`.
- `run "hello" --json --model fake/test` completes with `finalAssistantText: "fake response"` and `exitStatus: "completed"`.
- `run "/review smoke diff" --json --model fake/test` dispatches the `/review` slash command and completes with `exitStatus: "completed"`.

Optional interactive smoke:

```sh
bun run smoke:tui
```

This opens the TUI with the fake model. Verify prompt entry, streamed assistant text, side panel toggling, `/` suggestions, `/rev` then `Tab` completion, `Enter` command submission, `/help`, and `Ctrl+C` exit manually.

TUI visual smoke checks:

- Footer shows the current root, abbreviates the home directory as `~`, shows `+N roots` when launched with multiple `--root` values, and displays `/status` when status details exist.
- Footer indicators appear for pending permissions, MCP servers/resources, and active team/subagent work when those runtime states are present.
- Sidebar shows session id, root summary, active/completed tools, team/member status, MCP server/resource status, diagnostics, current model, and current variant when known.
- Permission prompts render as dialogs, show pending tool/action/resource details, and disappear after allow or deny resolution.
- Question prompts render as dialogs with options or a free-form fallback and disappear after the associated permission resolves.
- Redacted permission, question, team, task, mailbox, and resource fields must remain redacted; raw secrets from runtime events must not display in the footer, sidebar, or dialogs.
- After sidebar/dialog interaction and `Ctrl+C` exit, the terminal prompt, cursor, and colors are restored.
