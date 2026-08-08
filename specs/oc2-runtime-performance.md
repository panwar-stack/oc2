# OC2 Runtime CPU And Memory Performance

Status: proposed

## Goal

Reduce validated CPU and memory costs in OC2 without weakening recovery, isolation, authorization, event delivery, or output completeness. Make the smallest independent changes first. Add LSP sharing, instance eviction, queue bounds, and event pruning only after their required identity, lease, and recovery contracts exist.

Correctness gates use deterministic counters and output parity. CPU, resident memory, process footprint, and wall-time checks are manual claim gates. They are not CI merge gates.

## Current State

- `packages/opencode/src/tool/read.ts` calls the spawn-capable `LSP.touchFile` after a text read. A cold read can start a language server.
- `packages/opencode/src/lsp/lsp.ts` stores clients in per-directory `InstanceState`. Its reuse key is the raw root plus server ID. It has no process-wide pool, generation, or active-operation lease.
- `packages/opencode/src/lsp/client.ts` retains full document text and diagnostics. It does not send `textDocument/didClose` or clear all state for a closed document.
- `packages/opencode/src/util/process.ts` stops a direct POSIX child. It does not prove ownership and termination of the full LSP descendant tree.
- The focused LSP baseline recorded by the source audit is 86 passed and 0 failed. This is correctness evidence, not a CPU or footprint baseline.
- `packages/opencode/src/session/lifecycle-reconciler.ts` runs startup recovery and a 500 ms periodic reconcile. Each reconcile loads all project sessions and then all team members before in-memory filtering.
- `packages/core/src/filesystem/search.ts` creates an FFF picker before it waits for scan readiness. Its `file` path can use the picker before readiness. `packages/opencode/src/project/bootstrap.ts` warms FFF for every bootstrapped instance.
- `packages/opencode/src/session/llm.ts` creates and serializes telemetry attributes before it resolves whether a telemetry exporter can consume them.
- `packages/core/src/database/sqlite.bun.ts` already emits Bun SQLite DEBUG, slow, lock-wait, and error diagnostics. It computes `shapeSql()` for every query before the log level and thresholds decide whether a log is needed.
- `packages/opencode/src/session/message-v2.ts` pages the complete newest-first history into memory before the unchanged `filterCompacted` function finds the valid compaction boundary.
- `packages/opencode/src/util/rpc.ts` removes resolved calls, but it has no disposal contract. Listener map keys can remain after the last handler is removed, and transport exit can leave calls pending.
- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts` already reports SSE queue-depth diagnostics. Its event queue is unbounded by event count and serialized bytes.
- `packages/core/src/event.ts` uses unbounded PubSub for the main and typed event streams. Durable and ephemeral traffic is not classified for backpressure.
- `packages/opencode/src/tool/shell.ts` already spills large legacy shell output to a file. It does not await stream drain, and one source chunk can exceed the intended in-memory bound. The core `AppProcess` and V2 bash paths are separate implementations.
- `packages/core/src/background-job.ts` and `packages/opencode/src/background/job.ts` keep process-local job entries without terminal retention or output-byte limits. Restart loses this registry by design.
- `packages/tui/src/context/sync-v2.tsx` already keeps at most 100 recent completed messages plus all active assistant and shell messages. This is an existing regression behavior, not new work.
- Workspace Sync, SSE reconnect, direct replay, and durable event storage do not share one versioned cursor, snapshot, acknowledgement, overflow, and negotiation contract. Old clients consume the current legacy `sync` envelope.
- `packages/core/src/event/sql.ts` stores durable events. Safe pruning does not exist because remote acknowledgement and replay-equivalent snapshots do not exist.

### Historical Diagnostic Baseline

These source-audit observations are diagnostic history only. They are not current measurements, budgets, merge gates, or claim gates.

- One loaded, non-idle PID used 0.8-1.4 GiB RSS and 144-157% CPU.
- Two nested TypeScript roots produced eight Node descendants, a 6.0-6.5 GB shared-page-aware footprint, about 222% active CPU, and 2,978 plus 1,524 file descriptors. CPU later became idle, but the memory remained retained.
- Lifecycle reconciliation loaded 198 sessions plus 123 team members, about 690 KB per pass, every 500 ms.
- Inactive telemetry serialized the message payload twice.
- Bun SQLite shaped about 250 queries per second and accumulated 35.9 MB over 11.5 minutes.
- Three bootstrapped instances eagerly created three FFF stores and watcher sets.
- Sync and SyncV2 both published the same logical changes.
- The sampled database, event, and part-event retainers used 807 MB, 570 MB, and 464 MB.
- Renderer work appeared in only 3 of 176 main-thread samples. It is not a target of this program.

## Non-Negotiables

1. Preserve startup and periodic lifecycle recovery. Dirty signals can reduce latency and query work, but they cannot be the only recovery mechanism. Do not promise zero polling.
2. A cold ReadTool call must not start an LSP. Existing-client warm-up must not create a client or resolve a spawn-capable path.
3. LSP document serialization and owner-scoped result filtering must land before process-wide pooling. Root sharing is opt-in for one audited built-in. Custom servers default to instance scope.
4. Canonical paths are internal identities. User output and permission prompts keep a lexical display path. A symlink cannot expand an owner's authorized roots.
5. A pooled process, instance generation, document, queue entry, or terminal job cannot be deleted while an active lease, owner, waiter, or operation still uses it.
6. Old clients keep the legacy `sync` envelope during negotiation and migration. Do not remove it globally in the first compatibility release.
7. One versioned cursor, snapshot, acknowledgement, overflow, reconnect, and negotiation contract must exist before SSE bounds, Sync deduplication, or event pruning.
8. A bounded transport must define event and byte accounting, backpressure, overflow, reconnect, re-snapshot, and exactly-once settlement. Do not silently slide or drop durable traffic.
9. Shell spill files must contain the complete byte stream. Output must remain valid UTF-8 at the user boundary. Do not combine legacy shell, core `AppProcess`, and V2 bash adoption in one PR.
10. Terminal retention must never evict a running job or a job with a captured waiter. Define `get`, `list`, `wait`, restart, expiry, and output retention before adding limits.
11. Public protocol or config changes update all affected docs, schemas, OpenAPI, generated JS client surfaces, TUI, app, and workspace consumers in the same protocol chain.
12. CI gates use deterministic counters and output parity only. CPU, RSS, shared-page-aware footprint, wall time, `sample`, and process-tree footprint are manual.
13. Values 1024 events, 256 PubSub entries, 100 completed messages, 5 minutes, and 60 seconds are recommended initial defaults. Fixture validation can change them. They are not proven budgets.
14. The provisional manual ratios in this document are claim gates, not merge gates. Do not turn them into CI limits before a pilot proves fixture stability.
15. Do not use root `bun test` or `bun run test`; the root test script intentionally fails. `bench:test` and `profile:test` are broad manual diagnostics only.
16. The first LSP pass adds no public config or status field. If a later LSP slice requires one, update `packages/core/src/config.ts`, `packages/core/src/v1/config/config.ts`, `docs/configuration.md`, `packages/sdk/openapi.json`, both generated JS surfaces, and TUI status handling in that public-change PR.

## Identity, Ownership, And Lifetime Design

### LSP Root And Launch Identity

- Root discovery walks physical parents. It stops at the physical worktree boundary. If the worktree is `/`, it stops at the physical owner directory instead.
- The owner must authorize the requested lexical path before canonicalization. Canonicalization can collapse an authorized symlink, but it cannot grant access to a target outside the owner's registered roots. Existing external-directory permission is required before that target can be opened or returned.
- Store a canonical realpath identity and a separate lexical display-path and URI mapping. Convert canonical server results back to an authorized owner display path when possible. Remove results that cannot be mapped to an authorized root.
- Freeze a launch descriptor before process creation. It contains resolved executable or module, full argv, effective environment, initialization data, flags, server config, root identity, trust identity, and share scope.
- Canonically encode the full descriptor and identify it with process-local HMAC-SHA-256. The HMAC key is random and is not persisted. Logs contain only the fingerprint and an allowlist of non-secret fields. They never contain secret environment or initialization values.
- The default share scope is `instance`. One audited built-in can opt in to `root` only after its launch inputs and cross-owner behavior pass review. Empty custom command or extension hardening is a separate schema change if current config behavior must change.

### LSP Documents And Pool Entries

- Each canonical document has one serialization lane for open, change, request, and close operations.
- Retained document state contains version, end position, owner references, and last activity. It does not contain source text.
- `didClose` is explicit. It clears push diagnostics, pull diagnostics, published versions, listeners, and document state after the final owner releases the document.
- A document can close only when it has no owner reference and no active operation. The recommended initial idle document TTL is 60 seconds, subject to fixture validation.
- A pool entry has `initializing`, `ready`, `closing`, `closed`, or `crashed` state, a generation, a frozen fingerprint, owners, active leases, and last activity.
- Lease acquisition checks state and generation atomically. Release is idempotent and includes entry generation and lease ID. A closing, closed, crashed, or replaced entry cannot be reused.
- The recommended initial ready-entry idle TTL is 5 minutes. Re-acquisition before close cancels idle disposal. A close that already entered process shutdown cannot be cancelled or reused.

### Instance Generations

- Each `packages/opencode/src/project/instance-store.ts` entry has a monotonically changing generation identity. Every HTTP request, SSE stream, runner, job, and background fiber holds a lease for its exact generation.
- New work cannot acquire a closing generation. Existing leased work finishes or is interrupted by an explicit disposal policy. A late release for generation N cannot decrement generation N+1.
- LRU or TTL eviction is allowed only when the current generation has zero leases. Disposal is idempotent and compares both instance key and generation before it removes the store entry.

## Versioned Sync And Delivery Contract

The protocol added by P1-P3 is V2 of the delivery contract. It is separate from the product's V2 session model.

```ts
type DeliveryCursorV2 = {
  version: 2
  stream: string
  epoch: string
  sequence: number
  snapshotID: string
}

type DeliverySnapshotV2 = {
  version: 2
  stream: string
  epoch: string
  snapshotID: string
  through: number
  state: {
    aggregates: Array<{
      aggregateID: string
      aggregateType: string
      schemaVersion: number
      through: number
      payload: unknown
    }>
  }
}

type DeliveryAckV2 = {
  version: 2
  stream: string
  epoch: string
  snapshotID: string
  through: number
  consumerID: string
}

type DeliveryEventV2 = {
  version: 2
  logicalID: string
  cursor: DeliveryCursorV2
  type: string
  properties: unknown
}

type ResyncRequiredV2 = {
  version: 2
  type: "server.resync_required"
  reason: "event_limit" | "byte_limit" | "cursor_expired" | "epoch_changed"
  lastAcceptedCursor?: DeliveryCursorV2
}
```

- SSE negotiation uses the `delivery_protocol` query. Omission selects legacy protocol 1, the exact value `2` selects protocol 2, and any other explicit value returns HTTP 400. Protocol 2 sends `server.protocol` with version, stream, epoch, and snapshot ID before data events.
- Protocol-2 reconnect uses the `cursor` query or the standard `Last-Event-ID` header. If both exist, they must be byte-identical or the server returns HTTP 400. The SSE `id` is the unpadded base64url encoding of canonical JSON with fields ordered as `version`, `stream`, `epoch`, `sequence`, and `snapshotID`.
- `POST /sync/replica/register` idempotently registers the authenticated workspace replica and returns its stable consumer ID. `POST /sync/replica/deregister` requires the same scope plus explicit administrative or workspace-removal authority. `POST /sync/snapshot` returns `DeliverySnapshotV2`. `POST /sync/ack` accepts `DeliveryAckV2` only when its consumer ID matches the authenticated active registration. Protocol-2 `POST /sync/history` accepts the same cursor. A cursor and consumer ID are scoped and schema-validated; they do not grant access.
- `sequence` is a globally ordered durable delivery sequence in one stream and epoch. Allocate it in the same transaction that stores a durable event. Process restart keeps the epoch and sequence. A database restore, incompatible reset, or explicit epoch rollover changes the epoch.
- Ephemeral events use the most recent durable cursor and do not advance acknowledgement or pruning state. Reconnect can omit ephemeral history. The following snapshot must contain all durable state needed for correctness.
- A snapshot is an atomic state image through one sequence in one epoch. The client subscribes before snapshot hydration, buffers later events, applies the snapshot once, and then applies buffered events with sequence greater than `through`.
- Each durable aggregate that can be pruned registers a versioned snapshot codec. The codec output is the `payload` for its `aggregateType`. An aggregate without a tested codec can be delivered and acknowledged, but it cannot be pruned.
- The first named codec is `SessionDeliverySnapshotV1` for the `session` replay aggregate. Its owner is `packages/core/src/session/snapshot.ts`. Its schema contains the session row, ordered legacy message and part rows, ordered V2 session-message rows, pending session-input rows, and session context-epoch state through the snapshot sequence. Every other replay aggregate keeps its event history until its aggregate owner adds an equally named, versioned, differential-tested codec.
- A durable consumer is an authenticated workspace-sync replica with a persisted, stable consumer ID scoped to one workspace and stream. Registration is explicit and idempotent. Only an explicit administrative action or workspace removal can deregister it; disconnect and elapsed time cannot.
- An acknowledgement means that an eligible, registered durable workspace replica has applied the snapshot and all events through its sequence. Acknowledgement is monotonic and idempotent. The server rejects a pruning acknowledgement from an unregistered, deregistered, cross-workspace, or cross-stream consumer.
- TUI, app, and transient SSE resume cursors are not durable replica acknowledgements. They never enter, advance, or block the persisted pruning watermark.
- `logicalID` is stable across dual publication. Only a negotiated protocol-2 consumer deduplicates by this ID. Protocol-1 clients keep the legacy `sync` envelope.
- Queue bytes are `TextEncoder.encode(JSON.stringify(DeliveryEventV2)).byteLength`, computed once before enqueue. SSE framing and transport compression are not part of the queue-byte count.
- On overflow, stop accepting entries, settle every accepted entry exactly once as delivered or aborted, send one terminal `server.resync_required` when the transport is writable, and close. The client discards partial hydration, gets a fresh snapshot, and reconnects from that snapshot.
- Direct replay overflow aborts the replay response and returns the same resync-required reason. It has an independent event and byte limit.
- Durable core events use bounded backpressure after the database commit. Ephemeral events use an explicit coalesce or latest-value rule by event class. Do not block a database transaction on a subscriber.
- Pruning watermark for a stream is at most the stored snapshot `through` and the minimum acknowledgement of all eligible registered durable workspace replicas. If no eligible durable acknowledgement exists, do not prune. Persist the snapshot and watermark before deletion in one recoverable order.

## Performance Measurement Design

### Deterministic CI Checks

Focused tests report or assert seeded counters for query count, rows and bytes decoded, logical event multiplicity, queue peak event count, queue peak bytes, overflow count, LSP spawn and stop count, descendant count, retained bytes, and output hash. Use a small fixture and a fixture with 10 times more unrelated data. Active-row and active-operation counters must stay equal between the two fixture sizes.

Binding gates:

- ReadTool: a cold text read calls no spawn-capable `touchFile` and starts zero servers. A first-page text read can call `warmFile` once only when a compatible client already exists. Later pages and non-text reads do not warm.
- Lifecycle: candidate-query count is at most `ceil(fakeElapsed / sweepInterval) + 1`; recovered state has zero candidate rows, zero full session or member scans, and no overlapping reconcile. Ten times more unrelated rows does not change active-row counters.
- Pagination: the named marker-in-first-page fixture decodes at most one page. The general algorithm can read more pages. Output must match the unchanged pure filter for stale, failed, repeated, forked, and `tail_start_id` histories.
- Telemetry: when the resolved telemetry-active predicate is false, message serialization is zero bytes. When true, attributes serialize once and keep the current shape and redaction.
- Bun SQLite: 1,000 fast queries with DEBUG off do zero shape work and zero per-query logs. Slow, lock-wait, and error paths keep current thresholds and redaction.
- Negotiated protocol 2: 100 mutations produce 100 unique logical IDs. Dual publication can continue during migration.
- FFF: inactive instances create zero pickers and watchers. First use returns complete results. Resources return to zero after instance disposal or the selected TTL.
- V2 TUI history: retain at most 100 completed messages and all active or incomplete messages. Active entries are exempt from a strict total cap.
- Queue fixtures block the consumer, enqueue `limit + 1`, and test event and serialized-byte limits independently. They prove one overflow, no silent drop, and exactly-once settlement.
- LSP: `<=4` Node descendants applies only to a pinned single-server, single-root fixture. Zero descendants after disposal is a correctness gate and includes disposal during initialization.

### Manual macOS Claim Protocol

`perf/runtime/macos_ab.py` and its tests do not exist. M2 adds them as new work. No CPU, RSS, footprint, or wall-time claim is valid before that PR passes its own tests and a pilot proves fixture stability.

- Preserve immutable A and B artifacts. Record revision, clean-state result, SHA-256, byte size, build command, Bun version, Node version, macOS version, architecture, harness revision, fixture, and timeout.
- Give each arm an isolated but equivalent `HOME`, XDG, cache, and config snapshot. Do not share writable state across arms or pairs.
- Run two warm-ups per arm. Then run 10 measured pairs in a recorded seeded order with exactly five AB and five BA pairs.
- For pair `i`, compute `ratio_i = B_i / A_i`. The reported ratio is the median of the 10 paired ratios. Require strict `B < A` in at least 7 of 10 pairs.
- A missing, timed-out, non-finite, zero-denominator, or otherwise invalid arm fails the complete run. Do not replace or silently rerun a pair.
- Use `/usr/bin/footprint` as the shared-page-aware authority. Invoke `/usr/bin/footprint --format bytes --noCategories --pid <pid> ...` once with the captured root and every descendant PID so shared regions are counted once. Parse the final `Summary Footprint: <bytes> B` value. For a one-process tree, parse that process header's `Footprint: <bytes> B` value. Store it as `summary_footprint_bytes` and keep raw output as an artifact.
- Protect against PID reuse by identifying every process with PID and kernel start time. Capture the full descendant tree before the sample and revalidate each identity before footprint collection. An identity change invalidates the pair.
- Raw per-process RSS is diagnostic only. It is not the footprint gate.
- Provisional claim gates are median CPU or wall-time ratio `<=0.80`, pinned LSP aggregate footprint ratio `<=0.75`, and long-run aggregate footprint ratio `<=0.80`, with the 7-of-10 strict-win rule.
- These ratios are not merge gates until a pilot records stable variance. Memory slope stays exploratory. Do not use `B <= 25% of A` when A can be zero or negative. Define workload, estimator, cadence, warm-up cut, and zero-baseline rule before a slope gate.
- `bun run --cwd packages/opencode bench:test`, `BENCH_WARMUPS=1 BENCH_RUNS=3 bun run --cwd packages/opencode bench:test`, `bun run --cwd packages/opencode profile:test`, and `TEST_PROFILE_GLOB='test/server/**/*.test.ts' TEST_PROFILE_TOP=15 bun run --cwd packages/opencode profile:test` are manual diagnostics only. Do not use `BUN_OPTIONS=--cpu-prof` for the compiled binary; the audit found that it was ignored.

### Manual Workload Definitions

M2 adds these manifests as new files. They are not working commands in the current repository.

- `idle-lifecycle`: start the compiled artifact on a local fixture with zero lifecycle candidates and 10,000 unrelated sessions and members. Warm both arms, then hold for 10 minutes with no requests. The scalar is total user plus system CPU seconds for the root and descendants. This fixture supports the provisional `<=0.80` CPU ratio only.
- `lsp-sharing`: use the pinned audited built-in, one canonical root, eight instance owners, and 20 fixed text documents. Open all documents, wait for readiness, and hold for 5 minutes. The scalar is one `summary_footprint_bytes` value for the full root and descendant tree. This fixture supports the provisional `<=0.75` LSP footprint ratio only.
- `runtime-churn`: use only local fixtures and a fake LSP. Run 100 fixed-seed rounds. Each round creates and disposes 10 instance directories, performs one FFF first search, opens and closes 20 documents, and opens and closes one SSE connection. Record footprint after every 10 rounds. The scalar is the maximum post-round footprint after round 20. The paired wall-time scalar is harness monotonic time for all 100 rounds. These support provisional `<=0.80` long-run footprint and wall-time ratios.
- Record operation counts and output hashes with each manual sample. A count or hash mismatch invalidates the arm before ratio calculation.

## Explicit Failure Behavior

- If telemetry activity cannot be resolved safely, treat telemetry as active and preserve existing serialization and redaction.
- If a lifecycle dirty signal is lost, startup or periodic recovery must reconcile the durable row. Concurrent triggers coalesce; they do not overlap.
- If a compacted history marker is invalid or not yet found, continue paging. If no valid boundary exists, return the unchanged pure-filter result.
- RPC disposal rejects all pending calls with a typed disposed or transport-closed error, clears pending and listener maps, detaches the target handler, and rejects new calls. Repeated disposal is a no-op.
- If shell spill creation, write, drain, close, or final read fails, fail the tool with a clear error. Do not advertise a partial file as full output.
- If LSP initialization, root authorization, fingerprint creation, or owner mapping fails, do not pool the entry or return the result. Stop the owned process tree.
- LSP shutdown sends protocol shutdown and exit when initialization reached that state. Then send TERM, wait up to 2 seconds, send KILL, and await parent and descendants. Disposal during initialization follows the same bounded path.
- On Windows, use a tested descendant-tree or job-object-backed cleanup path. If ownership cannot be proved, fail initialization instead of killing an unowned process.
- If an instance is closing, reject new leases. A late generation release cannot dispose or mutate the replacement generation.
- If an SSE or replay bound is crossed, close and require re-snapshot. Do not continue from a known incomplete cursor.
- If a terminal job is expired, `get` returns not found, `list` omits it, and `wait` returns not found. A process restart has the same result because the current registry is process-local. Running jobs and captured waiters are never expired.
- If snapshot, acknowledgement, or pruning state is missing or inconsistent, do not delete durable events.

## Implementation Slices

Run all commands from the repository root. Add every named new test before running its command. A command that names a proposed new file is not available until that PR adds the file.

`bun run check:generated` is broad and regenerates files. Run it only in P2b and P8, after `./packages/sdk/js/script/build.ts` regenerates OpenAPI and both JS client surfaces.

### Mandatory Fresh Read-Only Review

After every PR below, a fresh reviewer who did not implement or advise on that PR receives the PR goal, changed paths, test results, and complete diff. The reviewer does not edit. Self-review does not pass. Run:

```sh
git status --short
BASE="$(git merge-base HEAD origin/main)"
git diff --check "$BASE"...HEAD
git diff --stat "$BASE"...HEAD
git diff --no-ext-diff --unified=80 "$BASE"...HEAD
```

Fix all findings, rerun verification, and use a different fresh reviewer for the new diff. Each Review item below means this exact gate.

### Phase 0: Measurement Foundation

#### PR M1: Deterministic Runtime Counter Fixtures

- Paths: add `perf/runtime/README.md`, `packages/opencode/test/fixture/perf.ts`, `packages/opencode/test/fixture/perf.test.ts`, `packages/core/test/fixture/perf.ts`, `packages/core/test/fixture/perf.test.ts`, `packages/tui/test/fixture/perf.ts`, and `packages/tui/test/fixture/perf.test.ts`.
- Define seeded small and 10-times-unrelated fixture helpers and typed counters only. Do not add a product behavior change or a CPU/RSS gate.
- Document the binding CI counters and manual-only metrics from this specification. Domain PRs add domain assertions to focused tests.
- Do not cite `packages/opencode/script/perf-runtime-contract.ts`; it does not exist and is not part of this plan.

Verification:

- `bun run --cwd packages/opencode test test/fixture/perf.test.ts --timeout 30000 && bun run --cwd packages/core test test/fixture/perf.test.ts && bun run --cwd packages/tui test test/fixture/perf.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck && bun run --cwd packages/core typecheck && bun run --cwd packages/tui typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify deterministic seeds, 10-times-unrelated scaling, counter reset, and any accidental wall-clock or process-memory CI gate.

#### PR M2: Manual macOS A/B Harness

- Paths: add `perf/runtime/macos_ab.py`, `perf/runtime/test_macos_ab.py`, `perf/runtime/fixtures/footprint/valid.txt`, `perf/runtime/fixtures/footprint/shared.txt`, `perf/runtime/fixtures/footprint/invalid.txt`, `perf/runtime/fixtures/workloads/idle-lifecycle.json`, `perf/runtime/fixtures/workloads/lsp-sharing.json`, and `perf/runtime/fixtures/workloads/runtime-churn.json`.
- Implement the exact manual protocol above, including immutable artifacts, isolated equivalent state, balanced pair order, invalid-run handling, full-tree PID identity, and `summary_footprint_bytes` parsing.
- This tooling PR is not a prerequisite for deterministic correctness PRs. It is required before a CPU, wall-time, RSS, or footprint claim.

Verification:

The commands below become available after this PR adds the files.

- `mkdir -p tmp/pycache && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m py_compile perf/runtime/macos_ab.py perf/runtime/test_macos_ab.py`
- `PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m unittest perf.runtime.test_macos_ab`

Review: Run the Mandatory Fresh Read-Only Review. Falsify AB/BA balance, invalid-arm failure, artifact immutability, state isolation, PID reuse checks, descendant aggregation, and ratio math.

### Phase 1: Independent Low-Risk Work

#### PR Q1: Telemetry-Active Serialization Gate

- Paths: update `packages/opencode/src/session/llm.ts` and `packages/opencode/test/session/llm.test.ts`.
- Define one resolved telemetry-active predicate from the config flag and an exporter or tracer that can consume attributes. Skip attribute construction, span annotation, proxy creation, and message serialization only when that predicate is false.
- Preserve enabled attribute shape, serialization count, and current redaction. Test flag/exporter combinations and the fail-safe active fallback.

Verification:

- `bun run --cwd packages/opencode test test/session/llm.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify the predicate matrix, zero inactive bytes, exactly one enabled serialization, and redaction parity.

#### PR Q2: Lazy Bun SQLite SQL Shaping

- Paths: update `packages/core/src/database/sqlite.bun.ts`, `packages/core/src/util/log.ts`, and `packages/core/test/database-sqlite.test.ts`.
- Add or use a log-level predicate. Compute `shapeSql()` only for DEBUG, slow, lock-wait, or error logging.
- Preserve Bun thresholds: 250 ms INFO, 1,000 ms WARN, and 500 ms lock-wait WARN. Preserve error diagnostics and SQL literal redaction. Do not claim Node SQLite parity or add aggregate-per-shape work.

Verification:

- `bun run --cwd packages/core test test/database-sqlite.test.ts`
- `bun run --cwd packages/core typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify the 1,000-fast-query zero-work gate and all existing slow, lock, error, and redaction paths.

#### PR Q3: Compaction-Aware Message Paging

- Paths: update `packages/opencode/src/session/message-v2.ts` and `packages/opencode/test/session/messages-pagination.test.ts`.
- Keep public `stream` behavior. Page newest-first in batches of 50 until the valid compaction boundary and any `tail_start_id` are available. Then call the unchanged pure `filterCompacted` logic.
- Add differential fixtures for stale, failed, repeated, fork-remapped, multi-page, and missing `tail_start_id` histories.

Verification:

- `bun run --cwd packages/opencode test test/session/message-v2.test.ts test/session/messages-pagination.test.ts test/server/session-messages.test.ts test/v2/session-message-updater.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Compare old and new outputs and falsify the named one-page fixture without applying that bound to general histories.

#### PR Q4: RPC Disposal And Listener Cleanup

- Paths: update `packages/opencode/src/util/rpc.ts` and `packages/opencode/src/cli/cmd/tui.ts`; add `packages/opencode/test/util/rpc.test.ts`; update the existing TUI worker shutdown test in `packages/opencode/test/cli/tui/thread.test.ts`.
- Delete a listener map key when its last handler is removed. Add idempotent client disposal that rejects and clears all pending calls and listeners and detaches `target.onmessage`.
- Wire worker error/exit and TUI shutdown to disposal. Keep timeout, `AbortSignal`, request cancellation, and pending-count limits for later PRs.

Verification:

- `bun run --cwd packages/opencode test test/util/rpc.test.ts test/cli/tui/thread.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Race result, exit, disposal, repeated disposal, listener removal, and a late message. Prove every pending call settles once.

#### PR Q5: Complete Legacy Shell Spill

- Paths: update `packages/opencode/src/tool/shell.ts` and `packages/opencode/test/tool/shell.test.ts`.
- Split an oversized source chunk before it enters the in-memory preview. Serialize spill writes, await drain, and await final close.
- Preserve the complete spill-file byte stream, valid UTF-8 user output, metadata, timeout, abort, and current tail display. Do not change `packages/core/src/process.ts` or `packages/core/src/tool/bash.ts`.

Verification:

- `bun run --cwd packages/opencode test test/tool/shell.test.ts test/shell/shell.test.ts test/pty/pty-shell.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Use output hashes to falsify chunk loss, reorder, ignored drain, UTF-8 split, timeout, abort, and spill failure behavior.

#### PR Q6a: Lifecycle Candidate Query Plan And Conditional Index

- Paths: add the query-plan fixture to `packages/opencode/test/session/lifecycle-reconciler.test.ts`. If required by `EXPLAIN QUERY PLAN`, update `packages/opencode/src/team/team.sql.ts`, add `packages/core/src/database/migration/20260808000000_add_lifecycle_candidate_indexes.ts`, and update `packages/core/test/database-migration.test.ts`.
- First prove the exact candidate predicate and query plan. Add only the index that removes a full table scan for that predicate. If existing indexes are sufficient, omit the schema and migration changes.
- Do not change reconcile scheduling in this PR.

Verification:

- `bun run --cwd packages/opencode test test/session/lifecycle-reconciler.test.ts --timeout 30000`
- `bun run --cwd packages/core test test/database-migration.test.ts && bun run --cwd packages/opencode typecheck && bun run --cwd packages/core typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Inspect the plan, predicate selectivity, migration order, rollback compatibility, and 10-times-unrelated fixture.

#### PR Q6b: Indexed Lifecycle Candidate Reconcile

- Paths: update `packages/opencode/src/session/lifecycle-reconciler.ts` and `packages/opencode/test/session/lifecycle-reconciler.test.ts`.
- Query only sessions and members that can require recovery. Prevent overlapping reconcile calls. Keep startup recovery and the 500 ms periodic sweep unchanged.
- Assert candidate-query count, active rows, no full scans, output parity, and no duplicate member start or notification.

Verification:

- `bun run --cwd packages/opencode test test/effect/instance-state.test.ts test/project/instance.test.ts test/project/instance-bootstrap.test.ts test/session/lifecycle-reconciler.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify missed states, cross-process recovery, overlap, unrelated-row scaling, and exactly-once settlement.

#### PR H1: V2 Completed-History Regression Gate

- Paths: update `packages/tui/test/cli/tui/sync-v2.test.tsx`. Change `packages/tui/src/context/sync-v2.tsx` only if the test finds a defect.
- Prove the existing rule: at most 100 completed messages plus every active or incomplete assistant and shell message. Do not introduce a strict total cap.

Verification:

- `bun run --cwd packages/tui test test/cli/tui/sync-v2.test.tsx --timeout 30000`
- `bun run --cwd packages/tui typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify active-message eviction, out-of-order completion, hydration merge, and repeated event behavior.

### Phase 2: LSP Dependency Chain

#### PR L1: Existing-Client-Only ReadTool Warm-Up

- Paths: update `packages/opencode/src/tool/read.ts`, `packages/opencode/src/lsp/lsp.ts`, and `packages/opencode/test/tool/read.test.ts`; update stubs in `packages/opencode/test/tool/lsp.test.ts`.
- Add `LSP.warmFile` that looks up a compatible ready client without root discovery or spawn. ReadTool can call it once after a first-page text read only.
- Later pages, directories, images, PDFs, binaries, and a cold client set do not warm.

Verification:

- `bun run --cwd packages/opencode test test/tool/read.test.ts test/tool/lsp.test.ts test/lsp/index.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Instrument every spawn-capable path and prove a cold read has zero `touchFile` calls and zero starts.

#### PR L2: Physical LSP Root Boundary

- Paths: add `packages/opencode/src/lsp/root.ts` and `packages/opencode/test/lsp/root.test.ts`; update `packages/opencode/src/lsp/server.ts` and `packages/opencode/test/lsp/jdtls-root.test.ts`.
- Move root discovery behind one physical-parent search. Stop at physical worktree, or physical owner directory when worktree is `/`.
- Reject a marker found only above the boundary. Keep each built-in's existing marker priority inside the boundary.

Verification:

- `bun run --cwd packages/opencode test test/lsp/jdtls-root.test.ts test/lsp/root.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify lexical `..`, nested worktrees, filesystem root, symlink parents, missing markers, and marker priority.

#### PR L3: Canonical LSP Identity And Display Mapping

- Paths: update `packages/opencode/src/lsp/root.ts`, `packages/opencode/src/lsp/lsp.ts`, `packages/opencode/src/lsp/client.ts`, `packages/opencode/test/lsp/root.test.ts`, and `packages/opencode/test/lsp/client.test.ts`.
- Add canonical realpath identity plus lexical display-path and file-URI mapping. Enforce the symlink and external-directory rule before server access.
- Do not yet share clients across instances.

Verification:

- `bun run --cwd packages/opencode test test/lsp/client.test.ts test/lsp/index.test.ts test/lsp/root.test.ts test/tool/lsp.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify alias collisions, unauthorized symlink targets, URI round trips, case behavior on supported filesystems, and display-path leaks.

#### PR L4: Frozen LSP Launch Fingerprint

- Paths: update `packages/opencode/src/lsp/launch.ts`, `packages/opencode/src/lsp/lsp.ts`, and `packages/opencode/test/lsp/launch.test.ts`.
- Build and freeze the complete descriptor and process-local HMAC fingerprint before spawn. Include resolved argv, environment, initialization, binary or module resolution, flags, config, trust, and share scope.
- Test that one changed input changes identity. Test that logs do not contain environment or initialization secrets.

Verification:

- `bun run --cwd packages/opencode test test/lsp/launch.test.ts test/config/lsp.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify omitted descriptor fields, mutable inputs, secret logs, nondeterministic ordering, and unsafe custom-server sharing.

#### PR L5: Branded LSP Process-Tree Shutdown

- Paths: update `packages/opencode/src/lsp/launch.ts`, `packages/opencode/src/lsp/client.ts`, and `packages/opencode/src/util/process.ts`; add `packages/opencode/test/util/process.test.ts` and `packages/opencode/test/fixture/process-tree.ts`; update `packages/opencode/test/lsp/lifecycle.test.ts`.
- Brand each owned LSP process or process group. Implement protocol shutdown and exit, TERM, a 2-second wait, KILL, and parent-plus-descendant exit proof.
- Cover normal close, initialization failure, disposal during initialization, repeated close, descendant escape attempts, and Windows cleanup.

Verification:

- `bun run --cwd packages/opencode test test/lsp/client.test.ts test/lsp/launch.test.ts test/lsp/lifecycle.test.ts test/util/process.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify brand ownership, TERM-to-KILL bounds, parent-only exit, PID reuse, initialization races, and unowned-process termination.

#### PR L6: Serialized LSP Document Lifetime

- Paths: update `packages/opencode/src/lsp/client.ts`, `packages/opencode/src/lsp/lsp.ts`, `packages/opencode/test/lsp/client.test.ts`, and `packages/opencode/test/lsp/lifecycle.test.ts`.
- Serialize operations per canonical document. Stop retaining source text; retain only version, end position, owners, and activity.
- Add explicit `didClose` and complete document and diagnostic cleanup after the final owner and active operation release.

Verification:

- `bun run --cwd packages/opencode test test/lsp/client.test.ts test/lsp/index.test.ts test/lsp/lifecycle.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Race open/change/request/close, same-file aliases, repeated close, disconnect, and close during diagnostics.

#### PR L7: Owner-Scoped LSP Result Authorization

- Paths: update `packages/opencode/src/lsp/lsp.ts`, `packages/opencode/src/lsp/client.ts`, `packages/opencode/src/tool/lsp.ts`, `packages/opencode/test/lsp/index.test.ts`, and `packages/opencode/test/tool/lsp.test.ts`.
- Filter diagnostics and every path-bearing result or metadata field against the requesting owner's roots. Map authorized canonical paths to owner display paths.
- Apply the rule to definition, references, implementation, document and workspace symbols, call hierarchy, related diagnostics, and tool metadata.

Verification:

- `bun run --cwd packages/opencode test test/lsp/client.test.ts test/lsp/index.test.ts test/tool/lsp.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Inject unauthorized paths into every result shape and prove they do not reach output, diagnostics, logs, or metadata.

#### PR L8: Process-Wide LSP Pool Infrastructure

- Paths: add `packages/opencode/src/lsp/pool.ts` and `packages/opencode/test/lsp/pool.test.ts`; update `packages/opencode/src/lsp/lsp.ts` and `packages/opencode/test/lsp/lifecycle.test.ts`.
- Add process-wide entries, in-flight launch deduplication, generation-aware active-operation leases, idempotent release, and state transitions. Keep default share scope `instance`.
- Do not add idle TTL or root sharing in this PR.

Verification:

- `bun run --cwd packages/opencode test test/lsp/index.test.ts test/lsp/lifecycle.test.ts test/lsp/pool.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Race concurrent acquire, failure, crash, close, ABA replacement, late release, and instance disposal.

#### PR L9: One Audited Root-Shared Built-In And Idle TTL

- Paths: update `packages/opencode/src/lsp/server.ts`, `packages/opencode/src/lsp/pool.ts`, `packages/opencode/test/lsp/pool.test.ts`, and the selected built-in fixture in `packages/opencode/test/lsp/index.test.ts`.
- Opt in one built-in only after its audit. Keep all other built-ins and custom servers instance-scoped.
- Add the recommended 5-minute ready-entry idle TTL, subject to the fixture. Re-acquisition cancels only a pending idle timer, not an entered close.

Verification:

- `bun run --cwd packages/opencode test test/lsp/index.test.ts test/lsp/lifecycle.test.ts test/lsp/pool.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify cross-trust reuse, TTL ABA, crash, active leases, finalizers, and the pinned `<=4` descendant fixture.

#### PR L10: Independent LSP Document TTL

- Paths: update `packages/opencode/src/lsp/client.ts`, `packages/opencode/src/lsp/pool.ts`, `packages/opencode/test/lsp/client.test.ts`, and `packages/opencode/test/lsp/pool.test.ts`.
- Add the recommended 60-second document TTL, independent of the process TTL and subject to fixture validation.
- A timer cannot close an active operation or multiply-owned document. Close clears all document and diagnostic state.

Verification:

- `bun run --cwd packages/opencode test test/lsp/client.test.ts test/lsp/lifecycle.test.ts test/lsp/pool.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Race owner add/remove, active requests, timer expiry, process close, re-open, and repeated timer delivery.

### Phase 3: Runtime Lifecycle And Instance Chain

#### PR R1: Nonblocking Dirty Signals

- Paths: update `packages/opencode/src/session/lifecycle-reconciler.ts`, `packages/opencode/src/team/events.ts`, and `packages/opencode/test/session/lifecycle-reconciler.test.ts`.
- Emit nonblocking dirty signals after relevant durable commits. Coalesce them into one reconcile request and prevent overlap.
- Keep startup recovery and the 500 ms periodic sweep unchanged. Signal loss must remain recoverable.

Verification:

- `bun run --cwd packages/opencode test test/session/lifecycle-reconciler.test.ts test/team/team-eval.test.ts test/team/team.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify commit-before-signal order, signal storms, lost signals, overlap, and cross-process writers.

#### PR R2: Recovery-Proven Slower Sweep

- Paths: update `packages/opencode/src/session/lifecycle-reconciler.ts` and `packages/opencode/test/session/lifecycle-reconciler.test.ts`.
- Add explicit cross-process and restart recovery fixtures first. Then select a slower periodic interval from the deterministic fake-clock fixture.
- Keep periodic recovery permanently. Apply the binding candidate-query formula to the selected interval.

Verification:

- `bun run --cwd packages/opencode test test/session/lifecycle-reconciler.test.ts test/tool/task.test.ts test/tool/team_spawn.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Prove restart, cross-process, no-signal, and missed-signal recovery before accepting a rate change.

#### PR F1: FFF First-Use Readiness

- Paths: update `packages/core/src/filesystem/search.ts` and `packages/core/test/filesystem/search.test.ts`.
- Make every FFF search path await the shared scan-readiness gate. Fall back to ripgrep on timeout or failure.
- Prove the first result set is complete and concurrent first users share one scan.

Verification:

- `bun run --cwd packages/core test test/filesystem/search.test.ts`
- `bun run --cwd packages/core typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify early partial results, duplicate picker creation, timeout cleanup, and fallback parity.

#### PR F2: Remove Bootstrap FFF Warm-Up

- Paths: update `packages/opencode/src/project/bootstrap.ts`, `packages/core/src/filesystem/search.ts`, `packages/opencode/test/project/instance-bootstrap.test.ts`, and `packages/core/test/filesystem/search.test.ts`.
- Remove only bootstrap `search.warm`. Keep lazy first-use acquisition and disposal.
- Assert inactive instances create zero pickers and watchers.

Verification:

- `bun run --cwd packages/opencode test test/project/instance-bootstrap.test.ts --timeout 30000 && bun run --cwd packages/core test test/filesystem/search.test.ts`
- `bun run --cwd packages/opencode typecheck && bun run --cwd packages/core typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify hidden warm paths, first-use completeness, multiple instances, and disposal cleanup.

#### PR F3a: Instance Generation And Lease Primitive

- Paths: update `packages/opencode/src/project/instance-store.ts`, `packages/opencode/src/project/instance-context.ts`, `packages/opencode/test/project/instance.test.ts`, and `packages/opencode/test/effect/instance-state.test.ts`.
- Add generation identity, atomic lease acquisition, generation-aware idempotent release, and the closing transition. Do not add consumers or eviction.
- Reject new leases for a closing generation. A late release for generation N cannot mutate generation N+1.

Verification:

- `bun run --cwd packages/opencode test test/effect/instance-state.test.ts test/project/instance.test.ts test/project/instance-bootstrap.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify concurrent acquire and close, late release, repeated release, and generation replacement.

#### PR F3b: HTTP Request And SSE Generation Leases

- Paths: update `packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`, `packages/opencode/test/server/httpapi-instance-context.test.ts`, `packages/opencode/test/server/httpapi-instance.test.ts`, and `packages/opencode/test/server/httpapi-event.test.ts`.
- Hold one exact-generation lease for each HTTP request and SSE stream. Release it once on completion, disconnect, error, or interruption.
- Do not add runner, job, background-fiber, or eviction behavior.

Verification:

- `bun run --cwd packages/opencode test test/project/instance.test.ts test/server/httpapi-instance-context.test.ts test/server/httpapi-instance.test.ts test/server/httpapi-event.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify missing middleware coverage, SSE disconnect, interruption, repeated finalization, closing-generation admission, and cross-generation release.

#### PR F3c: Runner And Background-Fiber Generation Leases

- Paths: update `packages/opencode/src/effect/runner.ts` and `packages/opencode/test/effect/runner.test.ts`.
- Hold one exact-generation lease for each runner and its background fibers until all owned work settles or is interrupted.
- Do not add job or eviction behavior.

Verification:

- `bun run --cwd packages/opencode test test/effect/runner.test.ts test/project/instance.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify fork ownership, parent completion, interruption, failed startup, late finalization, and replacement-generation mutation.

#### PR F3d: Background Job Generation Leases

- Paths: update `packages/opencode/src/background/job.ts` and `packages/opencode/test/background/job.test.ts`.
- Hold one exact-generation lease for each background job until terminal settlement and waiter notification complete.
- Do not add terminal retention or eviction behavior.

Verification:

- `bun run --cwd packages/opencode test test/background/job.test.ts test/project/instance.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify start failure, cancellation, terminal settlement, captured waiter notification, late settlement, and replacement-generation mutation.

#### PR F4: Generation-Safe Instance Eviction

- Paths: update `packages/opencode/src/project/instance-store.ts`, `packages/opencode/src/effect/instance-registry.ts`, `packages/opencode/test/project/instance.test.ts`, and `packages/opencode/test/effect/instance-state.test.ts`.
- Start only after F3a-F3d pass their focused verification and fresh reviews.
- Add LRU or idle-TTL eviction only for the current zero-lease generation. Select the first default from the deterministic fixture; label it recommended, not proven.
- Make disposal idempotent and compare key plus generation before store removal.

Verification:

- `bun run --cwd packages/opencode test test/effect/instance-state.test.ts test/project/instance.test.ts test/project/instance-bootstrap.test.ts test/server/httpapi-instance-context.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify active eviction, ABA removal, repeated disposal, failure cleanup, and resource counts after TTL or disposal.

### Phase 4: Sync, SSE, And Durable Storage Protocol Chain

#### PR P1: Versioned Delivery Protocol Specification

- Paths: update `specs/v2/session.md` and `packages/opencode/src/sync/README.md` with the exact V2 contract in this document.
- Specify negotiation, cursor encoding, snapshot hydration, acknowledgement eligibility, logical IDs, overflow, reconnect, direct replay, migration, and pruning preconditions. Keep the current implementation unchanged.
- Update `specs/v2/tools.md` only if a later tool-event wire change is accepted.

Verification:

- `bun run docs:check`

Review: Run the Mandatory Fresh Read-Only Review. Falsify ambiguity in ordering, ack meaning, old-client behavior, overflow settlement, cursor expiry, and pruning safety.

#### PR P2a: Durable Delivery Position, Snapshot, And Ack Storage

- Paths: update `packages/core/src/event.ts`, `packages/core/src/event/sql.ts`, `packages/core/test/event.test.ts`, and `packages/core/test/database-migration.test.ts`; add `packages/core/src/database/migration/20260808005000_add_delivery_protocol_state.ts`.
- Add a transactional global durable delivery sequence, stable epoch, snapshot codec registry, snapshot storage, durable workspace-replica registration and acknowledgement storage, and monotonic repository operations.
- Persist the workspace and stream scope, stable consumer ID, eligibility, registration time, and explicit deregistration state. Only eligible registered replicas participate in the watermark.
- Do not add HTTP schemas, negotiate clients, publish protocol 2, bound queues, or prune events in this PR.

Verification:

- `bun run --cwd packages/core test test/event.test.ts test/database-migration.test.ts`
- `bun run --cwd packages/core typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify transaction order, multi-process sequence allocation, restart epoch stability, codec versioning, registration idempotency, explicit deregistration, scope checks, monotonic ack, migration, transient-consumer exclusion, and any early deletion.

#### PR P2b: Server Schemas And Dual Protocol Production

- Paths: update `specs/v2/session.md`, `packages/opencode/src/sync/README.md`, `packages/opencode/src/sync/schema.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/event.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/sync.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts`, `packages/server/src/groups/event.ts`, `packages/server/src/handlers/event.ts`, `packages/opencode/test/server/httpapi-event.test.ts`, `packages/opencode/test/server/httpapi-v2-location.test.ts`, `packages/opencode/test/server/httpapi-sync.test.ts`, `packages/opencode/test/server/httpapi-sdk.test.ts`, `packages/sdk/openapi.json`, `packages/sdk/js/src/gen/types.gen.ts`, `packages/sdk/js/src/gen/sdk.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`, and `packages/sdk/js/src/v2/gen/sdk.gen.ts`.
- Use P2a storage to add protocol-2 schemas, explicit negotiation, durable workspace-replica registration and deregistration endpoints, snapshot and acknowledgement endpoints, encoded cursors, and dual publication. Keep protocol-1 output unchanged.
- Regenerate both generated JS surfaces. Do not migrate consumers, add queue bounds, or prune events in this PR.

Verification:

- `bun run --cwd packages/opencode test test/server/httpapi-event.test.ts test/server/httpapi-v2-location.test.ts test/server/httpapi-sync.test.ts test/server/httpapi-sdk.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck && bun run --cwd packages/server typecheck`
- `./packages/sdk/js/script/build.ts && bun run check:generated && bun run --cwd packages/sdk/js typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify negotiation fallback, schema drift, replica registration and deregistration authority, acknowledgement identity binding, cursor scope, old-client envelopes, dual logical IDs, generated surfaces, and auth.

#### PR P2c: Session Aggregate Snapshot Codec

- Paths: add `packages/core/src/session/snapshot.ts` and `packages/core/test/session-snapshot.test.ts`; update `packages/core/src/event.ts`, `packages/core/src/session/projector.ts`, `packages/core/src/session/sql.ts`, and `packages/core/test/event.test.ts`.
- Register `SessionDeliverySnapshotV1` for aggregate type `session`. Its schema owns the session row, ordered legacy message and part rows, ordered V2 session-message rows, pending session-input rows, and session context-epoch state through one sequence.
- Differentially compare full replay with snapshot plus tail replay for created, updated, moved, deleted, legacy message and part, V2 message, prompt lifecycle, model and agent switch, context replacement, settlement, and compaction fixtures. Keep the complete event history for every aggregate without a registered, passing codec.
- Do not add consumer migration, queue bounds, or pruning in this PR. P3 cannot start before this slice passes.

Verification:

- `bun run --cwd packages/core test test/event.test.ts test/session-projector.test.ts test/session-snapshot.test.ts`
- `bun run --cwd packages/core typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify schema versioning, row order, snapshot atomicity, full-replay equality, tail replay, deletion state, omitted projector state, and the retained-history fallback for an aggregate without a codec.

#### PR P3a: Workspace Protocol-2 Rehydration And Durable Replica Ack

- Paths: update `packages/opencode/src/control-plane/workspace.ts`, `packages/opencode/test/control-plane/workspace.test.ts`, and `packages/opencode/test/server/httpapi-sync.test.ts`.
- Register the authenticated workspace-sync replica, negotiate protocol 2, subscribe before snapshot, buffer later events, apply one snapshot, replay events above `through`, persist the durable acknowledgement after apply, and reconnect from the accepted cursor.
- Registration is idempotent for the stable replica identity. Only explicit administration or workspace removal deregisters it. Keep legacy production for non-negotiated clients.

Verification:

- `bun run --cwd packages/opencode test test/server/httpapi-sync.test.ts test/control-plane/workspace.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Race snapshot with live data, disconnect, stale epoch, duplicate logical ID, registration, explicit deregistration, restart, workspace switch, and partial apply.

#### PR P3b: TUI Protocol-2 Rehydration

- Paths: update `packages/tui/src/context/sync.tsx`, `packages/tui/src/context/sync-v2.tsx`, `packages/tui/test/app-lifecycle.test.tsx`, `packages/tui/test/cli/tui/use-event.test.tsx`, `packages/tui/test/cli/cmd/tui/sync-live-hydration.test.tsx`, and `packages/tui/test/cli/tui/sync-v2.test.tsx`.
- Negotiate protocol 2, subscribe before snapshot, buffer later events, apply one snapshot, replay events above `through`, and reconnect from the accepted local resume cursor.
- Do not register the TUI as a durable replica or send a pruning acknowledgement. Keep its legacy path while protocol 1 remains supported.

Verification:

- `bun run --cwd packages/tui test test/app-lifecycle.test.tsx test/cli/tui/use-event.test.tsx test/cli/cmd/tui/sync-live-hydration.test.tsx test/cli/tui/sync-v2.test.tsx --timeout 30000`
- `bun run --cwd packages/tui typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Race snapshot with live data, disconnect, stale epoch, duplicate logical ID, partial apply, and local resume. Prove TUI cursors never enter or advance the pruning watermark.

#### PR P3c: App Protocol-2 Rehydration

- Paths: update `packages/app/src/context/server-sync.tsx`, `packages/app/src/context/directory-sync.ts`, `packages/app/src/context/global-sync/bootstrap.ts`, `packages/app/src/context/global-sync/queue.ts`, `packages/app/src/context/server-sync.test.ts`, `packages/app/src/context/global-sync/bootstrap.test.ts`, and `packages/app/src/context/global-sync/queue.test.ts`.
- Negotiate protocol 2, subscribe before snapshot, buffer later events, apply one snapshot, replay events above `through`, and reconnect from the accepted local resume cursor.
- Do not register the app as a durable replica or send a pruning acknowledgement. Keep its legacy path while protocol 1 remains supported.

Verification:

- `bun run --cwd packages/app test:unit`
- `bun run --cwd packages/app typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Race snapshot with live data, disconnect, stale epoch, duplicate logical ID, directory switch, queue restart, and partial apply. Prove app cursors never enter or advance the pruning watermark.

#### PR P4: Bounded SSE Transport

- Paths: update `packages/opencode/src/server/routes/instance/httpapi/groups/event.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`, `packages/server/src/groups/event.ts`, `packages/server/src/handlers/event.ts`, `packages/opencode/test/server/httpapi-event.test.ts`, and `packages/opencode/test/server/httpapi-v2-location.test.ts`.
- Bound both SSE surfaces, the instance event route and `/api/event`, by event count and serialized bytes. Start from the recommended 1024-event default; select and record the byte default from the fixture before merge.
- At `limit + 1`, settle accepted entries once, send resync-required when possible, and close. Keep existing queue diagnostics.

Verification:

- `bun run --cwd packages/opencode test test/server/httpapi-event.test.ts test/server/httpapi-v2-location.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck && bun run --cwd packages/server typecheck`

Review: Run the Mandatory Fresh Read-Only Review. On both SSE surfaces, block the consumer and falsify event bound, byte bound, byte accounting, silent drop, duplicate settlement, resync, and reconnect.

#### PR P5: Independently Bounded Direct Replay

- Paths: update `packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/sync.ts`, and `packages/opencode/test/server/httpapi-sync.test.ts`.
- Add separate event and serialized-byte bounds to direct history replay. On overflow, abort and return resync-required so the client gets a snapshot.
- Do not reuse SSE queue state or limits implicitly.

Verification:

- `bun run --cwd packages/opencode test test/server/httpapi-sync.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify independent limits, cursor order, partial replay, overflow response, and snapshot equality.

#### PR P6: Core PubSub Traffic Classes And Backpressure

- Paths: update `packages/core/src/event.ts` and `packages/core/test/event.test.ts`.
- Classify every core event as durable or ephemeral. Use bounded blocking backpressure for durable post-commit publication and an explicit coalesce or latest rule for each ephemeral class.
- Start from the recommended 256-entry bound, subject to the blocked-consumer fixture. Never block inside the database transaction.

Verification:

- `bun run --cwd packages/core test test/event.test.ts`
- `bun run --cwd packages/core typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify misclassification, transaction blocking, durable loss, ephemeral rule drift, shutdown, and `limit + 1` settlement.

#### PR P7a: Workspace Negotiated Sync Deduplication

- Paths: update `packages/opencode/src/control-plane/workspace.ts` and `packages/opencode/test/control-plane/workspace.test.ts`.
- Deduplicate workspace delivery by `logicalID` only after protocol 2 is selected. Keep the legacy `sync` envelope and current protocol-1 multiplicity.
- Bound the durable replica dedupe cache by its acknowledged cursor progress, not an unrelated time-only cache.

Verification:

- `bun run --cwd packages/opencode test test/control-plane/workspace.test.ts test/server/httpapi-sync.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Prove 100 mutations produce 100 logical IDs for the protocol-2 workspace replica, acknowledgement advances cache release, restart is safe, and protocol 1 is unchanged.

#### PR P7b: TUI Negotiated Sync Deduplication

- Paths: update `packages/tui/src/context/sync.tsx`, `packages/tui/test/cli/cmd/tui/sync-live-hydration.test.tsx`, and `packages/tui/test/cli/tui/sync-v2.test.tsx`.
- Deduplicate TUI delivery by `logicalID` only after protocol 2 is selected. Keep the legacy `sync` envelope and current protocol-1 multiplicity.
- Bound the dedupe cache by applied local resume-cursor progress. Do not publish a pruning acknowledgement.

Verification:

- `bun run --cwd packages/tui test test/cli/cmd/tui/sync-live-hydration.test.tsx test/cli/tui/sync-v2.test.tsx --timeout 30000`
- `bun run --cwd packages/tui typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Prove 100 mutations produce 100 logical IDs for the protocol-2 TUI, reconnect is idempotent, the local cursor cannot affect pruning, and protocol 1 is unchanged.

#### PR P7c: App Negotiated Sync Deduplication

- Paths: update `packages/app/src/context/server-sync.tsx`, `packages/app/src/context/global-sync/event-reducer.ts`, `packages/app/src/context/global-sync/queue.ts`, `packages/app/src/context/server-sync.test.ts`, `packages/app/src/context/global-sync/event-reducer.test.ts`, and `packages/app/src/context/global-sync/queue.test.ts`.
- Deduplicate app delivery by `logicalID` only after protocol 2 is selected. Keep the legacy `sync` envelope and current protocol-1 multiplicity.
- Bound the dedupe cache by applied local resume-cursor progress. Do not publish a pruning acknowledgement.

Verification:

- `bun run --cwd packages/app test:unit`
- `bun run --cwd packages/app typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Prove 100 mutations produce 100 logical IDs for the protocol-2 app, queue restart and reconnect are idempotent, the local cursor cannot affect pruning, and protocol 1 is unchanged.

#### PR P8a: Workspace Legacy-Path Removal Preparation

- Paths: in a later compatibility release, update `packages/opencode/src/control-plane/workspace.ts` and `packages/opencode/test/control-plane/workspace.test.ts`.
- Remove the workspace consumer's protocol-1 fallback only after supported-client telemetry or release policy proves migration. Keep server legacy production unchanged.

Verification:

- `bun run --cwd packages/opencode test test/control-plane/workspace.test.ts test/server/httpapi-sync.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Require compatibility-release approval and falsify workspace negotiation, reconnect, rehydration, and any remaining protocol-1 dependency.

#### PR P8b: TUI Legacy-Path Removal Preparation

- Paths: in the same later compatibility program, update `packages/tui/src/context/sync.tsx`, `packages/tui/src/context/sync-v2.tsx`, `packages/tui/test/cli/cmd/tui/sync-live-hydration.test.tsx`, and `packages/tui/test/cli/tui/sync-v2.test.tsx`.
- Remove the TUI consumer's protocol-1 fallback only after the supported-version policy proves migration. Keep server legacy production unchanged.

Verification:

- `bun run --cwd packages/tui test test/cli/cmd/tui/sync-live-hydration.test.tsx test/cli/tui/sync-v2.test.tsx --timeout 30000`
- `bun run --cwd packages/tui typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Require compatibility-release approval and falsify TUI negotiation, reconnect, rehydration, and any remaining protocol-1 dependency.

#### PR P8c: App Legacy-Path Removal Preparation

- Paths: in the same later compatibility program, update `packages/app/src/context/server-sync.tsx`, `packages/app/src/context/directory-sync.ts`, `packages/app/src/context/server-sync.test.ts`, `packages/app/src/context/global-sync/event-reducer.test.ts`, and `packages/app/src/context/global-sync/queue.test.ts`.
- Remove the app consumer's protocol-1 fallback only after the supported-version policy proves migration. Keep server legacy production unchanged.

Verification:

- `bun run --cwd packages/app test:unit`
- `bun run --cwd packages/app typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Require compatibility-release approval and falsify app negotiation, directory switching, reconnect, rehydration, and any remaining protocol-1 dependency.

#### PR P8d: Public And Generated Compatibility Preparation

- Paths: in the same later compatibility program, update `specs/v2/session.md`, `packages/opencode/src/sync/README.md`, `packages/sdk/openapi.json`, `packages/sdk/js/src/gen/types.gen.ts`, `packages/sdk/js/src/gen/sdk.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`, and `packages/sdk/js/src/v2/gen/sdk.gen.ts`.
- Mark the protocol-1 surface as pending removal and publish the approved compatibility-release boundary. Do not remove server production or schemas in this PR.
- Regenerate both JS surfaces.

Verification:

- `./packages/sdk/js/script/build.ts && bun run check:generated && bun run --cwd packages/sdk/js typecheck`
- `bun run docs:check`

Review: Run the Mandatory Fresh Read-Only Review. Require compatibility-release approval and falsify documentation, OpenAPI, generated-client, and release-boundary drift while protocol 1 remains available.

#### PR P8e: Approved Atomic Legacy Compatibility Flip

- Paths: update `packages/opencode/src/sync/schema.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/event.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/sync.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/sync.ts`, `packages/server/src/groups/event.ts`, `packages/server/src/handlers/event.ts`, `packages/opencode/test/server/httpapi-event.test.ts`, `packages/opencode/test/server/httpapi-v2-location.test.ts`, `packages/opencode/test/server/httpapi-sync.test.ts`, `packages/opencode/test/server/httpapi-sdk.test.ts`, `specs/v2/session.md`, `packages/opencode/src/sync/README.md`, `packages/sdk/openapi.json`, `packages/sdk/js/src/gen/types.gen.ts`, `packages/sdk/js/src/gen/sdk.gen.ts`, `packages/sdk/js/src/v2/gen/types.gen.ts`, and `packages/sdk/js/src/v2/gen/sdk.gen.ts`.
- After P8a-P8d and explicit compatibility-release approval, atomically remove protocol-1 negotiation, production, schemas, docs, and generated public surfaces. This PR is not part of the first performance release.
- Regenerate both JS surfaces in the same PR. Do not split the server flip from its public contract removal.

Verification:

- `bun run --cwd packages/opencode test test/server/httpapi-event.test.ts test/server/httpapi-v2-location.test.ts test/server/httpapi-sync.test.ts test/server/httpapi-sdk.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck && bun run --cwd packages/server typecheck`
- `./packages/sdk/js/script/build.ts && bun run check:generated && bun run --cwd packages/sdk/js typecheck && bun run docs:check`

Review: Run the Mandatory Fresh Read-Only Review. Require explicit compatibility-release approval and the passing P8a-P8d evidence. Falsify any remaining protocol-1 producer, consumer, schema, documentation, OpenAPI, or generated-client surface.

#### PR P9: Acknowledgement-Safe Event Pruning

- Paths: update `packages/core/src/event.ts`, `packages/core/src/event/sql.ts`, `packages/core/src/session/snapshot.ts`, `packages/core/test/event.test.ts`, `packages/core/test/session-snapshot.test.ts`, and `packages/core/test/database-migration.test.ts`. Add `packages/core/src/database/migration/20260808010000_add_event_prune_watermark.ts` only if P2 storage does not already persist the required watermark.
- Use the P2a snapshot metadata and eligible registered durable workspace-replica acknowledgements. Persist the safe watermark before deletion and delete only through that watermark.
- For `SessionDeliverySnapshotV1`, prove pre-prune and snapshot-plus-tail-replay equality and positively prove that acknowledged session events through the safe watermark are deleted.
- Prove that an unencoded aggregate, an unregistered or transient consumer, a missing eligible acknowledgement, and an explicitly deregistered final replica cannot advance deletion. Keep those event rows. Prove crash recovery at each write or delete boundary. Do not combine Tool.Progress coalescing.
- P9 depends on P1-P7. It does not depend on the later P8 compatibility removal.

Verification:

- `bun run --cwd packages/core test test/event.test.ts test/session-snapshot.test.ts test/database-migration.test.ts`
- `bun run --cwd packages/core typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify missing or ineligible replicas, transient TUI or app cursors, stale epoch, partial snapshot, unencoded-aggregate retention, crash boundaries, replay equality, absence of positive named-aggregate deletion, and deletion beyond the minimum eligible acknowledgement.

### Phase 5: Other Structural Work

#### PR S1: Managed Core Process Spooling

- Paths: update `packages/core/src/process.ts` and `packages/core/test/process/process.test.ts`.
- Add managed full-output spooling to `AppProcess` while keeping bounded stdout and stderr previews. Define ownership, cleanup, byte accounting, errors, and file lifetime.
- Do not change V2 bash tool behavior in this PR.

Verification:

- `bun run --cwd packages/core test test/process/process.test.ts`
- `bun run --cwd packages/core typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify output loss, stdout/stderr identity, chunk bounds, cleanup, timeout, abort, and spill errors.

#### PR S2: V2 Bash Adoption Of Managed Spooling

- Paths: update `packages/core/src/tool/bash.ts` and `packages/core/test/tool-bash.test.ts`.
- Adopt the S1 managed output contract. Keep the current permission, timeout, structured output, and active-location behavior.
- Do not change the legacy `packages/opencode/src/tool/shell.ts` path.

Verification:

- `bun run --cwd packages/core test test/tool-bash.test.ts test/process/process.test.ts`
- `bun run --cwd packages/core typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Compare current structured output and permission behavior, then falsify full-output retrieval and cleanup.

#### PR J1: Terminal Job Observation And Output Contract

- Paths: update `packages/core/src/background-job.ts` and `packages/core/test/background-job.test.ts`; update `packages/opencode/src/background/job.ts` and `packages/opencode/test/background/job.test.ts` only for adapter parity.
- Define `get`, `list`, and `wait` for running, terminal, expired, missing, and restarted process-local jobs. Add a fixture-selected output-byte cap and explicit truncation metadata.
- Track captured waiters so later retention cannot evict their job. Do not add terminal count or TTL retention yet.

Verification:

- `bun run --cwd packages/core test test/background-job.test.ts && bun run --cwd packages/opencode test test/background/job.test.ts --timeout 30000`
- `bun run --cwd packages/core typecheck && bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify waiter capture, restart semantics, output-byte boundaries, cancellation, extension, and settlement.

#### PR J2: Core Terminal Job Retention

- Paths: update `packages/core/src/background-job.ts` and `packages/core/test/background-job.test.ts`.
- Add terminal count or TTL retention selected from the fixture. Never evict running jobs or terminal jobs with captured waiters. Settle and release waiter observation before expiry.
- Keep this policy independent of opencode instance disposal.

Verification:

- `bun run --cwd packages/core test test/background-job.test.ts`
- `bun run --cwd packages/core typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Falsify count and time boundaries, all terminal states, running exemptions, waiter capture, and idempotent expiry.

#### PR J3: Opencode Instance Job Retention Integration

- Paths: update `packages/opencode/src/background/job.ts`, `packages/opencode/test/background/job.test.ts`, and `packages/opencode/test/project/instance.test.ts`.
- Apply the core terminal policy per instance generation. Disposal interrupts running jobs and removes terminal entries only for the disposed generation.
- A late job settlement from generation N cannot enter generation N+1.

Verification:

- `bun run --cwd packages/opencode test test/background/job.test.ts test/project/instance.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review: Run the Mandatory Fresh Read-Only Review. Race settlement, wait, expiry, disposal, and replacement generation.

## Future Work

- Tool.Progress compaction stays out of this program until a production publisher and measurable CPU or memory payoff are shown. If accepted later, update `specs/v2/tools.md`, public schemas, OpenAPI, both JS generated surfaces, and all consumers.
- RPC timeout, `AbortSignal`, cancellation protocol, and pending-count limits follow Q4 as separate behavior PRs.
- More LSP built-ins can opt in to root sharing only after separate launch, trust, ownership, and result-isolation audits.
- Cross-process LSP pooling, durable background jobs, and remote job observation require new ownership and authorization designs.
- Automated macOS claim gates require a stable hosted macOS runner and a successful multi-host harness pilot.
- Memory slope gates require a fixed workload, estimator, cadence, warm-up cut, and zero-or-negative-baseline rule.

## Open Questions

1. Which built-in is the first root-sharing candidate in L9? Default: audit the pinned TypeScript fixture first. If any launch or owner input is unstable, keep all servers instance-scoped.
2. What byte limits and job or instance TTLs ship first? Default: select them from the M1 `limit + 1`, output-hash, and unrelated-data fixtures in the owning PR. Record them as recommended defaults, not validated budgets.
