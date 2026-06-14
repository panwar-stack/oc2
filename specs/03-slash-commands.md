# Slash Command System & Unwired Feature Wiring

## Goal

Add a slash command system to the oc2 TUI that mirrors opencode's prompt-based command dispatch (`/review`, `/clarify`, `/help`, etc.), wire up the 5 existing skill markdown files in `src/skills/` that have no loader tool, and expose existing-but-unwired features (session listing, memory logs, agent panel toggle, missing CLI commands, keyboard shortcuts).

The slash system has two dispatch paths:

1. **TUI-local commands** — keyboard shortcuts and UI state changes handled entirely client-side (exit, clear, help, panel toggles)
2. **Backend commands** — named prompt templates that expand via `$ARGUMENTS` substitution and inject into the AI model loop (review, clarify, spec-planner, spec-implement, team-report, init)

## Current State

- `src/tui/app.tsx:91-123` — submit handler checks for question prompt vs normal prompt; no slash prefix detection
- `src/tui/keymap.ts:1-37` — keymap supports `cancel`, `submit`, `toggle-side-panel`, `toggle-team-panel`, `toggle-mcp-panel`, `escape`, `backspace`, `input`; no slash command types
- `src/tui/components/PromptInput.tsx:1-3` — renders raw `"Prompt> " + value` with no input preprocessing or autocomplete
- `src/tui/state.ts:27` — `TuiPanel` includes `"agent"` but `toggleAgentPanel()` (line 396) has no keyboard shortcut (`Ctrl+A`)
- `src/skills/` — 5 markdown files exist (`clarify.md`, `initialize.md`, `spec-implement.md`, `spec-planner.md`, `team-report.md`) with no loader tool; the spec (`01-oc2-spec.md:520-521`) proposed a `skill` built-in tool that was never created
- `src/cli/commands.ts:7` — `CommandName` has 11 entries; no `sessions` or `memory` commands
- `src/cli/index.ts:70-101` — `executeCommand()` switch has no `sessions` or `memory` case
- `src/session/session-service.ts:52` — `listSessions()` exists but has no CLI exposure
- `src/persistence/repositories/memory.ts:233` — `listRetrievalLogs()` exists but has no CLI or tool exposure
- `02-implementation-plan.md:186-205` — spec-defined CLI commands `oc2 tools enable/disable`, `oc2 run --team`, `oc2 resume --tui`, timeouts, concurrency flags are in the spec but not implemented
- `02-implementation-plan.md:1041-1044` — spec-defined shortcuts `Ctrl+L` (clear), `Ctrl+R` (resume session), `Alt+Enter` (newline) are not implemented
- OpenCode reference: `/Users/srpanwar/Documents/Workspace/brain/opencode/packages/tui/src/keymap.tsx:260-289` defines `useCommandSlashes()`; prompt autocomplete at `packages/tui/src/component/prompt/autocomplete.tsx` handles `/` prefix detection and fuzzy matching; `packages/tui/src/component/prompt/index.tsx:1124-1144` dispatches backend commands via `session.command()`

## Non-Negotiables

- Do not introduce a monorepo or web/desktop/server dependency
- The command registry must be in-memory with no separate persistence; commands are loaded from builtins, skills on disk, user config, and MCP at session start
- Slash command autocomplete must show both TUI-local commands and backend commands in the same overlay; do not create separate menus
- Template substitution must use `$ARGUMENTS` as the sole placeholder for user-provided arguments; do not introduce positional `$1`, `$2` in the first pass
- The `skill` built-in tool must be a standard tool registered in the tool registry, not special-cased in the agent loop
- User-defined commands loaded from config must use the same `SlashCommand` shape as builtins; do not create two parallel command types
- Slash command names and tool names occupy separate namespaces (commands are user-facing `/` prefix, tools are AI-model-invoked); no collision risk by design
- Keep the TUI autocomplete implementation minimal — a plain text overlay rendered below the prompt line, not a complex popup. Use exact prefix matching for the first pass, not fuzzy matching
- Existing `02-implementation-plan.md` PR slices (PR 9 TUI, PR 13 Team Reporting, PR 15 Skills) are pre-requisites for some features; this spec may nest inside or extend those slices where noted

## Data Model

### SlashCommand

```ts
// src/commands/types.ts
export interface SlashCommand {
  readonly name: string
  readonly description: string
  readonly aliases?: readonly string[]
  /** "tui" = client-side action | "builtin" = system command | "user" = config-defined | "skill" = from skill/*.md | "mcp" = from MCP prompts */
  readonly source: "tui" | "builtin" | "user" | "skill" | "mcp"
  /** Prompt template. `$ARGUMENTS` is replaced with user-provided text after the command name. Undefined for TUI-local commands. */
  readonly template?: string
  /** If true, wrap the expanded prompt in a subtask */
  readonly subtask?: boolean
  /** Agent profile name override */
  readonly agent?: string
  /** Model override (providerID/modelID) */
  readonly model?: string
  /** Only for TUI-local commands: synchronous handler */
  readonly onExecute?: () => void
}
```

### CommandRegistry

```ts
// src/commands/registry.ts
export interface CommandRegistry {
  /** Register a command. Later registrations for the same name overwrite. */
  register(command: SlashCommand): void
  /** Get a single command by name or alias. */
  get(name: string): SlashCommand | undefined
  /** List all registered commands. */
  list(): readonly SlashCommand[]
  /** List commands that only match by prefix (for autocomplete). */
  search(prefix: string): readonly SlashCommand[]
}
```

### TuiState Extensions (flat fields, no sub-interface)

```ts
// New field in TuiState (src/tui/state.ts) — flat fields, consistent with existing pattern at state.ts:108-126
readonly slashActive: boolean        // Whether the slash autocomplete overlay is visible
readonly slashQuery: string          // Everything after / up to cursor (e.g., "rev" for "/rev")
readonly slashMatches: readonly SlashMatch[]  // Commands matching slashQuery
readonly showSessionList: boolean    // Whether session switcher view is visible
```

```ts
export interface SlashMatch {
  readonly name: string // e.g., "review"
  readonly display: string // e.g., "/review"
  readonly description: string
  readonly source: "tui" | "builtin" | "user" | "skill" | "mcp"
}
```

`createInitialTuiState()` defaults: `slashActive: false`, `slashQuery: ""`, `slashMatches: []`, `showSessionList: false`.

## TUI Behavior

### Input Flow

1. `stdin.on("data")` receives a chunk (may contain multiple characters on paste). Split chunk into individual characters and process each sequentially through `parseTuiKey()`.
2. `parseTuiKey()` returns `"input"` action → `app.tsx` appends character to `input` string.
3. **After** input mutation: if `input` starts with `/` and contains no whitespace, set `slashActive: true`, set `slashQuery` to input slice after `/`, compute `slashMatches = registry.search(slashQuery)`.
4. If `input` no longer starts with `/` (user backspaced past the prefix), set `slashActive: false`, `slashQuery: ""`, `slashMatches: []`.
5. When `slashActive` is true, the renderer shows slash suggestions below the prompt line. Cap at 5 suggestions to avoid terminal overflow.
6. User presses Enter with `/` prefix text:
   - If the first word matches a TUI-local command → execute `onExecute()` handler, clear input
   - If the first word matches a backend command → call `service.command({ name, arguments, sessionId })`, clear input
   - If no match → treat as normal prompt (pass to AI model as-is)
7. User presses **Escape**: if slash is active, clear slash state first; otherwise fall through to existing escape handler (question answer, panel close). Slash-active escape takes priority.
8. User presses **Tab** while `slashActive`: complete to first match if any; do NOT cycle on repeated Tab.
9. When `slashQuery` is empty (input is exactly `/`), show all commands (for discovery), capped at 5.

**Known limitation:** Multi-byte UTF-8 input is not supported in this pass (`keymap.ts:35` matches only `[\x20-\x7e]`). Slash command names use ASCII only.
**Known limitation:** Paste containing `\r` or `\n` may trigger premature submit because the `\r`/`\n` byte is consumed as a submit action. This is a pre-existing limitation of the single-character-per-chunk design. Paste after typing `/` to activate slash mode; do not paste text containing `/` as the first character of a new line unless the intent is to use a slash command.

### Autocomplete Rendering

When `slashActive` is true, the `SlashSuggestions` component renders below `PromptInput` in `SessionView`. The component is a plain-text function:

```ts
// src/tui/components/SlashSuggestions.tsx
export function SlashSuggestions({
  matches,
  width,
  active,
}: {
  readonly matches: readonly SlashMatch[]
  readonly width?: number
  readonly active: boolean
}): string
```

Rendering behavior:

- Only unique commands by name (deduplicate across sources).
- Cap display at 5 matches. Show `/... and N more` if truncated.
- Truncate descriptions to fit within terminal `width` (default 80).
- Show `[ESC to cancel]` footer line.
- When `active` is false, return empty string.
- Slash suggestions **replace** the side panel area when visible (mutually exclusive with side panel). When `slashActive` is true, `SessionView` renders `SlashSuggestions` instead of `SidePanel`.

Example output:

```
Prompt> /rev
  /review  review changes [builtin]
  [ESC to cancel]
```

When `slashQuery` is empty (input is `/`), show all commands:

```
Prompt> /
  /review   review changes [builtin]
  /clarify  clarify underspecified requests [builtin]
  /help     show keybindings [tui]
  ... and 3 more
  [ESC to cancel]
```

### Keyboard Shortcuts (New & Updated)

| Key         | Action                  | Implementation                                                                      |
| ----------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `Ctrl+L`    | Clear visible messages  | Add `clear-messages` action to keymap; new `clearMessages()` state reducer          |
| `Ctrl+R`    | Show session switcher   | Add `session-switcher` action; TUI state flag `showSessionList`                     |
| `Ctrl+A`    | Toggle agent panel      | Wire existing `toggleAgentPanel()` to `Ctrl+A` (`\u0001`)                           |
| `Alt+Enter` | Insert newline in input | Detect escape prefix `\e` + `\r`/`\n` in `parseTuiKey()`, return `"newline"` action |
| `Tab`       | Complete slash command  | When `slashActive`, complete to first match; add `tab` action type                  |

**Technical note on Alt+Enter:** In raw terminal mode, plain Enter sends `\r` (0x0D). Most terminals do NOT distinguish Shift+Enter from Enter at the byte level. Alt+Enter reliably sends `\e\r` or `\e\n` (escape prefix), which is detectable in the existing character-by-character parser. Do not attempt Shift+Enter detection.

## Command Registry & Resolution

### Builtin Commands

Loaded at registry creation time. Each maps to a skill file reference or an inline template:

| Command          | Template Source                                 | Template Content                                                                                                                   | Subtask |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `review`         | Inline                                          | `"Review the following code changes for correctness, security, and style issues. Focus on the diff provided below.\n\n$ARGUMENTS"` | `true`  |
| `clarify`        | `skill:clarify` (loads `src/skills/clarify.md`) | Skill file content at resolve time                                                                                                 | `false` |
| `spec-planner`   | `skill:spec-planner`                            | Skill file content at resolve time                                                                                                 | `false` |
| `spec-implement` | `skill:spec-implement`                          | Skill file content at resolve time                                                                                                 | `false` |
| `team-report`    | `skill:team-report`                             | Skill file content at resolve time                                                                                                 | `false` |
| `init`           | `skill:initialize`                              | Skill file content at resolve time                                                                                                 | `false` |

### Skill File Loading

Create `src/tools/builtins/skill.ts` as a standard tool following the existing `read` tool pattern (`src/tools/builtins/read.ts`):

```ts
// Tool: "skill"
// Input schema: { name: z.string() } — skill name without .md extension
// Behavior: Resolve `${SKILLS_DIR}/${name}.md`, verify path stays within SKILLS_DIR,
//           read via Bun.file().text(), return { content: string }
// Permissions: Always allow (read-only, path-bounded to skills dir)
// SKILLS_DIR = new URL("../../skills", import.meta.url).pathname
```

Path validation: After resolving `${SKILLS_DIR}/${name}.md`, use `path.resolve()` and verify the result starts with the resolved `SKILLS_DIR` prefix. Reject names containing `..` or `/` to prevent directory traversal.

### Template Resolution

When a backend slash command is executed, the resolution pipeline is:

1. Look up command by name in `CommandRegistry.get(name)`
2. Determine template source:
   - If `template` starts with `skill:` prefix (e.g., `"skill:clarify"`), extract skill name, call the skill tool internally to load `src/skills/<name>.md` content, use that as the resolved template
   - If `template` is a plain string (e.g., the `review` command's inline template), use it directly
3. Substitute `$ARGUMENTS` in the resolved template with the user-provided text after the command name. If args are empty, `$ARGUMENTS` becomes `""`.
4. If `subtask` is true, prefix the prompt with a subtask marker — for the first pass this is a prompt-level convention (e.g., `"[SUBTASK] "` prefix); the MainAgent already supports subagent tool calls and does not need structural changes.
5. Submit the fully resolved prompt to `MainAgent.run()`

### User-Defined Commands (PR 5)

Loaded from `{commands,command}/*.md` in project and user config directories. Markdown files use YAML frontmatter:

```markdown
---
description: "Review staged changes for security issues"
aliases: ["security-review"]
agent: "security-agent"
subtask: true
---

Review the following changes for security vulnerabilities: $ARGUMENTS
```

Frontmatter parsing: split file on `---` delimiter, parse the block between the first two `---` lines as key-value pairs. No external YAML library needed — use a simple manual parser (split on `: `, trim whitespace, handle quoted values). This avoids adding a YAML dependency.

User commands registered via `register()` override builtins with the same name. File load order: project config dirs first, user config dir second, so user-level commands take precedence over project-level, and both override builtins.

Leave config-inline command definitions and MCP prompt commands to future work. Builtins + skills + markdown-file commands cover the critical path.

## Missing Feature Wiring

### CLI Commands

| New/Old | Command                                 | Uses                                                                                                                                 | File                                        |
| ------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| New     | `oc2 sessions list`                     | `SessionService.listSessions()`                                                                                                      | `src/cli/commands.ts`, `src/cli/index.ts`   |
| Missing | `oc2 tools enable <name>`               | Config set via `setJsoncPath()`, path `tools.<name>.enabled`                                                                         | `src/cli/commands.ts`, `src/cli/index.ts`   |
| Missing | `oc2 tools disable <name>`              | Config set via `setJsoncPath()`, path `tools.<name>.enabled`                                                                         | `src/cli/commands.ts`, `src/cli/index.ts`   |
| New     | `oc2 memory list [--repository <path>]` | `RepositoryMemoryRepository.listRetrievalLogs(cwd)`                                                                                  | `src/cli/commands.ts`, `src/cli/index.ts`   |
| Missing | `oc2 run ... --team`                    | Pass team flag through to `SessionRunService`                                                                                        | `src/cli/commands.ts`, `src/session/run.ts` |
| Missing | `oc2 run ... --timeout <ms>`            | Pass to `RunPromptInput.timeoutMs`                                                                                                   | `src/cli/commands.ts`, `src/session/run.ts` |
| Missing | `oc2 run ... --max-concurrency <n>`     | Pass to `RunPromptInput.maxConcurrency`                                                                                              | `src/cli/commands.ts`, `src/session/run.ts` |
| Missing | `oc2 resume <id> --tui`                 | Launch TUI for existing session without `--run`                                                                                      | `src/cli/commands.ts`, `src/cli/index.ts`   |
| —       | `oc2 run ... --provider <id>`           | **Removed** — redundant with `--model <provider/model>` which already encodes provider; `parseModel()` at `run.ts:221` splits on `/` | —                                           |
| —       | `oc2 run ... --no-tui`                  | **Removed** — CLI is already non-interactive; no `run` code path invokes TUI                                                         | —                                           |

### CLI Command Parsing Changes

In `src/cli/commands.ts`:

- Add `"sessions" | "memory"` to `CommandName` union
- Add `ParsedCommand` discriminated variants:
  ```ts
  | { name: "sessions"; action: "list"; json: boolean }
  | { name: "memory"; action: "list"; repository?: string; json: boolean }
  ```
- Add `commandDescriptions` entries: `sessions: "List sessions from local database"`, `memory: "List repository memory retrieval logs"`
- Extend `parseTools()` to handle `enable`/`disable` subcommands (mirroring `parseMcp()` pattern at `commands.ts:110-126`)
- Extend `parseRun()` to parse `--team` (boolean), `--timeout <ms>` (value), `--max-concurrency <n>` (value) flags in `parseFlagValues()`
- Extend `parseResume()` to support two variants:
  ```ts
  // Existing: resume with prompt
  | { name: "resume"; sessionId: string; run: string; json: boolean; model?: string }
  // New: resume into TUI (no --run required)
  | { name: "resume"; sessionId: string; tui: true; json: boolean; model?: string }
  ```
  When `--tui` is set, do NOT require `--run`.

In `src/cli/index.ts`:

- Add `executeCommand()` cases for `sessions`, `memory`
- Wire `tools enable/disable` to the existing `setJsoncPath()` logic, using path `tools.<name>.enabled` (analogous to `mcp enable/disable` at `cli/index.ts:167-188`)
- For `resume --tui`: call the TUI launcher with `sessionId` (similar to `tui` case at `cli/index.ts:190-204`), not `runPrompt()`
- Pass new flags from `run` command through to `runPrompt()` and then to `service.run()`

In `src/session/run.ts`:

- Extend `RunPromptInput` with new optional fields:
  ```ts
  export interface RunPromptInput {
    readonly prompt: string
    readonly sessionId?: string
    readonly model?: string
    readonly enabledTools?: readonly string[]
    readonly disabledTools?: readonly string[]
    readonly enabledMcp?: readonly string[]
    readonly disabledMcp?: readonly string[]
    readonly roots?: readonly string[]
    readonly signal?: AbortSignal
    // NEW:
    readonly team?: boolean // When true, include team tools in run
    readonly timeoutMs?: number // Override config.runtime.defaultTimeoutMs
    readonly maxConcurrency?: number // Override scheduler concurrency limits
  }
  ```
- In `SessionRunService.run()`: if `input.team` is true, ensure team tools are registered (they are already always registered at `run.ts:172-174`, so this flag controls whether team-related system instructions are included in the agent prompt)

### CLI Output Formatting

In `src/cli/output.ts`:

- Add `formatSessionsListText()` — tabular session listing (id, title, status, created)
- Add `formatMemoryListText()` — list retrieval log entries

### TUI State Changes

In `src/tui/state.ts`:

- Add fields to `TuiState` (flat fields, no sub-interface): `slashActive: boolean`, `slashQuery: string`, `slashMatches: readonly SlashMatch[]`, `showSessionList: boolean`
- Add `setSlashState(state, partial): TuiState` — updates slashActive, slashQuery, slashMatches in one call
- Add `toggleSessionList(state): TuiState` — toggles `showSessionList`
- Add `clearMessages(state): TuiState` — resets `messages: []`, `streamingText: ""`, `errors: []` (clears all visible content but does not destroy the session)
- Wire `toggleAgentPanel()` to `Ctrl+A` — already exists at `state.ts:396`, just needs keymap binding
- Add `"slash-input" | "newline" | "tab" | "clear-messages" | "session-switcher"` to `TuiKeyAction` union
- Add `Ctrl+L` (`\u000c`), `Ctrl+R` (`\u0012`), `Ctrl+A` (`\u0001`), `Tab` (`\t`) to `TUI_KEYMAP` and `parseTuiKey()`
- Add `Alt+Enter` detection: track prior `\e` (escape) byte; if previous byte was `\e` and current is `\r` or `\n`, return `"newline"` action. Requires a single-character lookbehind buffer in the stdin handler.
- `projectTuiEvent` does NOT need changes — slash state is TUI-local and does not derive from runtime events

### TUI App Changes

In `src/tui/app.tsx`:

- Split multi-character chunks: the `stdin.on("data")` handler at `app.tsx:138` must iterate over each character in the chunk and call `parseTuiKey()` per-character. This handles paste events that deliver multiple bytes in one event.
- Track a single-character lookbehind buffer for `Alt+Enter` detection: if previous byte was `\e` and current is `\r` or `\n`, emit `"newline"`.
- After `key.action === "input"`, compute slash state (steps 3-4 from Input Flow above). Use an `else if` chain for mutual exclusivity between action types to prevent accidental double-processing.
- On `key.action === "submit"`: first check for slash command dispatch (TUI-local vs backend vs no-match fallthrough), then check existing questionPrompt/empty-input behavior.
- Handle `"newline"` — append `"\n"` to input
- Handle `"tab"` — if `slashActive` and `slashMatches.length > 0`, replace input with the first match's display name plus a trailing space, then clear slash state
- Handle `"clear-messages"` — `state = clearMessages(state)`
- Handle `"session-switcher"` — `state = toggleSessionList(state)`
- Handle `"escape"` — check `slashActive` first; if true, clear slash state and input. Otherwise fall through to existing escape handler.
- Pass slash state fields to `SessionView` for rendering

### TUI Rendering Changes

In `src/tui/components/SlashSuggestions.tsx` (new component):

- Function signature: `SlashSuggestions({ matches, width, active }): string`
- Returns empty string when `active` is false
- Renders deduplicated matches as `"  /<name>  <description>"` lines, capped at 5
- Shows `"[ESC to cancel]"` footer
- Descriptions truncated to fit `width - 4` (accounting for `"  "` prefix)

In `src/tui/components/SessionView.tsx`:

- Accept `slashState: { active, matches }` and pass to rendering
- When `slashActive` is true, render `SlashSuggestions` **instead of** `SidePanel` (mutual exclusion)
- Pass `width` from options to SlashSuggestions

In `src/tui/components/PromptInput.tsx`:

- No changes needed; slash suggestions are rendered as a separate component below

## Implementation Slices

### PR 1: Command Registry & Skill Tool

**Pre-requisite:** PR 7 (Tool Registry) from `02-implementation-plan.md`

- Create `src/commands/types.ts` with `SlashCommand` and `CommandRegistry` interfaces
- Create `src/commands/registry.ts` with `createCommandRegistry()` — in-memory Map-based registry with name + alias lookup
- Create `src/tools/builtins/skill.ts` with `createSkillTool()` — reads `src/skills/<name>.md` via `Bun.file()`, returns content
- Register `skill` tool in `src/tools/builtins/index.ts` `createBuiltInTools()`
- Create `src/commands/builtins.ts` with `createBuiltinCommands()` — registers `/review`, `/clarify`, `/spec-planner`, `/spec-implement`, `/team-report`, `/init` with templates referencing skill files
- Create `src/commands/resolver.ts` with `resolveCommandTemplate(command, args)` — loads skill file if template is a `skill:` reference, substitutes `$ARGUMENTS`
- Add tests: `test/commands/registry.test.ts`, `test/commands/builtins.test.ts`, `test/tools/skill.test.ts`

Verification:

- `bun test test/commands test/tools/skill.test.ts`
- `bun run typecheck`
- `bun run lint`

Review:

Reviewer must verify: (a) skill tool reads from `src/skills/` and is bounded to that directory, (b) command registry deduplicates by name and supports alias lookup, (c) template resolution handles `$ARGUMENTS` substitution and empty args gracefully.

### PR 2: TUI Slash Input, Autocomplete & Shortcuts

**Pre-requisite:** PR 9 (Minimal TUI) from `02-implementation-plan.md`

- Extend `src/tui/keymap.ts`:
  - Add `"slash-input" | "newline" | "tab" | "clear-messages" | "session-switcher"` to `TuiKeyAction`
  - Add `Ctrl+L` (`\u000c`), `Ctrl+R` (`\u0012`), `Ctrl+A` (`\u0001`), `Tab` (`\t`) to `TUI_KEYMAP` and `parseTuiKey()`
  - Add `Alt+Enter` detection: `\e` followed by `\r`/`\n` → `"newline"` (requires single-char lookbehind buffer in app.tsx)
  - Note: do NOT attempt Shift+Enter detection — not reliably distinguishable from Enter in raw terminal mode
- Extend `src/tui/state.ts`:
  - Add `slashActive: boolean`, `slashQuery: string`, `slashMatches: readonly SlashMatch[]`, `showSessionList: boolean` to `TuiState` (flat fields, consistent with existing `TuiState` pattern at `state.ts:108-126`)
  - Add `setSlashState(state, partial)` — updates slash fields atomically
  - Add `toggleSessionList(state): TuiState` — toggles `showSessionList`
  - Add `clearMessages(state): TuiState` — resets `messages: []`, `streamingText: ""`, `errors: []`
  - Wire `Ctrl+A` to existing `toggleAgentPanel()` at `state.ts:396`
  - Confirm `projectTuiEvent` needs no changes (slash state is TUI-local)
- Create `src/tui/components/SlashSuggestions.tsx`:

  ```ts
  export function SlashSuggestions({
    matches,
    width,
    active,
  }: {
    readonly matches: readonly SlashMatch[]
    readonly width?: number
    readonly active: boolean
  }): string
  ```

  - Returns empty string when `active` is false
  - Deduplicates by name, caps at 5 matches, truncates descriptions to `width - 4`
  - Shows `"[ESC to cancel]"` footer

- Modify `src/tui/components/SessionView.tsx`:
  - When `slashActive` is true, render `SlashSuggestions` instead of `SidePanel` (mutual exclusion)
  - Pass `width` from options
- Modify `src/tui/app.tsx`:
  - Split multi-character `data` chunks into individual characters for `parseTuiKey()` per character
  - Track single-char lookbehind for `Alt+Enter` detection
  - Use `else if` chain for action handling to prevent double-processing
  - Compute slash state on input changes, dispatch on submit (TUI-local vs backend vs fallthrough)
  - Escape: check slash-active first; if active clear it, otherwise fall through to existing handler
  - Tab: one-shot completion, no cycling
- Register TUI-local commands: `/help` (show keybindings), `/exit` / `/quit` / `/q` (cleanup + resolve), `/clear` (clear messages), `/skills` (list available skills)
- Add tests: `test/tui/keymap.test.ts` (new actions including Alt+Enter), `test/tui/slash.test.ts` (autocomplete, dispatch, edge cases)

Verification:

- `bun test test/tui`
- `bun run typecheck`
- `bun run lint`
- Manual: `bun src/index.ts tui --model fake/test` — type `/help`, verify suggestions appear; type `/exit`, verify TUI exits

Review:

Reviewer must verify: (a) slash detection handles `/` at position 0 only (not mid-input), (b) Backspace to empty clears slash state, (c) Escape clears slash state before falling through to question/panel handler, (d) `Ctrl+L` clears messages/streamingText/errors without destroying session, (e) `Ctrl+A` toggles agent panel, (f) `Alt+Enter` inserts literal `"\n"` in raw mode, (g) Tab completes to first match without cycling, (h) multi-character paste chunks are split correctly before key parsing.

### PR 3: Session Command Execution

**Pre-requisite:** PR 1 (Command Registry), PR 8 (Main Agent)

- Add `command(input: CommandInput)` method to `SessionRunService` in `src/session/run.ts`:
  ```ts
  export interface CommandInput {
    readonly name: string // e.g., "review"
    readonly arguments: string // everything after command name
    readonly sessionId: string
    readonly model?: string
    readonly agent?: string
  }
  ```
- `command()` flow: resolve template via `resolveCommandTemplate()`, create or resume session, submit resolved prompt to `MainAgent.run()`, return result
- If command has `subtask: true`, wrap the prompt in a subtask marker (the MainAgent already supports subagent tool; subtask wrapping is a prompt-level convention)
- Wire TUI `app.tsx` dispatch path for backend commands: `service.command({ name, arguments, sessionId, model, agent })`
- Add `commandDescriptions` entry for `"commands"` → `"List available slash commands"`
- Add `"commands"` to `CommandName`, wire a no-op `oc2 commands` that prints registered command list
- Add tests: `test/session/command.test.ts` (command resolution + execution with fake provider)

Verification:

- `bun test test/session/command.test.ts`
- `bun run typecheck`
- `bun run lint`
- Manual: `bun src/index.ts run "/review check for bugs" --model fake/test --json` (via CLI run)

Review:

Reviewer must verify: (a) `$ARGUMENTS` substitution is exact, (b) empty arguments pass empty string, (c) command execution reuses existing session if sessionId provided, (d) subtask flag correctly wraps prompt, (e) failed command execution returns structured error not crash.

### PR 4: Missing CLI Commands & Flags

- Add `oc2 sessions list` — call `SessionService.listSessions()`, format output with id, title, status, createdAt
- Add `oc2 tools enable <name>` / `oc2 tools disable <name>` — reuse existing `setJsoncPath()` with path `tools.<name>.enabled`
- Add `oc2 memory list [--repository <path>]` — call `RepositoryMemoryRepository.listRetrievalLogs(cwd)`; default to CWD resolved to absolute path, accept optional `--repository` flag
- Add `oc2 run --team` flag — pass to `RunPromptInput.team`; when true, include team tools in run config
- Add `oc2 run --timeout <ms>` — pass to `RunPromptInput.timeoutMs`, override default
- Add `oc2 run --max-concurrency <n>` — pass to `RunPromptInput.maxConcurrency`, override scheduler limits
- Add `oc2 resume <id> --tui` — launch TUI without requiring `--run`; new `ParsedCommand` variant `{ name: "resume"; sessionId: string; tui: true; json: boolean; model?: string }`
- Add `"sessions"` and `"memory"` to `CommandName` union, `ParsedCommand`, `commandDescriptions`, `parseCommand()`, and `executeCommand()`
- Add `formatSessionsListText()`, `formatSessionsListJson()`, `formatMemoryListText()` to `src/cli/output.ts`
- Extend `RunPromptInput` in `src/session/run.ts` with `team?: boolean`, `timeoutMs?: number`, `maxConcurrency?: number`
- Add tests: `test/cli/sessions.test.ts`, `test/cli/memory.test.ts`, `test/cli/tools-enable-disable.test.ts`, `test/cli/run-flags.test.ts`
- **NOT included:** `--provider` (redundant with `--model` which already encodes provider via `/` split), `--no-tui` (CLI is already non-interactive)

Verification:

- `bun test test/cli`
- `bun run typecheck`
- `bun run lint`
- `bun src/index.ts sessions list`
- `bun src/index.ts tools enable read`
- `bun src/index.ts tools disable read`
- `bun src/index.ts memory list`
- `bun src/index.ts run "hello" --model fake/test --timeout 5000 --json`
- `bun src/index.ts run "hello" --model fake/test --team --json`

Review:

Reviewer must verify: (a) `sessions list` returns actual DB rows (test with fixture DB), (b) `tools enable/disable` writes valid JSONC to config at path `tools.<name>.enabled`, (c) `memory list` defaults to CWD and accepts `--repository` flag, (d) `--team` flag correctly enables team tools, (e) `--timeout` correctly bounds task execution, (f) `resume --tui` does not require `--run` and launches TUI with sessionId, (g) `RunPromptInput` extensions are backward compatible (all new fields optional).

### PR 5: User-Defined Command Loading

**Pre-requisite:** PR 1 (Command Registry)

- Add `src/commands/user-commands.ts` with `loadUserCommands(paths: string[], readFile)` — globs for `commands/*.md` and `command/*.md` in config dirs, parses simple YAML-like frontmatter (split on `---`, manual key-value parsing, no external YAML library), uses file body as template
- Register user commands alongside builtins in the registry
- If a user command has the same name as a builtin, the user command takes precedence (overwrite). File load order: project config dirs, then user config dir — later loads overwrite earlier.
- Add optional `commands` config key to `Oc2Config` in `src/config/schema.ts`:
  ```ts
  commands?: Record<string, {
    description?: string
    aliases?: string[]
    template?: string
    subtask?: boolean
    agent?: string
    model?: string
  }>
  ```
- Config-inline commands complement file-loaded commands; if both exist with the same name, config-inline takes precedence
- Add tests: `test/commands/user-commands.test.ts`

Verification:

- `bun test test/commands/user-commands.test.ts`
- `bun run typecheck`
- `bun run lint`

Review:

Reviewer must verify: (a) user commands override builtins by name, (b) frontmatter parsing handles missing fields gracefully, (c) glob pattern finds both `commands/` and `command/` directories, (d) malformed markdown does not crash loading.

### PR 6: End-to-End Integration & Hardening

- E2E test: full flow — TUI input, slash autocomplete, selection, backend command execution with fake provider, result display
- Integration test: `/review` with fake provider produces expected system prompt content
- Integration test: `/clarify` with fake provider loads skill file and substitutes args
- Integration test: `/team-report` triggers team report generation
- Ensure all commands appear in `oc2 commands` listing
- Update `README.md` with slash command documentation and new CLI commands
- Add `Ctrl+L`, `Ctrl+R`, `Ctrl+A`, `Alt+Enter`, `Tab` to TUI help text (shown by `/help`)

Verification:

- `bun test`
- `bun run typecheck`
- `bun run lint`
- `bun src/index.ts commands`
- `bun src/index.ts tui --model fake/test`

Review:

Reviewer must verify: (a) all 6 PRs integrate without regression, (b) slash commands work from both TUI and CLI (`/review` as prompt text in `oc2 run`), (c) documentation is accurate, (d) no copied opencode code.

## Future Work

- MCP prompt commands — register MCP server prompts as slash commands (requires MCP runtime in PR 10)
- Fuzzy matching in autocomplete (first pass uses exact prefix matching)
- Multi-line slash command input with `Alt+Enter` for body text after command arguments
- Command history navigation (up/down arrows in TUI for previous slash commands)
- `oc2 commands run <name> [args]` — CLI subcommand to execute a named command without the TUI
- Config-defined command aliases in `oc2.jsonc`
- `$1`, `$2` positional argument substitution (first pass uses only `$ARGUMENTS`)

## Open Questions

- **Should `/review` use subtask mode by default?** Default: yes. Review runs are typically long and benefit from subtask isolation, consistent with opencode behavior.
- **Should `oc2 run "/review check for bugs"` work from CLI?** Default: yes, if a command name is the first word after `/`, resolve it as a command — this makes the CLI and TUI paths consistent.
- **Where should command registry initialization live?** Default: `SessionRunService` constructor, since it needs config paths and may need MCP for future MCP-prompt commands. The TUI app gets the registry from the service.
- **Should user-defined commands be in scope for the first implementation?** Default: yes, but only basic markdown-file loading (PR 5). Config-inline command definitions and MCP prompts are future work.
- **How should the slash suggestions overlay interact with the inline side panel?** Resolved: slash suggestions replace the side panel area when visible (mutual exclusion). Implemented as described in TUI Rendering Changes.
