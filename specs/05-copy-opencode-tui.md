# Copy OpenCode TUI To oc2

## Goal

Replace the current raw terminal `oc2 tui` with an OpenTUI/Solid session UI that preserves oc2's in-process runtime and existing CLI entrypoints.

The implementation must introduce a narrow TUI adapter over oc2 services, then port the session shell in small reviewable slices: renderer foundation, prompt/run integration, theme/layout primitives, keymap/commands, prompt/session controls, transcript rendering, and smoke documentation.

## Current State

- `src/index.ts` exports `renderTui`, `launchTui`, `TuiLaunchOptions`, `src/tui/state`, and `src/tui/keymap`.
- `src/cli/index.ts` dispatches `oc2 tui` by loading config/paths and calling `launchTui()` with `config`, `cwd`, `dataDir`, `sessionId`, `model`, `roots`, `providers`, and slash command registry data.
- `src/cli/index.ts` also routes `resume --tui` into `launchTui()`.
- `src/cli/commands.ts` supports `tui --session`, `--model`, repeated `--root`, and `resume <session> --tui --model ... --root ...`.
- `src/tui/app.tsx` is a dependency-free raw terminal adapter. It clears with ANSI `\x1b[2J\x1b[H`, renders with `renderTui(state, input)`, and submits prompts through `SessionRunService.run({ prompt, sessionId, model, roots, signal })` plus model variant options when selected.
- `src/tui/app.tsx` already hydrates resumed sessions from persisted messages/tool calls, calls `service.command(...)` for recognized slash commands, supports question resolution hooks, slash suggestions, model picker, session switcher, and agent panel toggling.
- `src/tui/state.ts` projects runtime events into `TuiState`, including streaming, tools, permissions/questions, MCP, scheduler, subagents, teams, team tasks, mailbox, diagnostics, errors, model picker state, variant state, and slash suggestion state.
- `src/tui/state.ts` defines `TuiPanel = "session" | "team" | "mcp" | "agent"` and preserves redaction for team/task/mailbox/permission/question/resource text.
- `src/tui/keymap.ts` is still a raw-byte parser. It supports submit, cancel, side/team/MCP/agent panel toggles, escape, backspace, input, `Alt+Enter` newline, Tab completion, clear messages, session switcher, model picker, variant cycle, picker up/down, and noop. It does not provide a general command palette; `Ctrl+P` currently opens the model picker.
- Current string-rendered TUI components live under `src/tui/components/`, including `SessionView.tsx`, `MessageList.tsx`, `SidePanel.tsx`, `Footer.tsx`, `TeamPanel.tsx`, `McpPanel.tsx`, `PermissionDialog.tsx`, `QuestionPrompt.tsx`, `AgentStatus.tsx`, `ModelPicker.tsx`, `SlashSuggestions.tsx`, `ErrorBanner.tsx`, `PromptInput.tsx`, and `ToolCallView.tsx`.
- `src/session/run.ts` is the main runtime seam. It owns model/profile resolution, session create/resume/update, SQLite access, scheduler, MCP startup, tool execution, subagents, optional teams, and the main agent run. It exposes `sessions`, `database`, `run()`, `command()`, and `listModelOptions()`.
- `src/events/events.ts` defines runtime events for session, message, model, tool, permission, subagent, team, MCP, scheduler, diagnostic, and error updates.
- `src/config/schema.ts` has `tui: { sidePanel: boolean; theme?: string }`. Default config sets `tui.sidePanel: true`; there is no default `tui.theme` yet.
- Relevant tests include `test/tui/app.test.tsx`, `test/tui/state.test.ts`, `test/tui/keymap.test.ts`, `test/tui/model-picker.test.ts`, `test/cli/parser.test.ts`, and `test/cli/run.test.ts`.
- `docs/smoke.md` documents `bun run smoke:tui`, prompt entry, streamed assistant text, side panel toggling, `/` suggestions, `/rev` plus Tab completion, slash command submission, `/help`, and `Ctrl+C` exit.
- `package.json` defines `bun test`, `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run check`, `bun run diagnostics`, and `bun run smoke:tui`. `smoke:tui` runs `bun run start tui --model fake/test`.

## Reference Files

- OpenCode TUI source: `/Users/srpanwar/Documents/Workspace/brain/opencode/packages/tui/src`.
- OpenCode public TUI export: `/Users/srpanwar/Documents/Workspace/brain/opencode/packages/tui/src/index.tsx`.
- OpenCode app shell: `/Users/srpanwar/Documents/Workspace/brain/opencode/packages/tui/src/app.tsx`.
- OpenCode keymap and command references: `/Users/srpanwar/Documents/Workspace/brain/opencode/packages/tui/src/keymap.tsx`, `/config/keybind.ts`, and `/component/command-palette.tsx`.
- OpenCode session route references: `/routes/session/index.tsx`, `/routes/session/footer.tsx`, and `/routes/session/sidebar.tsx`.
- OpenCode prompt and autocomplete references: `/component/prompt/index.tsx` and `/component/prompt/autocomplete.tsx`.
- OpenCode theme references: `/theme/index.ts`, `/context/theme.tsx`, and `/theme/assets/*.json`; the default active theme is `opencode`.

## Non-Negotiables

- `oc2 tui` and `resume --tui` must continue launching through `src/cli/index.ts`.
- The first pass must keep oc2's runtime in-process. Do not port OpenCode's daemon service, server registration, worker/RPC bridge, SDK client, or SSE reconnect layer.
- TUI components must consume oc2 runtime data through a local adapter over `SessionRunService`, persisted sessions, and `RuntimeEventBus`; do not import OpenCode SDK types into oc2 TUI components.
- Preserve CLI behavior for `oc2 tui --session`, `--model`, repeated `--root`, and `resume <session> --tui`.
- Existing non-TUI `run` and `resume` behavior must not change.
- Redaction behavior in `src/tui/state.ts` must remain intact.
- Theme/config paths must use oc2 conventions. Do not read `.opencode` config, `.opencode/themes`, or global OpenCode config in the first pass.
- Pin OpenTUI/Solid dependencies to known working versions and record the OpenCode source version or commit used for reference.
- Split copied/adapted session UI into maintainable oc2 modules. Do not copy OpenCode's `routes/session/index.tsx` as one monolithic file.
- Every implementation slice must receive a fresh read-only adversarial review before merge.

## First Pass Scope

Must include:

- OpenTUI/Solid renderer launched by `launchTui()`.
- A local `TuiClient` adapter over oc2 services.
- Session transcript, prompt, streaming assistant text, tool rows, permissions/questions, diagnostics, footer, sidebar, command palette, slash autocomplete, and theme fallback.
- Session resume via `--session` and `resume --tui`.
- Model/session controls only where `src/session/run.ts` already exposes backing data.

Leave out of first pass:

- OpenCode daemon/server/SDK architecture.
- Plugin slots, marketplace/plugin manager, share URLs, timeline, fork, undo/redo, transcript export, diff viewer, external editor integration, file attachment paste, remote TUI operation, and MCP resource autocomplete.
- Custom theme discovery. Add `.oc2/themes/*.json` later only if needed.

## Adapter Boundary

Add `src/tui/client.ts` and `src/tui/client.local.ts`.

```ts
export interface TuiClient {
  sessions: {
    list(input?: { roots?: readonly string[] }): Promise<readonly TuiSessionSummary[]>
    hydrate(sessionId: string): Promise<TuiHydratedSession>
    prompt(input: {
      sessionId?: string
      prompt: string
      model?: string
      modelVariant?: string
      modelVariantOptions?: Record<string, unknown>
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
      model?: string
      modelVariant?: string
      modelVariantOptions?: Record<string, unknown>
      roots: readonly string[]
      signal?: AbortSignal
    }): Promise<TuiCommandResult>
  }
  status: {
    snapshot(): Promise<TuiStatusSnapshot>
  }
  events: {
    subscribe(listener: (event: RuntimeEvent) => void): () => void
  }
}

export interface TuiSessionSummary {
  id: string
  title?: string
  roots: readonly string[]
  updatedAt?: string
}

export interface TuiHydratedSession {
  session: TuiSessionSummary
  state: TuiState
}

export interface TuiCommandResult {
  ok: boolean
  message?: string
}

export interface TuiStatusSnapshot {
  model?: string
  roots: readonly string[]
  diagnostics: readonly string[]
}
```

Adapter rules:

- `sessions.prompt()` must call `SessionRunService.run()` and preserve selected model variant/options when present.
- `sessions.hydrate()` must reuse existing persisted message/tool-call hydration behavior from `src/tui/app.tsx` or move that logic behind the adapter.
- `commands.execute()` must call existing `SessionRunService.command()` for implemented slash commands and preserve session, model, variant, roots, and cancellation context.
- `events.subscribe()` must subscribe to `RuntimeEventBus` and keep `src/tui/state.ts` as the projection boundary.
- `abort(sessionId)` may use an in-memory `AbortController` registry in the TUI adapter until a runtime cancellation API exists.
- Hydration failure must show a diagnostic and open a new empty session instead of crashing the terminal.

## TUI Behavior

Renderer baseline:

- Use OpenTUI/Solid under `src/tui/` with `targetFps: 60`, `externalOutputMode: "passthrough"`, and `exitOnCtrlC: false` where supported by the selected OpenTUI version.
- If Kitty keyboard support is unavailable, continue with standard key input and show one diagnostic entry.
- Do not add mouse config in the first pass unless `tui.mouse` is explicitly added to `src/config/schema.ts` and documented.
- On renderer error or terminal restoration failure, restore cursor/screen state as far as possible and print one terminal-safe error line.

Visual baseline:

- Default `tui.theme` to `opencode`.
- Render themed background, panel, element, menu, border, muted text, warning, error, success, and info colors.
- Render a bordered prompt with a left rail, model/variant metadata when known, footer, sidebar, centered dialogs, and top-right toasts.
- Use sidebar width `42` columns unless terminal width requires hiding or reducing it.

Session baseline:

- Render user messages, streaming assistant text, completed assistant messages, tool lifecycle rows, permission prompts, question prompts, diagnostics/errors, and team/subagent summaries from `TuiState`.
- Render block tool output for shell/read/write/edit/apply_patch/task/question/skill/generic events only when `TuiState` contains displayable data.
- Preserve `tui.sidePanel` as the initial sidebar visibility.
- Fold agent/model/team/MCP details into the sidebar unless a separate panel has a clearer interaction model.

Footer/sidebar indicators:

- Footer root label must abbreviate the home directory as `~` and show `+N roots` for additional roots.
- Footer must show pending permission count, MCP server/resource count, team/subagent active count, and `/status` hint when data exists.
- Sidebar must show session id/title/root summary, active/completed tools, team/member status, MCP status/resources, diagnostics, current model, and current variant when known.

## Input, Keymap, And Commands

Key behavior:

- Default leader key: `ctrl+x` with `2000ms` timeout.
- Command palette: `ctrl+p` only when the prompt is focused; if a dialog/list is focused, `ctrl+p` means previous item and must not open the command palette.
- Exit: `ctrl+c`, `ctrl+d`, and `<leader>q`.
- Sidebar toggle: `<leader>b`.
- Status dialog: `<leader>s`.
- Theme list: `<leader>t`.
- Model list: `<leader>m` when `listModelOptions()` has data.
- Agent list: `<leader>a` only when oc2 has agent selection data.
- New session: `<leader>n`.
- Session list: `<leader>l`.
- Prompt submit: `return`.
- Prompt newline: `shift+return`, `ctrl+return`, `alt+return`, or `ctrl+j` when terminal input reports it.
- Clear input: `ctrl+c` when input is focused and no run is active; abort active run when a run is active.
- Dialog navigation: `up/down`, `ctrl+p/ctrl+n`, `return`, and `escape`.
- Session scroll: page up/down, line up/down, first/last.

Command shape:

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

- `/` autocomplete must list enabled commands from the command registry and include aliases.
- Known slash commands must dispatch through `TuiClient.commands.execute(...)`.
- Unknown slash commands must show an inline error/toast and must not submit as a model prompt.
- Command execution failure must show a toast plus diagnostic and must leave prompt text intact unless the command explicitly consumed it.
- Use `specs/03-slash-commands.md` as the command semantics reference; do not duplicate its full command list here.

Mention behavior:

- `@` autocomplete is future work unless the slice can use an existing cheap source without new indexing APIs.
- MCP resources and references are future work.

## Theme And Config

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

- Add the OpenCode `opencode` theme as a vendored oc2 asset.
- Validate theme JSON at load time.
- If `tui.theme` is missing, use `opencode`.
- If `tui.theme` is unknown or invalid, fall back to `opencode`, show a warning toast, and add a diagnostic entry.
- Do not search `.opencode/themes` or global OpenCode paths.

## Testing Strategy

- Keep `test/tui/state.test.ts` coverage for event projection, hydration, redaction, panels, MCP, permissions, diagnostics, model picker state, slash suggestion state, and agent/team tasks.
- Refactor `test/tui/app.test.tsx` so full-app assertions do not depend on raw string snapshots after the OpenTUI shell lands.
- Keep `test/tui/keymap.test.ts`, `test/tui/model-picker.test.ts`, `test/cli/parser.test.ts`, and `test/cli/run.test.ts` passing throughout.
- Add focused tests in the slice that introduces each feature: local client adapter, renderer shell, theme fallback, footer formatting, command registry, slash dispatch, prompt editing, session controls, transcript rendering, tool panels, and narrow terminal layout.
- Update `docs/smoke.md` in the slice that changes manual behavior.

## Implementation Slices

### PR 1: Add TUI Adapter Boundary

- Add `src/tui/client.ts` with `TuiClient` and minimal data shapes from this spec.
- Add `src/tui/client.local.ts` that adapts `SessionRunService.run()`, `SessionRunService.command()`, session persistence, model options, and `RuntimeEventBus`.
- Move existing hydration logic out of `src/tui/app.tsx` only as needed to support the adapter.
- Implement adapter-level abort with an in-memory controller registry if no runtime cancellation seam exists.
- Add `test/tui/client.test.ts` for prompt submission, command dispatch, abort, hydration failure fallback, and session listing.
- Keep visible `launchTui()` behavior unchanged.

Verification:

- `bun test test/tui/client.test.ts test/tui/state.test.ts`
- `bun test test/cli/parser.test.ts test/cli/run.test.ts`
- `bun run typecheck`
- `bun run lint`

Review:

- Fresh read-only reviewer must reject the PR if it imports OpenCode SDK/client/server types, reads `.opencode` paths, bypasses `TuiState`, changes non-TUI `run`/`resume`, or replaces the visible TUI before the renderer slice.

### PR 2: Add OpenTUI/Solid Renderer Shell

- Add only renderer-shell dependencies to `package.json` and lockfile: `@opentui/core`, `@opentui/solid`, `@opentui/keymap`, and `solid-js`, pinned to known working versions.
- Record the OpenCode source version or commit used to choose dependency versions.
- Replace or wrap `src/tui/app.tsx` so `launchTui()` starts an OpenTUI/Solid shell.
- Preserve exported `launchTui` and `TuiLaunchOptions`.
- Render static shell regions: transcript viewport, prompt container, footer placeholder, and sidebar placeholder.
- Wire clean exit and terminal restoration for `Ctrl+C`/`Ctrl+D`; prompt submission may remain disabled in this PR.

Verification:

- `bun test test/tui/app.test.tsx test/tui/state.test.ts`
- `bun test test/cli/run.test.ts`
- `bun run typecheck`
- `bun run smoke:tui`

Review:

- Fresh read-only reviewer must manually launch `bun run smoke:tui` and record observations for launch, exit, and terminal restoration.
- Reject if the PR introduces OpenCode daemon/server/SDK dependencies or a monolithic copied session route.

### PR 3: Wire Prompt, Events, And Resume

- Connect the renderer shell to `TuiClient.events.subscribe(...)` and `projectTuiEvent()`.
- Render basic user/assistant transcript rows from `TuiState`.
- Submit normal prompts through `TuiClient.sessions.prompt(...)`.
- Preserve `oc2 tui --session`, `--model`, repeated `--root`, and `resume --tui`.
- Preserve active-run cancellation semantics.
- Show hydration failures as diagnostics and open a new empty session.

Verification:

- `bun test test/tui/app.test.tsx test/tui/client.test.ts test/tui/state.test.ts`
- `bun test test/cli/parser.test.ts test/cli/run.test.ts`
- `bun run typecheck`
- `bun run smoke:tui`

Review:

- Fresh read-only reviewer must manually verify prompt submission, streaming, abort, `--session` resume, `resume --tui`, and terminal restoration.
- Reject if renderer code polls runtime internals directly instead of using the adapter/events boundary.

### PR 4: Add Theme Resolution And Visual Primitives

- Add `src/tui/theme/` with the vendored `opencode` theme asset.
- Add theme validation and fallback for missing/unknown/invalid `tui.theme`.
- Add reusable footer, sidebar frame, dialog, and toast primitives.
- Add tests for theme fallback, root label formatting, sidebar initial visibility from `tui.sidePanel`, and toast/diagnostic behavior for theme errors.

Verification:

- `bun test test/tui/theme.test.ts test/tui/app.test.tsx test/tui/state.test.ts`
- `bun run typecheck`
- `bun run format:check`

Review:

- Fresh read-only reviewer must compare terminal observations against OpenCode footer/sidebar/dialog/toast references and confirm only oc2 config paths are used.
- Reject if `.opencode` or global OpenCode theme discovery is added.

### PR 5: Render Footer, Sidebar, Permissions, And Questions

- Populate footer indicators from `TuiState`: roots, pending permissions, MCP status count, team/subagent active count, and `/status` hint.
- Populate sidebar rows for session summary, tools, team/member status, MCP status/resources, diagnostics, model, and variant.
- Render permission and question prompts through dialog primitives.
- Add focused tests for permission/question dialog state transitions and sidebar/footer data mapping.
- Update `docs/smoke.md` with footer, sidebar, permission/question, and terminal restoration checks.

Verification:

- `bun test test/tui/app.test.tsx test/tui/state.test.ts`
- `bun run typecheck`
- `bun run smoke:tui`

Review:

- Fresh read-only reviewer must manually verify sidebar toggle, footer counts, permission/question dialogs, and that redacted fields are not displayed raw.
- Reject if the slice weakens redaction behavior in `src/tui/state.ts`.

### PR 6: Add Command Palette And Keymap Wrapper

- Integrate `@opentui/keymap` or add a compatibility wrapper around it.
- Implement leader key behavior with default `ctrl+x` and `2000ms` timeout.
- Add command registry with palette metadata and enabled filtering.
- Add command palette on `ctrl+p` for prompt focus only; dialog/list focus must keep `ctrl+p` as previous-item navigation.
- Implement key aliases: `enter -> return`, `esc -> escape`, `pgdown -> pagedown`, `pgup -> pageup`.
- Wire sidebar/status/theme/model/session command entries where oc2 has backing behavior.

Verification:

- `bun test test/tui/keymap.test.ts test/tui/commands.test.ts test/tui/app.test.tsx`
- `bun run typecheck`
- `bun run smoke:tui`

Review:

- Fresh read-only reviewer must verify leader timeout, command enablement, `ctrl+p` prompt-vs-dialog precedence, and that existing submit/cancel/sidebar/model/session shortcuts still work.
- Reject if normal prompt submission behavior regresses.

### PR 7: Add Slash Autocomplete And Dispatch

- Add `fuzzysort` only in this PR unless an earlier slice needs it.
- Implement `/` autocomplete above the prompt using command registry names and aliases.
- Dispatch known slash commands through `TuiClient.commands.execute(...)`.
- Reject unknown slash commands with a toast/error and keep them out of normal model prompt submission.
- Reference `specs/03-slash-commands.md` for command semantics.

Verification:

- `bun test test/tui/commands.test.ts test/tui/prompt.test.ts test/tui/app.test.tsx`
- `bun run typecheck`
- `bun run smoke:tui`

Review:

- Fresh read-only reviewer must verify reachable palette commands, slash aliases, unknown slash rejection, command failure diagnostics, and unchanged normal prompt submission.

### PR 8: Improve Prompt Editing

- Add multiline prompt editing with supported newline bindings.
- Add cursor movement, history navigation, Unicode-safe input handling, and paste handling.
- Ensure active-run cancellation and input clearing follow this spec's key behavior.
- Add tests for newline bindings, cursor movement, paste, history, cancellation, and clear-input behavior.

Verification:

- `bun test test/tui/prompt.test.ts test/tui/keymap.test.ts test/tui/app.test.tsx`
- `bun run typecheck`
- `bun run diagnostics`
- `bun run smoke:tui`

Review:

- Fresh read-only reviewer must manually verify prompt editing, multiline submission, paste behavior, active-run abort, and idle input clearing.

### PR 9: Add Session And Model Controls

- Add session list dialog using existing session persistence.
- Add new session action.
- Add model selector using `SessionRunService.listModelOptions()`.
- Show model/provider/variant metadata under the prompt when known.
- Disable agent selector until oc2 exposes backed agent selection data.

Verification:

- `bun test test/tui/session-list.test.ts test/tui/model-picker.test.ts test/tui/app.test.tsx`
- `bun run typecheck`
- `bun run smoke:tui`

Review:

- Fresh read-only reviewer must manually verify session switching, new session, model selection, variant display, and `--session` hydration.
- Reject if selectors show stale or unbacked options.

### PR 10: Render Rich Transcript And Tool Panels

- Split session rendering into maintainable components under `src/tui/routes/session/` or `src/tui/components/session/`.
- Add inline tool rows for common oc2 tool events.
- Add block panels for shell/read/write/edit/apply_patch/task/question/skill/generic events when `TuiState` contains displayable data.
- Preserve redaction rules for team/question/resource text.
- Add transcript and tool rendering tests for representative events.

Verification:

- `bun test test/tui/session-render.test.ts test/tui/tool-render.test.ts test/tui/app.test.tsx`
- `bun test test/tui/state.test.ts`
- `bun run typecheck`
- `bun run smoke:tui`

Review:

- Fresh read-only reviewer must inspect component split and reject the PR if it introduces a monolithic OpenCode-sized route or bypasses `TuiState` projection.

### PR 11: Add Scroll And Narrow-Terminal Hardening

- Add page/line/first/last scroll behavior.
- Add narrow-terminal layout rules for prompt, footer, sidebar hide/reduce behavior, and dialogs.
- Add tests for narrow terminal layout and scroll key behavior.
- Ensure terminal restoration failure still produces one terminal-safe error line.

Verification:

- `bun test test/tui/session-render.test.ts test/tui/keymap.test.ts test/tui/app.test.tsx`
- `bun run typecheck`
- `bun run smoke:tui`

Review:

- Fresh read-only reviewer must manually verify scrolling, narrow terminal behavior, dialog usability, and clean exit.

### PR 12: Documentation, Full Checks, And Legacy Cleanup

- Update `docs/smoke.md` with final manual checks: launch, prompt submit, streaming, abort, sidebar toggle, command palette, slash autocomplete, permission/question dialog, MCP/team indicators, session resume, model selection, and terminal restoration.
- Remove obsolete raw string renderer tests if no exported API depends on them.
- If `renderTui()` remains exported from `src/index.ts`, document whether it is legacy/test-only or update it to a stable non-interactive rendering helper.
- Run full project checks and fix regressions.

Verification:

- `bun run check`
- `bun run diagnostics`
- `bun run smoke:tui`

Review:

- Fresh read-only reviewer must verify docs match actual commands and no stale references to the old plain-text TUI remain.
- Reject if `renderTui()` export status is ambiguous.

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

- Which OpenCode commit should be used to pin OpenTUI/Solid dependency versions? Default recommendation: use the currently checked-out OpenCode workspace and record its commit in PR 2.
- Should `abort(sessionId)` remain an adapter-level `AbortController` registry or become a runtime API? Default recommendation: use the adapter registry first and promote it only if non-TUI callers need cancellation.
- Should mouse support require a new `tui.mouse` config key? Default recommendation: leave mouse out of first pass unless OpenTUI enables it without new config or user-visible risk.
- Should oc2 keep exporting `renderTui()` from `src/index.ts` after the OpenTUI migration? Default recommendation: keep it only through PR 3 for compatibility/tests, then remove or mark it legacy in PR 12.
- Should slash command semantics be implemented from `specs/03-slash-commands.md` before or during PR 7? Default recommendation: implement only the registry/dispatch shell in PR 7 and keep deeper command behavior aligned with that existing spec.
