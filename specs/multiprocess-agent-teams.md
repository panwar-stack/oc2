# Multi-Process Agent Teams With A Cross-Machine Transport

## Goal

Run every agent-team teammate as its own OC2 OS process, connected to the lead session over a host-agnostic HTTP/SSE transport that works across VMs without shared storage. Preserve the current team design: durable schema, member lifecycle, mailbox, shared tasks, exact-file reservations, revision, and the final-report barrier.

Implementation strategy: the lead process hosts a **team control plane** that owns the authoritative SQLite store and all coordination. A teammate is a spawned headless OC2 process in a new `teammate` role. It runs the existing session loop and tools against a local transcript mirror, and it reaches team state and wakes only through the control plane. The control plane reuses the existing durable team service, event projector, and lifecycle semantics. First pass keeps the default single-process path unchanged behind a feature flag.

## Current State

- Teammates are child `SessionTable` rows run as Effect fibers inside the lead OS process. `team_spawn.ts` creates the session; `packages/opencode/src/session/lifecycle-reconciler.ts` starts and settles the run; `SessionRunState` (`session/run-state.ts`) holds in-memory runners, parks, and a single `wakeTarget`.
- Durable coordination state is SQLite (`packages/opencode/src/team/team.sql.ts`, `packages/core/src/team/ownership.sql.ts`): team, member, task, message, per-recipient delivery rows, usage events, and path reservations. SQLite WAL and `busy_timeout=5000` already support several writers on one host.
- All liveness is in-memory and process-local: `EventV2Bridge` bus, parks (`Deferred`), `runningMembers`, the write-lease semaphore registry in `packages/opencode/src/team/file-ownership.ts:263`, and event `wake`.
- A real OS-process bootstrap already exists and is the pattern to copy: the SDK cross-spawns `oc2 serve` (`packages/sdk/js/src/server.ts` `createOc2Server`), the CLI daemon spawns detached `serve --register` (`packages/cli/src/services/daemon.ts`), and the TUI spawns a `Bun.Worker` with role env `OC2_PROCESS_ROLE=worker` / `OC2_RUN_ID` (`packages/core/src/util/opencode-process.ts`). The server entry is `packages/opencode/src/index.ts` command dispatch (`serve` etc.).
- The HTTP app server exists: `Server.listen` in `packages/opencode/src/server/server.ts` (Effect `HttpApi`, routes under `packages/opencode/src/server/routes/instance/httpapi/groups/*`), SSE endpoint patterns, and Basic auth via `OC2_SERVER_PASSWORD` / `OC2_SERVER_USERNAME`.
- The `/team` HTTP group (`groups/team.ts`) is read-only plus `shutdown`. There is no remote mutation surface, no member identity mode, no cross-process wake.
- Session events are JSON-safe and already sync across processes: `EventTable` / `EventSequenceTable` plus `/sync` replay/steal in `packages/core/src/event*` and `groups/sync.ts`. The canonical projector that writes `MessageTable` / `PartTable` lives in `packages/core/src/session/projector.ts`.
- Existing specs defer this work: `specs/team-lead-finalization-barrier.md:184`, `specs/agent-team-reliability-improvements.md:221`, and `specs/proposals/event-driven-lead-waiting.md:42,125,214`.
- SDK and OpenAPI are generated: run `./packages/sdk/js/script/build.ts` (from `packages/sdk/js`) whenever HTTP endpoints change.

## Non-Negotiables

- Keep the durable schema and every current invariant: one active team per lead (`team_active_lead_session_idx`), revision increments once per material transaction, terminal statuses `completed | cancelled | failed`, two-attempt generation rules, per-recipient mailbox claims, owned-path reservations, protocol-1 final-report gate, plan-mode overlay, nested-team prevention.
- Do not redesign tools or authorization. The 13 `team_*` tools and lead-only checks keep their names, shapes, and behavior.
- Default mode (`experimental.team_multiprocess` absent or `false`) must reproduce current behavior with current tests unchanged.
- No new polling. Liveness stays event-driven: SSE replaces the in-memory bus for members; the lead's finalization barrier keeps its in-process listeners.
- The lead process remains the lifecycle owner and settle authority. Settlement uses the existing durable terminal-result extractor against the lead DB.
- Do not add a second database authority. Cross-VM is supported without shared storage; transcript sync uses JSON session events.
- Explicitly out of scope in the first pass: remote file-workspace sync, TLS, mDNS discovery, control-plane failover, and the file write-lease across separate hosts (already documented as in-process).

## Design

### Roles And Process Model

- **Lead process.** Existing OC2 instance. Hosts the lead session, the reconciler, the control-plane HTTP server, and the authoritative SQLite store.
- **Member process.** One headless OC2 instance per teammate, spawned by the lead on `team_spawn` when the flag is on. Runs the standard `SessionPrompt` loop and tools in its own process against a **local transcript mirror** (own SQLite in its own data directory). All team coordination crosses the control plane; it never opens the lead DB.
- **Control plane.** New HTTP endpoints on the lead server plus one SSE stream per member. It is the only bridge between member processes and the authoritative store.

### Member Bootstrap And Identity Contract

Add a `teammate` value to the process-role mechanism in `packages/core/src/util/opencode-process.ts` and a headless entry in `packages/opencode/src/index.ts` command dispatch (mirror `serve`/`run` loading). Spawn uses `cross-spawn` on the current executable (same pattern as `createOc2Server`).

Environment contract for a spawned member:

```
OC2_PROCESS_ROLE=teammate
OC2_TEAM_LEAD_URL=http://<host>:<port>     # control plane base URL
OC2_TEAM_ID=<team id>
OC2_TEAM_MEMBER_SESSION_ID=<session id>    # authoritative recipient identity
OC2_TEAM_SECRET=<per-member credential>    # Basic auth to control plane
OC2_DB=<member-local sqlite path>          # transcript mirror, never the lead DB
OC2_CONFIG_CONTENT=<inline config>         # provider/model config for this process
```

The lead generates `OC2_TEAM_SECRET` at spawn and persists a hash on the `team_member` row (add column in a migration under `packages/core/migration/`). Server auth reuses `middleware/authorization.ts`; the credential maps to exactly one member session.

### Control-Plane Surface

All endpoints mount on the existing `TeamApi` group (`server/routes/instance/httpapi/groups/team.ts`) and reuse `InstanceContextMiddleware`, `WorkspaceRoutingMiddleware`, `Authorization`. The server handlers call the existing `Team.Service` and event logic unchanged; they add a transport, not new business rules.

| Method / Path | Purpose |
| --- | --- |
| `GET /team/:teamID/members/:sessionID/context` | Pre-run fetch: role prompt, agent, model, permission, message history up to a `messageID`. |
| `POST /team/:teamID/members/:sessionID/run` | Deliver a run request to a member (persisted instruction + wake). |
| `POST /team/:teamID/members/:sessionID/result` | Member reports terminal completion/cancel/failure plus transcript cursor; lead settles and notifies. |
| `POST /team/:teamID/members/:sessionID/heartbeat` | Liveness for long daemon idles. |
| `GET /team/:teamID/members/:sessionID/events` | SSE push channel: run request, wake, pause/cancel, new mail, plan decision. |
| `POST /team/:teamID/messages`, `/messages/claim`, `/messages/:id/ack`, `/messages/:id/release` | Remote mailbox mutations equivalent to `sendMessage`, `claimPendingMessages`, `markMessageDelivered`, `releaseClaimedMessages`. |
| `POST /team/:teamID/tasks/:id/claim`, `/tasks/:id/update` | Remote task mutations equivalent to the existing task tools. |
| `POST /team/:teamID/members/:sessionID/plan/:submitOrDecide` | Plan-mode submit and decide over the wire. |
| `POST /team/:teamID/transcript/sync` | Push member-local session events; lead projects them with the existing projector. |
| `POST /team/:teamID/shutdown` | Extend the existing endpoint to also terminate member processes. |

Errors reuse the explicit `Schema.ErrorClass` contracts required by `httpapi/AGENTS.md`; translate domain errors at the handler boundary. Regenerate the SDK after any endpoint change.

### Wake And Event Semantics

- Member processes park on their SSE stream instead of an in-memory `Deferred`. `registerPark`/`signalPark` in `SessionRunState` remain for local mode; a new `SSE member park` adapter awaits the next pushed event.
- The lead's finalization barrier is untouched. Member completion arrives as an in-process `team.member.updated` because settlement runs in the lead.
- Mailbox sends from one member to another are written to the lead DB, then the lead pushes an SSE wake to the parked recipient member.
- Lead-to-member wake waits stay bounded (1 s) for lead-initiated tools; member-initiated delivery stays asynchronous. Keep `LEAD_WAKE_TIMEOUT`.

### Single-Winner Member Start

The reconciler keeps ownership of lifecycle state. `runningMembers` remains an in-memory optimization only for the local path. For the remote path, admission uses the durable `team_member.run_generation` CAS plus `SessionTable.metadata["lifecycleTeamMember"]` so a crashed reconciler restarts a member exactly once and a stale settlement changes nothing.

### Transcript Mirror And Session Content

- Before a run, the member fetches `context`, replays the relevant message history into its local mirror SQLite, and runs the standard loop. No `Session.Service` or projector changes.
- During the run the loop reads and writes only its local mirror, so all prompt-loop code is unchanged.
- On run end, the member pushes its new session events to `/transcript/sync`; the lead projects them with the existing `SessionProjector`, then runs the existing terminal-result extractor and `settleMember`. Deterministic terminal extraction and crash recovery therefore read the same durable rows they read today.
- This limits mid-run visibility of a remote member transcript. Optional live visibility is Future Work; it does not affect settlement.

## Implementation Slices

### PR 1: Feature Flag, Member Identity Contract, And Spawn Skeleton

- Add `experimental.team_multiprocess` (`Schema.optional(Schema.Boolean)`) to `packages/core/src/v1/config/config.ts`, default `false`.
- Add `teammate` to `OC2_PROCESS_ROLE` and define the member env contract constants in `packages/core/src/util/opencode-process.ts`.
- Add the headless member command entry in `packages/opencode/src/index.ts` (`commandLoaders`) that boots a minimal instance, validates its env, connects to the control plane, and exits cleanly when the connection is refused.
- Add a migration under `packages/core/migration/` storing a per-member credential hash on `team_member`.

Verification:

- `bun test test/team/team.test.ts test/tool/team_spawn.test.ts`
- `bun test test/session/lifecycle-reconciler.test.ts`
- `bun run typecheck` (in `packages/opencode`)
- Manually: start lead server, run the member binary with a bad `OC2_TEAM_LEAD_URL`, confirm a typed connection error and clean exit.

Review:

A fresh read-only reviewer checks that no existing team or reconciler test changed behavior, that the flag gates nothing yet, and that the env contract matches the spawner defined in PR 3.

### PR 2: Control-Plane HTTP Endpoints And SDK Regeneration

- Add the endpoints from the table above to `TeamApi`, wrapping existing `Team.Service` and reconciler methods with the same authorization and revision semantics.
- Add the SSE member stream with heartbeat and reconnection; reuse the SSE patterns from `groups/event.ts`.
- Add typed client calls in `packages/sdk/js/src/v2/client.ts` and regenerate: `bun ./script/build.ts` from `packages/sdk/js`.
- Extend `test/server/httpapi-team.test.ts` with authorization, outsider rejection, terminal-recipient rejection, and exactly-once mailbox claims over HTTP.

Verification:

- `bun test test/server/httpapi-team.test.ts`
- `bun test test/team/team.test.ts test/tool/team_messages.test.ts test/tool/team_tasks.test.ts`
- `bun run typecheck` (in `packages/opencode` and `packages/sdk/js`)

Review:

The reviewer runs the listed suites, then inspects the OpenAPI diff (`git diff packages/sdk/js/openapi.json` if checked in, else the generated `src/v2/gen/*`) to confirm the new endpoints exist and no endpoint changed shape.

### PR 3: Remote Team Service Client For Member Processes

- Provide a remote implementation of the `Team.Service` interface used by the 13 team tools (mailbox, tasks, plan, report/shutdown reads) that calls the control-plane endpoints instead of the local DB.
- Select local vs remote `Team.Service` by process role at the layer boundary in `packages/opencode/src/effect/run-service.ts`.
- Server-side handlers for mailbox/task/plan endpoints must reuse the exact service methods the tools call today, preserving revision bumps and atomic delivery claims.
- Add tests that run the existing tool handlers against the remote service over loopback HTTP and assert identical outcomes to the local service (claim exactly once, terminal-recipient rejection, revision bump on send only).

Verification:

- `bun test test/tool/team_messages.test.ts test/tool/team_tasks.test.ts test/tool/team_plan_submit.test.ts test/tool/team_plan_decide.test.ts` (plus remote-backed variants)
- `bun test test/team/team.test.ts`
- `bun run typecheck`

Review:

A reviewer confirms the local path is untouched (same default layers), the remote client implements the full interface used by tools, and no tool handler changed.

### PR 4: Member Process Run Loop With Transcript Sync

- Implement member process execution: fetch `context`, hydrate the local mirror, run the standard `SessionPrompt` loop, push `/transcript/sync`, and report the terminal result.
- Spawn the member from the lead: when `experimental.team_multiprocess` is on, `team_spawn` and the reconciler start a member process instead of an in-process fiber; admission uses the durable `run_generation` CAS.
- Implement the lead-side `/result` handler: project synced events, extract the canonical terminal result with the existing extractor, run `settleMember`, and publish the canonical notification (one atomic transaction, one revision bump).
- Add an integration test that spawns a real child teammate process on loopback, runs one task member to terminal, and asserts the lead receives a canonical notification and the parked lead's finalization barrier releases.

Verification:

- New integration test (e.g. `packages/opencode/test/team/multiprocess-member.test.ts`)
- `bun test test/session/lifecycle-reconciler.test.ts test/session/prompt.test.ts` (barrier + crash-window suites)
- `bun run typecheck`

Review:

The reviewer checks the crash-window invariants: stale generation settlement changes nothing, blank generation-2 output fails with `empty_result`, and one notification + one revision bump per terminal transition.

### PR 5: Cross-VM Deployment And Default Decision

- Add lead control-plane host/port and secret plumbing to `team_spawn` (env contract from PR 1) so a member may run on a different VM; document provider/model config requirements for the member host.
- Harden SSE wake (reconnect, bounded waits) and heartbeat-based member liveness with durable failure handling for lost members.
- Add a two-process, two-data-directory harness test using separate loopback hosts that exercises spawn, run, mailbox wake across processes, daemon idle, and shutdown.
- Update `packages/opencode/src/team/README.md` and the user-facing team documentation to describe the process model and transport.

Verification:

- New multi-host harness test under `packages/opencode/test/team/`
- `bun test test/tool/team_spawn.test.ts test/tool/team_shutdown.test.ts test/tool/team_report.test.ts`
- `bun run typecheck`
- Decide and record whether `experimental.team_multiprocess` becomes the default; do not flip it in this PR without the harness green.

Review:

A reviewer checks the daemon lifecycle (idle between wakes, shutdown cancels), the final-report gate, and that no durable semantics changed on the wire.

## Future Work

- Live mid-run transcript visibility for remote members via streamed event sync.
- Distributed file-workspace access and cross-host write leases.
- TLS, mDNS discovery, and control-plane failover.
- Provider/model call proxying so a member VM needs no provider credentials.

## Open Questions

- Provider credentials on a member VM: pass them via `OC2_CONFIG_CONTENT` and member env, or proxy model calls through the lead? Default: pass config content; proxy calls are Future Work.
- Transcript sync frequency: end-of-run only (default, matches settlement needs) or periodic mid-run sync for visibility?
- Should the control-plane endpoints live under the existing `/team` root or a new `/team/v1` root? Default: extend the existing root to avoid a second route tree.
- Flip `experimental.team_multiprocess` to `true` as the default after PR 5, or keep it opt-in for one release? Default: keep opt-in until the harness is green in CI.
