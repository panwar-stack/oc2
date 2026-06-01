# Supervisor Activity Timeline

## Goal

Add `/supervisor activity` as a local TUI command that opens a chronological timeline of what the supervisor observed or decided for the current session.

The first pass should record a bounded, observable-only activity list in the supervisor service, expose it through a typed read API, regenerate the JS SDK, and render it in the TUI. Keep the timeline focused on reviewable signals: settings changes, touched files, commands, validations, risks, and recommendations.

## Current State

- `packages/opencode/specs/sidecar-supervisor-service.md` defines the supervisor as an opt-in session service with a local TUI `/supervisor` control surface, read/report APIs, and a non-negotiable that `/supervisor` stays a local TUI control command rather than a model-facing command template.
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` exports `SessionSupervisorCommand`; it registers `session.supervisor` with `slashName: "supervisor"` and opens `DialogSupervisor`.
- `packages/opencode/src/cli/cmd/tui/keymap.tsx` derives slash autocomplete entries from reachable palette commands via `useCommandSlashes()`.
- `packages/opencode/src/cli/cmd/tui/component/prompt/autocomplete.tsx` includes internal slash entries before server/user commands, so selecting an internal slash can dispatch a palette command today.
- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` only treats typed slash text as a command when the name exists in `sync.data.command`; manual `/supervisor activity` would otherwise fall through to prompt/session command behavior.
- `packages/opencode/src/cli/cmd/tui/routes/session/dialog-supervisor.tsx` is the closest supervisor UI/data pattern: it fetches `sdk.client.session.supervisor.get({ sessionID }, { throwOnError: true })` and uses existing dialog primitives.
- `packages/opencode/src/supervisor/supervisor.ts` exposes `Supervisor.State` and `Supervisor.Report`, but no public chronological `Activity` schema exists.
- `packages/opencode/src/supervisor/index.ts` already derives bounded activity-like data from observable events and snapshots, including files, commands, validations, risks, recommendations, and internal `recentEvents` for recommendation input.
- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` exposes `GET/PATCH /session/:sessionID/supervisor` and `GET /session/:sessionID/supervisor/report`; no `/activity` endpoint exists.
- `packages/opencode/test/cli/cmd/tui/session-supervisor-command.test.tsx` covers `/supervisor` registration, no-session toast behavior, API calls, validation, and update failures.
- `packages/opencode/test/supervisor/supervisor-state.test.ts` covers supervisor state derivation and is the right place to add timeline derivation tests.

## Non-Negotiables

- `/supervisor activity` must be a local TUI command.
- Do not add it to `Command.Default`, route it through `POST /session/:sessionID/command`, or send it to the model.
- Typing `/supervisor activity` and pressing enter must open the same timeline as selecting `/supervisor activity` from slash autocomplete.
- Keep existing `/supervisor` behavior unchanged; it must continue to open supervisor configuration.
- The timeline must be bounded and observable-only. Do not store or display raw command output, full file contents, full diffs, private reasoning, full prompts, or raw recommendation inputs.
- First pass stores activity in the in-process supervisor service only. Do not add database persistence unless a later requirement explicitly needs restart-stable history.
- Outside a session route, show an error toast instead of creating a session.
- Any new endpoint or schema field must be reflected in OpenAPI and the JS SDK by running `./packages/sdk/js/script/build.ts` from repo root.

## Data Model

Add a public activity schema in `packages/opencode/src/supervisor/supervisor.ts`:

```ts
type SupervisorActivityType =
  | "file"
  | "command"
  | "validation"
  | "risk"
  | "recommendation"
  | "settings"

type SupervisorActivity = {
  id: string
  sessionID: string
  time: number
  type: SupervisorActivityType
  severity?: "info" | "warning" | "high"
  title: string
  message?: string
  evidence: string[]
  metadata?: {
    file?: string
    command?: string
    exitCode?: number
    validation?: boolean
    repeatedFailureCount?: number
    trigger?: SupervisorTrigger
    action?: SupervisorAction
    inserted?: boolean
  }
}
```

Constraints:

- `id` must be deterministic enough to dedupe repeated observations within one service lifetime. Prefer a stable key from `sessionID`, `type`, `time` bucket or source event identifier, and primary target.
- `time` must be milliseconds since epoch.
- `title` must be short and safe for collapsed timeline rows.
- `message` and `evidence` must be bounded strings derived from observable state.
- Keep only the latest 100 activities per session in memory for the first pass.
- Sort API responses newest first by default so the TUI opens on the latest activity.
- Do not persist raw activity to `SessionTable` in the first pass.

## API And SDK Surface

Add a read-only endpoint:

```ts
GET /session/:sessionID/supervisor/activity
```

Response:

```ts
SupervisorActivity[]
```

Implementation touch points:

- Add `Supervisor.Activity` and related schemas in `packages/opencode/src/supervisor/supervisor.ts`.
- Add `getActivity(sessionID)` to `Supervisor.Service` in `packages/opencode/src/supervisor/index.ts`.
- Add `supervisorActivity` to `SessionPaths` and a `getSupervisorActivity` endpoint in `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts`.
- Add the handler in `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`.
- Regenerate the JS SDK with `./packages/sdk/js/script/build.ts` from repo root.

Do not add mutation APIs for activity in the first pass.

## Timeline Semantics

Record activity when the supervisor observes or creates these bounded facts:

- `settings`: supervisor mode/config changed through `updateSettings`.
- `file`: a file path is newly observed in `filesTouched`.
- `command`: a command is observed in `commandsRun`.
- `validation`: a command is classified as validation and appears in `validationsRun`.
- `risk`: a risk is added or its severity/message changes.
- `recommendation`: a recommendation is created or inserted.

Failure modes and edge cases:

- If supervisor mode is `off`, `GET /activity` should return the existing in-memory list, usually empty. The TUI should show `Supervisor is off. No new activity is being recorded.`
- If the service restarts, first-pass activity may be empty until new events arrive or snapshots are rebuilt. This must be acceptable and documented in the UI/spec.
- Duplicate observations must not spam the timeline during repeated rebuilds. Use a per-session dedupe key set alongside the bounded activity list.
- Activity must not include internal `recentEvents` directly; convert only safe observable facts into public activities.

## TUI Behavior

Add a second palette command beside `session.supervisor`:

```ts
{
  namespace: "palette",
  name: "session.supervisor.activity",
  title: "Show supervisor activity",
  category: "Session",
  slashName: "supervisor activity",
  run: () => { ... },
}
```

Behavior:

- On a session route, open `DialogSupervisorActivity` for the current `sessionID`.
- Outside a session route, show `Open a session to view supervisor activity` with `variant: "error"`.
- Preserve `/supervisor` as the settings command and do not overload it with argument parsing.
- Extend typed prompt submission so exact internal slash commands dispatch locally before any agent/model/workspace/session creation logic.
- Match only `entry.display` from `useCommandSlashes()` in the first pass; do not match aliases unless explicitly added later.
- Match only a single-line, trimmed prompt equal to `/supervisor activity`.
- On match, call `entry.onSelect()`, reset the prompt, and do not call `sdk.client.session.command`, `sdk.client.session.prompt`, or `sdk.client.session.create`.
- Do not intercept multiline prompts or slash text with extra arguments such as `/supervisor activity now`.

## Activity Timeline UX

Create `packages/opencode/src/cli/cmd/tui/routes/session/dialog-supervisor-activity.tsx` as a read-only timeline backed by `sdk.client.session.supervisor.activity` after SDK regeneration.

Initial layout:

```text
Supervisor Activity

Status: drifting   Mode: advise   Updated: 12:41:08

12:40:52  recommendation  warn missing_validation
          Run validation before marking this done.
          Evidence: edited packages/opencode/src/..., no validation command observed

12:39:18  risk            warning repeated_command_failure
          Command failed 3 times: bun test test/foo.test.ts
          Evidence: exit 1, repeatedFailureCount=3

12:37:44  validation      success
          bun test test/supervisor/supervisor-state.test.ts

12:36:09  command         failure
          bun test test/foo.test.ts
          Exit: 1

12:34:22  file            touched
          packages/opencode/src/supervisor/index.ts

12:32:01  settings        mode changed
          observe -> advise
```

Controls:

- `j/k` or arrows move between timeline rows through existing dialog navigation.
- `enter` expands or collapses detail if the chosen dialog primitive supports it; otherwise show detail in the row description for the first pass.
- `r` refreshes the activity endpoint if easy to wire with existing keymap/dialog patterns; otherwise leave manual refresh for future work.
- `esc` closes the dialog.

Display rules:

- Default filter is `All`; do not add filter controls in the first pass unless the chosen dialog primitive makes them trivial.
- Render newest activity first.
- Show timestamp, type, severity/action/trigger where available, and title on the collapsed row.
- Show bounded `message`, `evidence`, and metadata in expanded/detail text.
- Empty state: `No supervisor activity yet.`
- Off mode empty state: `Supervisor is off. No new activity is being recorded.`
- Load failure: `toast.show({ message: errorMessage(error), variant: "error" })`.

`DialogSelect` is acceptable for the first pass, but do not mark read-only rows as `disabled`; disabled options are filtered out by the dialog. Use selectable/no-op rows or another existing read-only dialog primitive.

## Implementation Slices

### PR 1: Typed Internal Slash Dispatch

- In `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`, add internal slash dispatch immediately after disabled/autocomplete/empty/exit handling.
- The dispatch must happen before `local.agent.current()`, model selection, workspace checks, `session.create()`, `sync.data.command`, `sdk.client.session.command`, and `sdk.client.session.prompt`.
- Use `useCommandSlashes()` as the source of registered internal slash commands.
- Match exact trimmed single-line `entry.display` values only.
- Ensure matched internal slashes reset the prompt and make no server/model request.
- Add a prompt submit test with a real registered keymap command, or a focused mock proving exact `/supervisor activity` dispatches locally, clears input, and makes no `/session`, `/session/:id/command`, or `/session/:id/message` request.
- Include no-session coverage proving typed `/supervisor activity` shows the local toast and does not create a session.

Verification:

- `cd packages/opencode && bun test test/cli/cmd/tui/session-supervisor-command.test.tsx`
- `cd packages/opencode && bun typecheck`

Review:

Before merging, run a fresh read-only reviewer against the diff and this slice. The reviewer must verify typed internal slash dispatch happens before session creation/server command dispatch and that `/supervisor activity` is never sent to the model.

### PR 2: Supervisor Activity Model And API

- Add `Supervisor.Activity`, `Supervisor.ActivityType`, and metadata schemas in `packages/opencode/src/supervisor/supervisor.ts`.
- Extend `Supervisor.Service` in `packages/opencode/src/supervisor/index.ts` with a bounded per-session activity list and `getActivity(sessionID)`.
- Record deduped activities for settings, files, commands, validations, risks, and recommendations from existing observable supervisor derivation paths.
- Add `GET /session/:sessionID/supervisor/activity` in `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` and `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`.
- Add tests in `packages/opencode/test/supervisor/supervisor-state.test.ts` for ordering, bounding, dedupe, and observable-only activity payloads.
- Regenerate the JS SDK with `./packages/sdk/js/script/build.ts` from repo root.

Verification:

- `cd packages/opencode && bun test test/supervisor/supervisor-state.test.ts`
- `cd packages/opencode && bun run test:httpapi`
- `cd packages/opencode && bun typecheck`
- `./packages/sdk/js/script/build.ts`

Review:

Before merging, run a fresh read-only reviewer against the diff and this slice. The reviewer must verify activity is bounded, deduped, observable-only, not persisted to the database, and represented in generated SDK/OpenAPI output.

### PR 3: Supervisor Activity Timeline Dialog

- Add `DialogSupervisorActivity` in `packages/opencode/src/cli/cmd/tui/routes/session/dialog-supervisor-activity.tsx`.
- Extend `SessionSupervisorCommand` in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` with `session.supervisor.activity`, `title: "Show supervisor activity"`, and `slashName: "supervisor activity"`.
- Fetch timeline data with the generated SDK method for `GET /session/:sessionID/supervisor/activity`.
- Fetch current supervisor state with `sdk.client.session.supervisor.get` only for header context such as mode/status/off-mode empty state.
- Render newest-first read-only timeline rows with bounded detail text.
- Add/extend `packages/opencode/test/cli/cmd/tui/session-supervisor-command.test.tsx` coverage for `/supervisor activity` registration, no-session toast, successful activity fetch/open, empty state, off-mode empty state, and fetch failure toast.
- Update `packages/opencode/specs/sidecar-supervisor-service.md` or add a short adjacent note so the supervisor UI surface documents `/supervisor activity` separately from `/supervisor` settings.

Verification:

- `cd packages/opencode && bun test test/cli/cmd/tui/session-supervisor-command.test.tsx`
- `cd packages/opencode && bun typecheck`
- `git diff --check`

Review:

Before merging, run a fresh read-only reviewer against the diff and this slice. The reviewer must verify the TUI uses the activity endpoint, does not send slash text to the model, keeps displayed data bounded, and leaves `/supervisor` settings behavior unchanged.

## Future Work

- Persist supervisor activity if users need history across process restarts.
- Add live refresh from `supervisor.state.updated` or a future `supervisor.activity.created` event.
- Add timeline filters for `All`, `Risks`, `Recommendations`, `Files`, `Commands`, `Validations`, and `Settings`.
- Add recommendation history/report export by intentionally using `sdk.client.session.supervisor.report` in a separate reporting UI.
- Add aliases such as `/activity` only if users find the full command too long.

## Open Questions

- Should first-pass activity survive process restarts? Default: no; keep it bounded and in-memory to avoid a migration until restart-stable history is explicitly required.
- Should the timeline support filters in the first pass? Default: no; ship `All` first and add filters after the data shape and command prove useful.
- Should `/supervisor activity extra` be accepted? Default: no; exact matching prevents accidental interception of prompts that merely start with the command text.
