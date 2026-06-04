# Persist Supervisor Session Settings

## Goal

Persist per-session supervisor settings changed through `/supervisor` and `PATCH /session/:sessionID/supervisor` so they survive the normal session event projection path and runtime reloads.

Keep the existing UI, API, DB column, and merge behavior. The fix should repair the durable write path: `Session.setSupervisorSettings` publishes `session.updated`, `SessionLegacy.SessionInfo` must carry the `supervisor` payload, and `SessionProjector` must write it to `SessionTable.supervisor`.

## Current State

- `packages/opencode/src/supervisor/supervisor.ts` defines `Supervisor.SessionSettings`, `Supervisor.SettingsPatch`, defaults, and session-over-global merge behavior.
- `packages/opencode/src/config/supervisor.ts` defines global `opencode.json` supervisor defaults.
- `packages/opencode/src/cli/cmd/tui/routes/session/dialog-supervisor.tsx` reads/writes settings with `sdk.client.session.supervisor.get/update`.
- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` exposes `GET/PATCH /session/:sessionID/supervisor`.
- `packages/opencode/src/session/session.ts` already has `Info.supervisor`, `UpdatedInfo.supervisor`, `fromRow`, `toRow`, and `setSupervisorSettings`; `Session.Event.Updated` still uses `SessionLegacy.Event.Updated` for projection.
- `packages/core/src/session/sql.ts` already has nullable JSON `SessionTable.supervisor`.
- Existing migrations add the column: authoritative core migration `packages/core/src/database/migration/20260511180000_session_processing_supervisor.ts` and tested opencode SQL artifact `packages/opencode/migration/20260531203016_session_supervisor_settings/migration.sql`.
- `packages/core/src/session/legacy.ts` `SessionLegacy.SessionInfo` omits `supervisor`.
- `packages/core/src/session/projector.ts` `sessionRow(info)` omits `supervisor`, so `session.updated` projection drops settings before durable storage.
- `packages/opencode/test/server/httpapi-supervisor.test.ts` and `packages/opencode/test/server/httpapi-session.test.ts` cover runtime supervisor behavior through HTTP/`Session.get()`, but do not inspect `SessionTable.supervisor` or prove projector/reload durability.
- `packages/opencode/test/server/httpapi-public-openapi.test.ts` verifies supervisor routes are documented in OpenAPI.
- `packages/opencode/specs/sidecar-supervisor-service.md` already states `SupervisorSessionSettings` is durable session metadata.

## Non-Negotiables

- Do not change `GET/PATCH /session/:sessionID/supervisor` request or response shapes unless the implementation discovers an existing schema mismatch.
- Do not add TUI KV, a supervisor table, or another storage path.
- Do not persist derived supervisor state, activity, reports, raw command output, prompts, or recommendations.
- Do not add a migration unless existing migration tests prove `session.supervisor` is missing.
- Core must not import opencode supervisor schemas.
- Clearing all overrides must persist `NULL`/`undefined`, not `{ updatedAt }`.
- Verify OpenAPI/SDK output; regenerate with `./packages/sdk/js/script/build.ts` only if event/API schemas change.

## Storage And Event Design

Persist this nullable JSON shape in `SessionTable.supervisor`:

```ts
type SupervisorSessionSettings = {
  mode?: "off" | "observe" | "advise"
  recommendation_model?: string
  recommendation_variant?: string
  recommendation_timeout_ms?: number
  review_cadence?: "step" | "event" | "idle"
  min_review_interval_ms?: number
  max_recommendation_chars?: number
  max_repeated_command_failures?: number
  broad_diff_file_limit?: number
  sensitive_path_globs?: string[]
  validation_command_patterns?: string[]
  insert_recommendations?: boolean
  max_recommendations_per_session?: number
  updatedAt: number
}
```

Durable flow:

```text
DialogSupervisor / HTTP PATCH
-> SupervisorState.updateSettings
-> Session.setSupervisorSettings
-> SessionLegacy.Event.Updated with info.supervisor
-> SessionProjector.sessionRow(info).supervisor
-> SessionTable.supervisor
-> Session.fromRow decodes Supervisor.SessionSettings on later reads
```

Implementation constraints:

- Add `supervisor` to `SessionLegacy.SessionInfo` as a core-safe optional JSON-preserving payload, for example `optionalOmitUndefined(Schema.Any)`. Core must not validate supervisor-specific fields.
- Keep validation of actual supervisor semantics in `packages/opencode/src/session/session.ts` via `Supervisor.SessionSettings`.
- Add `supervisor: info.supervisor ?? null` in `packages/core/src/session/projector.ts` `sessionRow(info)` so omitted/undefined clears the nullable DB column during reset.
- Reset/clear must write `NULL`.
- Do not change `Supervisor.applySettingsPatch` unless tests show reset no longer returns `undefined` when no override keys remain; current behavior already does this.
- Invalid stored JSON should continue to fail at opencode read/decode time.

## Implementation Slices

### PR 1: Persist Supervisor Through Session Projection

- Add optional `supervisor` support to `packages/core/src/session/legacy.ts` `SessionLegacy.SessionInfo`.
- Update `packages/core/src/session/projector.ts` `sessionRow(info)` to write `supervisor`.
- Add a regression in `packages/opencode/test/server/httpapi-supervisor.test.ts`, `packages/opencode/test/server/httpapi-session.test.ts`, or a focused projector test that PATCHes a session, directly reads `SessionTable.supervisor`, and asserts it contains the patched supervisor settings, including `updatedAt`.
- Add reset coverage that sends `PATCH { "reset": true }`, directly asserts `SessionTable.supervisor` is `NULL`, and then asserts `GET /session/:sessionID/supervisor` has no `config.session`.
- Verify the regression fails on the old projector behavior and passes with the fix.
- The regression must fail if only `SessionProjector.sessionRow` omits `supervisor`; assertions against `Session.get()` alone are insufficient because runtime state can still contain the update before durable projection is verified.
- Run the OpenAPI/SDK generation check only if adding `supervisor` to `SessionLegacy.SessionInfo` changes exported event/API schema output; if generated files do not change, note that explicitly in the PR.

Verification:

- `cd packages/opencode && bun test test/server/httpapi-supervisor.test.ts`
- `cd packages/opencode && bun test test/server/httpapi-session.test.ts`
- `cd packages/opencode && bun test test/session/session-schema.test.ts`
- `cd packages/opencode && bun test test/server/httpapi-public-openapi.test.ts`
- `cd packages/opencode && bun typecheck`
- `cd packages/core && bun typecheck`
- `cd packages/core && bun test test/database-migration.test.ts` to prove core-applied migrations include `session.supervisor`
- `./packages/sdk/js/script/build.ts` if OpenAPI/SDK output changes

Review:

Before merging, run a fresh read-only reviewer against the diff and this slice. The reviewer must verify core does not import opencode supervisor modules, tests assert persisted DB/projector state rather than only in-memory state, reset writes `NULL`, no derived supervisor activity/report data is persisted, and the new test would fail with the old projector implementation, not merely with the old legacy schema.

## Future Work

- Persist supervisor activity history only if users need restart-stable activity timelines.
- Improve UI labels that distinguish global defaults from per-session overrides.
- Add data repair only if released builds lost important supervisor overrides; default assumption is no repair is possible because dropped settings were never written.

## Open Questions

- Should a migration be added? Default: no, because core schema already has `SessionTable.supervisor` and existing migrations already add the column; add one only if `packages/core` migration tests prove a core-applied migration path is missing it.
- Should core structurally type supervisor settings? Default: no; core should preserve JSON and let opencode validate supervisor semantics.
