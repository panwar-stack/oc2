# Persist Session Roots Across Restarts

## Goal

Ensure directories added through root management survive opencode process restarts, TUI restarts, and session re-open flows. The first pass should validate and fix the existing persisted `session_root` implementation rather than introduce a new storage model.

Treat `/root` as user-facing shorthand for the existing `/roots` command. Preserve `/roots`, `/cwd`, and `/dirs`; add `/root` only as a non-breaking alias if command registration supports it cleanly.

## Current State

- `packages/tui/src/routes/session/index.tsx` registers `SessionRootsCommand` with `slashName: "roots"` and aliases `["cwd", "dirs"]`.
- `packages/tui/src/routes/session/dialog-roots.tsx` mutates roots through `sdk.client.session.root.add`, `update`, and `delete`, then calls `sync.session.refreshRoots(sessionID)`.
- `packages/tui/src/context/sync.tsx` stores roots in `session_root: { [sessionID: string]: SessionRoot[] }` and reloads them during `sync(sessionID)`.
- `packages/core/src/session/sql.ts` already defines `SessionRootTable` with `session_id`, `directory`, `name`, `primary`, and unique `(session_id, directory)`.
- `packages/opencode/src/session/session.ts` exposes `listRoots`, `addRoot`, `updateRoot`, `removeRoot`, and `getPrimaryRoot`.
- `packages/opencode/src/session/session.ts` keeps `SessionTable.directory`, `path`, and `project_id` synced when the primary root changes.
- `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` exposes root endpoints under `/session/:sessionID/root`.
- `packages/opencode/test/session/session.test.ts` covers root CRUD but does not prove roots survive service/process restart.
- `packages/opencode/test/server/httpapi-session.test.ts` covers HTTP root mutation routes but not restart rehydration.
- `specs/multi-root-sessions.md` documents `/roots` and should be updated if `/root` becomes an alias.

## Non-Negotiables

- Must reuse `session_root`; do not add a second persisted root store.
- Must preserve existing `/roots`, `/cwd`, and `/dirs` behavior.
- Must not break existing sessions that only have `SessionTable.directory`; migration/backfill behavior must remain covered.
- Must keep exactly one primary root per session at the service boundary.
- Must not silently lose secondary roots after restart, session list refresh, or TUI session hydration.
- Leave symlink/case-insensitive canonicalization out of the first pass unless an existing test already defines that behavior.

## Restart Behavior

Root persistence is successful when this sequence is deterministic:

1. Create a session.
2. Add at least one secondary root through `Session.addRoot` or the HTTP root endpoint.
3. Recreate the service/database layer using the same persistent DB.
4. Re-open the same session.
5. `listRoots(sessionID)` returns the primary root and all secondary roots with stable `directory`, `name`, and `primary` values.
6. TUI sync for that session populates `sync.data.session_root[sessionID]` from the server, not from stale in-memory state.

Failure modes to cover:

- Duplicate root add still fails through the existing unique `(session_id, directory)` constraint.
- Removing the primary root still promotes a fallback root.
- Removing the last root still fails.
- A restart must not create a duplicate primary root for an existing session.

## Command Behavior

- Add `/root` as an alias for `SessionRootsCommand` if product wants the singular spelling.
- Do not rename `slashName: "roots"` in the first pass because existing tests and docs already reference `/roots`.
- Update `packages/opencode/test/cli/cmd/tui/session-roots-command.test.tsx` to include `/root` if the alias is added.
- Update `specs/multi-root-sessions.md` to list `/root` as an alias if implemented.

## Session Discovery

The implementation must verify whether session listing after restart can find sessions when the current directory is a secondary root.

Relevant risk:

- `packages/opencode/src/session/session.ts` still has list paths that filter by `SessionTable.directory`, which represents only the primary root.
- If re-opening from a secondary root should show the session, update list queries to join or filter against `SessionRootTable`.
- If re-opening from secondary roots is out of scope, document that explicitly in `specs/multi-root-sessions.md`.

## Implementation Slices

### PR 1: Restart Persistence Test

- Add a service-level test in `packages/opencode/test/session/session.test.ts` or a focused new test file.
- Create a session, add a secondary root, recreate the relevant DB/session layer with the same test DB, and assert `listRoots(sessionID)` returns both roots.
- Assert the primary flag remains stable and no duplicate root is inserted on reload.
- Do not change production code unless this test exposes a real failure.

Verification:

- `cd packages/opencode && bun test test/session/session.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only teammate must review the diff against this spec before merge, focusing on whether the test actually crosses a restart boundary instead of only reading from cached service state.

### PR 2: TUI Command Alias And Hydration Coverage

- Add `/root` as an alias for `SessionRootsCommand` in `packages/tui/src/routes/session/index.tsx` if accepted.
- Update `packages/opencode/test/cli/cmd/tui/session-roots-command.test.tsx` to verify `/root`, `/cwd`, and `/dirs`.
- Add or extend TUI sync coverage so session hydration reloads roots through `sdk.client.session.root.list`.
- Update `specs/multi-root-sessions.md` with the alias and restart guarantee.

Verification:

- `cd packages/opencode && bun test test/cli/cmd/tui/session-roots-command.test.tsx test/cli/cmd/tui/dialog-roots.test.tsx`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only teammate must confirm this PR is command/sync-only and does not alter root storage semantics.

### PR 3: Session Listing From Secondary Roots

- Add a failing test that creates a session with primary root A and secondary root B, restarts/recreates service state, then lists sessions from B.
- If expected behavior is "sessions appear from any root", update `packages/opencode/src/session/session.ts` list queries to account for `SessionRootTable.directory`.
- Keep `SessionTable.directory` as the primary-root compatibility field.
- Avoid broad query rewrites; change only the listing paths needed for restart discovery.

Verification:

- `cd packages/opencode && bun test test/session/session.test.ts`
- `cd packages/opencode && bun test test/server/httpapi-session.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only teammate must inspect query behavior for duplicate sessions, ordering regressions, and compatibility with primary-root-only sessions.

### PR 4: Primary Root Invariant Hardening

- Add tests for "exactly one primary root" after add, update-primary, remove-primary, and restart.
- Prefer service-level invariant checks first.
- Add a DB migration only if tests show service-level transactions are insufficient.
- If a migration is added, update `packages/core/src/database/migration.gen.ts` through the existing migration workflow.

Verification:

- `cd packages/core && bun script/migration.ts --check`
- `cd packages/opencode && bun test test/session/session.test.ts test/storage/session-root-migration.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

A fresh read-only teammate must review migration safety, backfill behavior, and whether existing databases with valid root rows remain compatible.

## Future Work

- Canonicalize roots with realpath/case-aware behavior for symlinks and case-insensitive filesystems.
- Add live cross-client root mutation events instead of relying on manual `refreshRoots`.
- Copy all roots when forking a session if product expects forks to preserve multi-root context.
- Improve HTTP error payloads for duplicate root, last-root removal, and invalid directory cases.

## Open Questions

- Should `/root` be added as an alias now? Default: yes, as a non-breaking alias while keeping `/roots`.
- Should sessions opened from a secondary root appear in session lists after restart? Default: yes, because users expect any saved root to identify the session.
- Should forked sessions copy all roots? Default: leave out of first pass unless a user flow depends on it.
