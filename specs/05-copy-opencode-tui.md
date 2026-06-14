# Copy OpenCode TUI To oc2

## Goal

Port the OpenCode TUI look, feel, and core interactive functionality into `oc2` while preserving `oc2`'s in-process runtime architecture.

The first pass must replace the current plain-text `oc2` TUI with an OpenTUI/Solid-based UI that visually matches OpenCode's default session experience: themed background, bordered prompt, footer/sidebar, dialogs, command palette, slash autocomplete, session transcript, tool rows, permissions/questions, MCP/team/status indicators, and model/agent/session controls where `oc2` already has runtime support. Do not port OpenCode's daemon/server/SDK boundary unless a later design explicitly chooses that architecture.

## Current State

- `oc2` CLI entrypoint is `src/index.ts`; it exports `renderTui`, `launchTui`, `TuiLaunchOptions`, TUI state, and keymap APIs.
- `src/cli/index.ts` dispatches `oc2 tui` by parsing config/paths and calling `launchTui()`.
- `src/cli/commands.ts` currently supports `tui --session`, `--model`, and repeated `--root`.
- `src/tui/app.tsx` is a dependency-free raw terminal adapter that clears the screen with ANSI sequences and renders string output through `renderTui(state, input)`.
- `src/tui/app.tsx` submits prompts through `SessionRunService.run({ prompt, sessionId, model, roots, signal })`.
- `src/tui/app.tsx` hydrates resumed sessions from persisted messages and tool calls.
- `src/tui/state.ts` projects runtime events into `TuiState`, including model streaming, tool lifecycle, permissions, questions, MCP status, scheduler tasks, subagents, teams, team tasks, mailbox, diagnostics, and errors.
- `src/tui/state.ts` already defines panels `"session" | "team" | "mcp" | "agent"`, but the agent panel toggle is not wired in the current keymap/app.
- `src/tui/keymap.ts` is a small raw-byte parser with submit, cancel, side/team/MCP toggles, escape, backspace, input, and noop actions.
- `src/tui/keymap.ts` does not support arrows, cursor movement, multiline input, Unicode-safe input, paste handling, Tab, slash autocomplete, or command palette behavior.
- Current TUI components are plain string renderers under `src/tui/components/`, including `SessionView.tsx`, `MessageList.tsx`, `SidePanel.tsx`, `Footer.tsx`, `TeamPanel.tsx`, `McpPanel.tsx`, `PermissionDialog.tsx`, `QuestionPrompt.tsx`, and `AgentStatus.tsx`.
- `src/session/run.ts` is the main runtime seam. It owns model/profile resolution, session create/resume, SQLite access, scheduler, MCP startup, tool execution, subagents, teams, and the main agent run.
- `src/events/events.ts` already provides a runtime event contract suitable for richer TUI projection without polling runtime internals.
- `src/config/schema.ts` has `tui: { sidePanel: boolean; theme?: string }`, but the current TUI does not apply theme assets.
- Relevant oc2 tests are `test/tui/app.test.tsx`, `test/tui/state.test.ts`, `test/cli/parser.test.ts`, and `test/cli/run.test.ts`.
- `docs/smoke.md` documents `bun run smoke:tui` and manual checks for prompt entry, streaming, side panel toggling, and Ctrl+C exit.
- OpenCode's modern TUI implementation lives in `/Users/srpanwar/Documents/Workspace/brain/opencode/packages/tui/src`.
- OpenCode's public TUI export is `/Users/srpanwar/Documents/Workspace/brain/opencode/packages/tui/src/index.tsx`.
- OpenCode's app shell is `/Users/srpanwar/Documents/Workspace/brain/opencode/packages/tui/src/app.tsx`; it uses `@opentui/core`, `@opentui/solid`, `@opentui/keymap`, Solid providers, theme/dialog/plugin/SDK/sync contexts, mouse, Kitty keyboard, passthrough output, and a 60 FPS renderer.
- OpenCode's keymap/command system is in `/Users/srpanwar/Documents/Workspace/brain/opencode/packages/tui/src/keymap.tsx`, `/config/keybind.ts`, and `/component/command-palette.tsx`.
- OpenCode's session UI is centered around `/routes/session/index.tsx`, with prompt, sidebar, dialogs, permissions/questions, model/agent/session/team commands, scrolling, timeline/fork/export/copy/undo/redo, and rich tool rendering.
- OpenCode's prompt behavior is in `/component/prompt/index.tsx`; slash commands call `sdk.client.session.command(...)`, shell mode calls `sdk.client.session.shell(...)`, and normal prompts call `sdk.client.session.prompt(...)`.
- OpenCode autocomplete is in `/component/prompt/autocomplete.tsx`; it handles `/` and `@`, uses fuzzy matching/frecency, supports keyboard and mouse selection, and renders a floating box above the prompt.
- OpenCode footer/sidebar references are `/routes/session/footer.tsx` and `/routes/session/sidebar.tsx`.
- OpenCode theme references are `/theme/index.ts`, `/context/theme.tsx`, and `/theme/assets/*.json`; default active theme is `opencode`.

## Non-Negotiables

- The oc2 TUI must continue launching through `oc2 tui` from `src/cli/index.ts`.
- The first pass must keep oc2's runtime in-process. Do not port OpenCode's daemon service, worker/RPC bridge, SDK client, SSE reconnect layer, or server registration files.
- The new TUI must consume oc2 runtime state through a narrow adapter over `SessionRunService`, persisted sessions, and `RuntimeEventBus`; do not bind components directly to OpenCode SDK types.
- Preserve existing CLI behavior for `oc2 tui --session`, `--model`, and `--root`.
- Existing non-TUI `run` and `resume` behavior must not change.
- Redaction behavior in `src/tui/state.ts` must remain intact for free-form team/question/resource fields.
- Theme/config paths must use oc2 conventions. Do not read `.opencode` config or global OpenCode config unless explicitly added as a compatibility feature later.
- The first pass must pin OpenTUI/Solid dependency versions compatible with OpenCode's known working versions.
- The session route must be split into maintainable oc2 modules. Do not copy OpenCode's large `routes/session/index.tsx` as one monolithic file.
- First-pass parity must focus on the session experience. Plugin slots, diff viewer plugins, marketplace/plugin manager, share URLs, timeline, fork, undo/redo, and external editor integration are out of scope unless oc2 already exposes the backing runtime API.
- Every implementation slice must include a fresh read-only adversarial review before merge.

## Target Architecture

Add an OpenTUI/Solid TUI layer under `src/tui/` while preserving oc2 runtime ownership.

Expected module shape:

```ts
// src/tui/client.ts
export interface TuiClient {
  sessions: {
    list(input?: { roots?: readonly string[] }): Promise<readonly TuiSessionSummary[]>
    hydrate(sessionId: string): Promise<TuiHydratedSession>
    create(input: { roots: readonly string[]; model?: string }): Promise<TuiSessionSummary>
    prompt(input: {
      sessionId?: string
      prompt: string
      model?: string
      roots: readonly string[]
      signal?: AbortSignal
    }): Promise<{ sessionId: string }>
    abort(sessionId: string): Promise<void>
  }
  commands: {
    list(): Promise<readonly TuiCommand[]>
    execute(input: {
      sessionId?: string
      name: string
      args: readonly string[]
      raw: string
    }): Promise<TuiCommandResult>
  }
  status: {
    snapshot(): Promise<TuiStatusSnapshot>
  }
  events: {
    subscribe(listener: (event: RuntimeEvent) => void): () => void
  }
}
```

Use the adapter to connect:

- `SessionRunService.run()` for normal prompt submission.
- Existing session persistence APIs exposed by `createSessionRunService()` for hydration and session listing.
- `RuntimeEventBus<TuiState>` plus `projectTuiEvent()` for live updates.
- Existing permission/question resolution hooks from `src/session/run.ts`.

Do not create an HTTP API unless later work needs remote TUI operation.

## TUI Behavior

The new oc2 TUI must implement these first-pass behaviors:

- Launch `oc2 tui` into an OpenCode-like home/session UI instead of the current `oc2 tui` plain text screen.
- Use OpenTUI renderer settings equivalent to OpenCode where practical:
- `targetFps: 60`
- `externalOutputMode: "passthrough"`
- `exitOnCtrlC: false`
- mouse enabled from config when supported
- Kitty keyboard support when available
- Use the OpenCode default visual language:
- `opencode` theme as the default
- themed background, panel, element, menu, border, muted text, warning/error/success/info colors
- split-border prompt with left rail
- agent/model metadata under the prompt
- footer with root/session/status indicators
- sidebar width close to OpenCode's `42`
- centered modal dialogs with translucent overlay behavior where OpenTUI supports it
- top-right toast notifications
- Render session transcript with:
- user messages
- streaming assistant text
- completed assistant messages
- tool lifecycle rows
- block tool output for shell/write/edit/read/apply_patch-style tools when data exists
- permission prompts
- question prompts
- diagnostics/errors
- team/subagent activity summaries
- Implement footer indicators:
- root directory label with `~` abbreviation and `+N roots`
- pending permissions count
- MCP server/resource status count
- team/subagent active count when available
- `/status` hint
- Implement sidebar panels:
- session title/id/root summary
- active/completed tools
- team/member status
- MCP status/resources
- diagnostics
- current model
- Preserve the current `sidePanel` config behavior by mapping `tui.sidePanel` to initial sidebar visibility.
- Wire agent panel visibility if kept as a separate panel, or fold it into the sidebar with an explicit keybinding.

## Input, Keymap, And Commands

Use OpenCode's keybinding concepts, adapted to oc2:

- Default leader key: `ctrl+x`.
- Command palette: `ctrl+p`.
- Exit: `ctrl+c`, `ctrl+d`, and `<leader>q`.
- Sidebar toggle: `<leader>b`.
- Status dialog: `<leader>s`.
- Theme list: `<leader>t`.
- Model list: `<leader>m`.
- Agent list: `<leader>a` when oc2 has agent selection data.
- New session: `<leader>n`.
- Session list: `<leader>l`.
- Prompt submit: `return`.
- Prompt newline: `shift+return`, `ctrl+return`, `alt+return`, or `ctrl+j` when terminal input reports it.
- Clear input: `ctrl+c` when input is focused and no run is active; abort active run when a run is active.
- Dialog navigation: `up/down`, `ctrl+p/ctrl+n`, `return`, `escape`.
- Session scroll: page up/down, line up/down, first/last.

Command registry shape:

```ts
export interface TuiCommand {
  id: string
  title: string
  category: "session" | "app" | "model" | "agent" | "theme" | "status" | "debug"
  description?: string
  keybindings?: readonly string[]
  slashName?: string
  slashAliases?: readonly string[]
  enabled: boolean
}
```

Slash behavior:

- `/` autocomplete must list reachable commands from the command registry.
- Slash autocomplete must include aliases.
- Unknown slash commands must show an inline error/toast and must not submit as a normal model prompt by default.
- Known slash commands must dispatch through `TuiClient.commands.execute(...)`.
- If the existing `specs/03-slash-commands.md` remains authoritative, this spec must reference it instead of redefining all command semantics.

Mention behavior:

- `@` autocomplete must be implemented only for data oc2 can provide in first pass.
- First pass should include workspace files and agents only if oc2 already has cheap backing APIs.
- MCP resources and references can be left as future work if they require new indexing/runtime APIs.

## Theme And Config

Add a TUI theme system adapted from OpenCode:

```ts
export interface TuiTheme {
  name: string
  primary: string
  secondary: string
  accent: string
  error: string
  warning: string
  success: string
  info: string
  text: string
  textMuted: string
  selectedListItemText: string
  background: string
  backgroundPanel: string
  backgroundElement: string
  backgroundMenu: string
  border: string
  borderActive: string
  borderSubtle: string
  diffAdded: string
  diffRemoved: string
  markdown: Record<string, string>
  syntax: Record<string, string>
  thinkingOpacity?: number
}
```

Required behavior:

- Default `tui.theme` to `opencode`.
- Vendor/copy the OpenCode `opencode` theme first.
- Add additional built-in themes only after the default path is stable.
- Validate theme JSON at load time.
- If `tui.theme` names an unknown theme, fall back to `opencode` and show a warning toast plus diagnostic entry.
- Do not search `.opencode/themes` in the first pass.
- If custom oc2 themes are added, use an oc2-specific path such as `.oc2/themes/*.json` and document it.

## Testing Strategy

Keep existing state projection tests and add renderer/adapter tests around the new TUI seams.

Expected test coverage:

- `test/tui/state.test.ts` continues to cover event projection, hydration, redaction, panels, MCP, permissions, diagnostics, and agent tasks.
- Replace or refactor `test/tui/app.test.tsx` so it no longer depends on plain string snapshots for the full app shell.
- Add tests for:
- `TuiClient` adapter prompt submission to `SessionRunService.run()`
- session hydration from persisted messages/tool calls
- command registry filtering and slash dispatch
- unknown slash command rejection
- key alias normalization
- leader key timeout/pending sequence behavior
- theme fallback on unknown theme
- footer root label formatting
- sidebar initial visibility from `tui.sidePanel`
- permission/question dialog state transitions
- Keep CLI tests:
- `test/cli/parser.test.ts`
- `test/cli/run.test.ts`
- Update `docs/smoke.md` with the new manual checks.

## Implementation Slices

### PR 1: Add OpenTUI/Solid Foundation And Adapter Boundary

- Add dependencies to `package.json` and lockfile:
- `@opentui/core`
- `@opentui/solid`
- `@opentui/keymap`
- `solid-js`
- `opentui-spinner`
- `fuzzysort`
- `strip-ansi` if tests or terminal-safe assertions need it
- Create `src/tui/client.ts` with the `TuiClient` interface and data shapes.
- Create `src/tui/client.local.ts` that adapts existing oc2 services to `TuiClient`.
- Keep `src/tui/state.ts` as the runtime event projection boundary.
- Add focused tests for prompt submission, abort, hydration, and session listing through the local client adapter.
- Do not replace the visible TUI yet; keep `launchTui()` behavior unchanged until the renderer shell is ready.

Verification:

- `bun test test/tui/state.test.ts test/cli/parser.test.ts test/cli/run.test.ts`
- `bun test test/tui/client.test.ts`
- `bun run typecheck`
- `bun run lint`

Review:

A fresh read-only reviewer must compare this PR against the spec and verify that no OpenCode daemon, SDK client, SSE, worker/RPC, or `.opencode` config dependency was introduced.

### PR 2: Introduce OpenTUI App Shell Behind Existing `launchTui()`

- Replace or wrap `src/tui/app.tsx` so `launchTui()` starts the OpenTUI/Solid renderer.
- Preserve exported `launchTui` and `TuiLaunchOptions`.
- Add a minimal Solid app shell with home/session route state.
- Wire `TuiClient.events.subscribe(...)` to `projectTuiEvent()` and `TuiState`.
- Render a basic session transcript and prompt using OpenTUI components.
- Preserve `oc2 tui --session`, `--model`, and `--root`.
- Preserve cancellation semantics for active runs.
- Keep the old string `renderTui()` only if tests or downstream exports still require it; otherwise remove it in a dedicated cleanup PR after users have migrated.

Verification:

- `bun test test/tui/app.test.tsx test/tui/state.test.ts`
- `bun test test/cli/run.test.ts`
- `bun run typecheck`
- `bun run smoke:tui`

Review:

A fresh read-only reviewer must run the TUI manually enough to verify launch, prompt submission, streaming, abort, resume by `--session`, and clean terminal restoration on exit.

### PR 3: Port Theme, Footer, Sidebar, Dialog, And Toast Primitives

- Add `src/tui/theme/` with the `opencode` default theme copied/adapted from OpenCode.
- Implement theme resolution from `config.tui.theme`.
- Add fallback behavior for unknown themes.
- Add footer component matching OpenCode's root/status layout.
- Add sidebar component matching OpenCode's panel width and content hierarchy.
- Add dialog and toast primitives adapted from OpenCode's `/ui/dialog.tsx` and `/ui/toast.tsx`.
- Render permission and question prompts through modal/dialog primitives.
- Map existing MCP/team/diagnostic state into footer/sidebar rows.
- Update `docs/smoke.md` with theme, footer, sidebar, permission/question, and terminal restoration checks.

Verification:

- `bun test test/tui/theme.test.ts test/tui/app.test.tsx test/tui/state.test.ts`
- `bun run typecheck`
- `bun run format:check`
- `bun run smoke:tui`

Review:

A fresh read-only reviewer must compare screenshots or terminal observations against OpenCode's `packages/tui/src/routes/session/footer.tsx`, `sidebar.tsx`, `ui/dialog.tsx`, and `ui/toast.tsx`, while confirming oc2-specific config paths are used.

### PR 4: Port Keymap, Command Palette, And Slash Autocomplete

- Replace the raw-byte-only `src/tui/keymap.ts` behavior with an OpenTUI keymap integration or a compatibility wrapper around `@opentui/keymap`.
- Implement leader key behavior with default `ctrl+x` and a `2000ms` timeout.
- Implement command registry with palette metadata and reachable command filtering.
- Add command palette on `ctrl+p`.
- Implement `/` autocomplete above the prompt using `fuzzysort`.
- Dispatch known slash commands through `TuiClient.commands.execute(...)`.
- Reject unknown slash commands with a toast/error and do not submit them as model prompts.
- Implement key aliases: `enter -> return`, `esc -> escape`, `pgdown -> pagedown`, `pgup -> pageup`.
- Wire sidebar/status/theme/model/session command entries for functionality already backed by oc2.
- Reference `specs/03-slash-commands.md` for command semantics instead of duplicating that whole command list.

Verification:

- `bun test test/tui/keymap.test.ts test/tui/commands.test.ts test/tui/prompt.test.ts`
- `bun test test/tui/app.test.tsx`
- `bun run typecheck`
- `bun run smoke:tui`

Review:

A fresh read-only reviewer must verify reachable palette commands, slash aliases, unknown slash rejection, leader timeout behavior, and that normal prompts still submit unchanged.

### PR 5: Improve Prompt Editing, Autocomplete, And Session Controls

- Add multiline prompt editing with supported newline bindings.
- Add cursor movement, history navigation, and paste handling.
- Add `@` autocomplete for the first backed data source oc2 can provide cheaply, preferably workspace files.
- Add session list dialog using existing session persistence.
- Add new session action.
- Add model selector if oc2 has model/provider list data available through existing config/runtime services.
- Show model/provider/agent metadata under the prompt when known.
- Ensure active run cancellation and input clearing follow OpenCode-like semantics.

Verification:

- `bun test test/tui/prompt.test.ts test/tui/session-list.test.ts test/tui/app.test.tsx`
- `bun run typecheck`
- `bun run diagnostics`
- `bun run smoke:tui`

Review:

A fresh read-only reviewer must manually verify prompt editing, multiline submission, paste behavior, session switching, and that `--session` hydration still works.

### PR 6: Port Rich Session Transcript And Tool Rendering

- Split session rendering into maintainable components under `src/tui/routes/session/` or `src/tui/components/session/`.
- Add OpenCode-like inline tool rows for common oc2 tool events.
- Add block tool panels for shell/read/write/edit/apply_patch/task/question/skill/generic events when available in oc2 state.
- Add scroll behavior matching OpenCode's page/line/first/last controls.
- Preserve redaction rules for team/question/resource text.
- Add transcript tests for representative tool lifecycle events.
- Add narrow-terminal tests for sidebar/footer/prompt layout.

Verification:

- `bun test test/tui/session-render.test.ts test/tui/tool-render.test.ts test/tui/app.test.tsx`
- `bun test test/tui/state.test.ts`
- `bun run typecheck`
- `bun run smoke:tui`

Review:

A fresh read-only reviewer must inspect the component split and reject the PR if it introduces a monolithic OpenCode-sized session route or bypasses `TuiState` projection.

### PR 7: Documentation, Smoke Coverage, And Cleanup

- Update `docs/smoke.md` with the new OpenTUI manual smoke script and checks:
- launch
- prompt submit
- streaming
- abort
- sidebar toggle
- command palette
- slash autocomplete
- permission/question dialog
- MCP/team indicators
- session resume
- terminal restoration
- Remove obsolete raw string renderer tests if no exported API depends on them.
- If `renderTui()` remains exported from `src/index.ts`, document whether it is legacy/test-only or update it to a stable non-interactive rendering helper.
- Run full project checks and fix regressions.

Verification:

- `bun run check`
- `bun run diagnostics`
- `bun run smoke:tui`

Review:

A fresh read-only reviewer must verify docs match actual commands and that no stale references to the old plain-text `oc2 tui` UI remain.

## Future Work

- Add OpenCode-style plugin slots and built-in sidebar/home plugins.
- Add diff viewer, transcript export, share/unshare, fork, timeline, undo/redo, and compaction after oc2 exposes stable backing APIs.
- Add custom oc2 theme discovery from `.oc2/themes/*.json`.
- Add MCP resource autocomplete and richer `@` references.
- Add image/PDF/file attachment paste support.
- Add external editor integration.
- Add remote/server-backed TUI mode if oc2 later needs daemonized operation.
- Add session directory filtering controls similar to OpenCode's sync context.
- Add Windows-specific terminal input guards if oc2 officially supports Windows terminals.

## Open Questions

- Should oc2 keep exporting `renderTui()` from `src/index.ts` after the OpenTUI migration? Default recommendation: keep it only through PR 2 for compatibility/tests, then remove or mark it legacy in PR 7.
- Should slash command semantics be implemented from `specs/03-slash-commands.md` before or during PR 4? Default recommendation: implement only the registry/dispatch shell in PR 4 and keep deeper command behavior aligned with that existing spec.
- Should custom themes use `.oc2/themes` or config-directory-only discovery? Default recommendation: leave custom themes out of first pass and add `.oc2/themes` later if users ask for project-local themes.
