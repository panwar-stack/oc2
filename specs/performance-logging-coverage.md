# Performance Logging Coverage

## Goal

Add enough low-noise logging in `packages/opencode` and adjacent core paths to identify and fix common performance issues: slow model responses, stalled sessions, slow tools, SQLite contention, filesystem/search hotspots, and event-stream backpressure.

The first pass must favor targeted, thresholded, structured log fields over broad request/body logging. The implementation strategy is to add timing at existing choke points before changing log format or adding new tracing infrastructure.

## Current State

- Central logger lives in `packages/core/src/util/log.ts`; it supports `DEBUG`, `INFO`, `WARN`, `ERROR`, ad hoc structured fields, and `Log.time()`.
- CLI initializes logging in `packages/opencode/src/index.ts`; TUI worker initializes logging in `packages/opencode/src/cli/tui/worker.ts`.
- Effect logger bridge lives in `packages/core/src/effect/logger.ts` and can emit Effect spans into normal logs.
- `Log.time()` is used sparsely in `packages/opencode/src/session/tools.ts`, `packages/opencode/src/tool/registry.ts`, and `packages/opencode/src/provider/provider.ts`.
- LLM OpenTelemetry exists in `packages/opencode/src/session/llm.ts` and `packages/opencode/src/agent/agent.ts`, but normal logs do not consistently expose streaming latency phases.
- Session loop and processor have coarse lifecycle logs in `packages/opencode/src/session/prompt.ts` and `packages/opencode/src/session/processor.ts`.
- Session step duration is persisted in `packages/opencode/src/session/processor.ts`, but not consistently emitted as searchable logs.
- Run coordination in `packages/core/src/session/run-coordinator.ts` lacks wake/drain/coalesce/stall timing logs.
- Tool execution has tracing spans in `packages/opencode/src/tool/tool.ts`, but no thresholded slow-tool logs.
- Filesystem/search tools in `packages/opencode/src/tool/read.ts`, `packages/opencode/src/tool/grep.ts`, and `packages/opencode/src/tool/glob.ts` lack timing/result-size diagnostics.
- SQLite access in `packages/core/src/database/sqlite.bun.ts` uses serialized execution but does not log queue wait or slow statements.
- Event streaming in `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts` can accumulate silently without backpressure diagnostics.
- HTTP API logging is disabled globally in `packages/opencode/src/server/routes/instance/httpapi/server.ts`.

## Non-Negotiables

- Must keep logs low-noise by default; use `DEBUG` for lifecycle detail and `INFO`/`WARN` only for thresholded slow operations or failures.
- Must not log prompt text, model output text, tool input bodies, SQL parameters, file contents, secrets, auth headers, or request bodies.
- Must use consistent field names for performance logs:
  - `durationMs`
  - `ttftMs`
  - `waitMs`
  - `sessionID`
  - `messageID`
  - `toolCallID`
  - `providerID`
  - `modelID`
  - `requestID`
  - `attempt`
  - `status`
- Must preserve existing log output compatibility in the first pass; do not switch the logger to JSONL yet.
- Must not add new config surface unless needed for thresholds after review.
- Must not introduce broad access logs that make normal local development noisy.
- Must run checks from the package directory, not repo root.

## Logging Design

### Provider Stream Logs

Add lifecycle logs around provider streaming in:

- `packages/opencode/src/session/llm.ts`
- `packages/core/src/session/runner/llm.ts`

Emit:

```ts
log.debug("stream.start", {
  sessionID,
  messageID,
  providerID,
  modelID,
  attempt,
})
```

On first stream event/token:

```ts
log.info("stream.first", {
  sessionID,
  messageID,
  providerID,
  modelID,
  attempt,
  ttftMs,
})
```

On completion:

```ts
log.info("stream.complete", {
  sessionID,
  messageID,
  providerID,
  modelID,
  attempt,
  durationMs,
  ttftMs,
  eventCount,
  finishReason,
})
```

On failure:

```ts
log.warn("stream.error", {
  sessionID,
  messageID,
  providerID,
  modelID,
  attempt,
  durationMs,
  error,
})
```

Failure mode:

- If the stream fails before the first event, omit `ttftMs` or set it to `undefined`; do not invent `0`.

### Run Coordinator Logs

Add logs in `packages/core/src/session/run-coordinator.ts` for:

- Wake accepted.
- Wake coalesced.
- Drain started.
- Drain completed.
- Drain failed.
- Wake suppressed after interrupt.
- Wait time before drain starts.

Use `DEBUG` for normal lifecycle logs and `WARN` for failures or suspicious states.

### Slow Tool Logs

Add thresholded logs in `packages/opencode/src/tool/tool.ts`.

Default thresholds:

- `INFO` when tool duration is greater than `5_000ms`.
- `WARN` when tool duration is greater than `30_000ms`.

Fields:

```ts
{
  toolName,
  toolCallID,
  sessionID,
  durationMs,
  status: "success" | "error",
}
```

Do not log tool input or output content.

### Slow SQLite Logs

Add thresholded diagnostics in `packages/core/src/database/sqlite.bun.ts`.

Default thresholds:

- `DEBUG` for query timing only when local log level already includes debug.
- `INFO` when total duration is greater than `250ms`.
- `WARN` when total duration is greater than `1_000ms` or semaphore wait is greater than `500ms`.

Fields:

```ts
{
  durationMs,
  waitMs,
  sqlShape,
  rowCount,
  status: "success" | "error",
}
```

`sqlShape` must be redacted and normalized enough to identify statement class/table without values.

### Filesystem/Search Tool Logs

Add thresholded diagnostics to:

- `packages/opencode/src/tool/read.ts`
- `packages/opencode/src/tool/grep.ts`
- `packages/opencode/src/tool/glob.ts`

Fields:

```ts
{
  toolName,
  sessionID,
  durationMs,
  resultCount,
  truncated,
  status,
}
```

Do not log file contents. Paths are allowed only when already user-provided or already returned by the tool.

### Event Stream Backpressure Logs

Add diagnostics in `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`.

Log:

- Stream connection opened/closed at `DEBUG`.
- Queue depth or buffered event count when above threshold at `WARN`.
- Write/send failure at `WARN`.

Fields:

```ts
{
  requestID,
  sessionID,
  queueDepth,
  durationMs,
  status,
}
```

### HTTP API Perf Logs

Keep `disableLogger: true` in `packages/opencode/src/server/routes/instance/httpapi/server.ts` for now.

Add lightweight timing only at selected API boundaries where useful for perf diagnosis, not full body/request logging.

Fields:

```ts
{
  requestID,
  route,
  method,
  statusCode,
  durationMs,
}
```

## Implementation Slices

### PR 1: Provider Stream Timing Logs

- Add stream lifecycle timing in `packages/opencode/src/session/llm.ts`.
- Add equivalent timing in `packages/core/src/session/runner/llm.ts` if that path owns provider streaming independently.
- Track `startedAt`, first event time, completion time, `eventCount`, `attempt`, and finish/error state.
- Ensure no prompt text, output text, headers, or raw provider payloads are logged.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/core && bun typecheck`
- Run an existing session/model test if one directly covers `session/llm.ts`; otherwise document why typecheck is the deterministic check for this slice.

Review:

A fresh read-only reviewer must inspect the diff for accidental prompt/output logging, missing failure logs, and inconsistent field names before merge.

### PR 2: Run Coordinator Diagnostics

- Add `Log.create` usage in `packages/core/src/session/run-coordinator.ts` if not already present.
- Log wake accepted/coalesced/suppressed decisions.
- Log drain start/end/failure with `durationMs` and wait timing.
- Keep normal decision logs at `DEBUG`; use `WARN` only for failures or unexpected states.

Verification:

- `cd packages/core && bun typecheck`
- Run existing session coordinator tests if present in `packages/core`; otherwise add a focused unit test only if the coordinator already has test coverage patterns.

Review:

A fresh read-only reviewer must verify the logs explain stalled/coalesced wakes without changing coordinator behavior.

### PR 3: Slow Tool Logs

- Add thresholded slow-operation logging in `packages/opencode/src/tool/tool.ts`.
- Include `toolName`, `toolCallID`, `sessionID`, `durationMs`, and `status`.
- Do not log tool arguments, tool results, file contents, or command output.
- Default to `INFO` over `5s` and `WARN` over `30s`.

Verification:

- `cd packages/opencode && bun typecheck`
- Run existing tool wrapper tests if present.
- If no existing tests cover tool execution timing, add one focused test only if the test harness can avoid timing flakes.

Review:

A fresh read-only reviewer must verify sensitive tool input/output is not logged and thresholds avoid noisy normal runs.

### PR 4: Slow SQLite And Lock-Wait Logs

- Add semaphore wait timing and execution timing in `packages/core/src/database/sqlite.bun.ts`.
- Emit thresholded slow query logs with redacted `sqlShape`.
- Include `durationMs`, `waitMs`, `rowCount` when available, and `status`.
- Ensure SQL parameters and result values are never logged.

Verification:

- `cd packages/core && bun typecheck`
- Run existing database/sqlite tests if present.
- Add focused redaction test if there is already a nearby database test pattern.

Review:

A fresh read-only reviewer must verify SQL values cannot leak and the timing code does not change serialized execution behavior.

### PR 5: Filesystem/Search Tool Diagnostics

- Add thresholded timing logs to `packages/opencode/src/tool/read.ts`.
- Add thresholded timing logs to `packages/opencode/src/tool/grep.ts`.
- Add thresholded timing logs to `packages/opencode/src/tool/glob.ts`.
- Include result counts and truncation/partial status when already known.
- Do not add new filesystem traversal solely for logging.

Verification:

- `cd packages/opencode && bun typecheck`
- Run existing read/grep/glob tool tests if present.

Review:

A fresh read-only reviewer must verify diagnostics reuse already-computed values and do not add expensive extra work.

### PR 6: Event Stream Backpressure Diagnostics

- Add connection lifecycle and failure logs in `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`.
- Add queue-depth or buffered-event warnings if the existing queue implementation exposes enough state.
- If queue depth is not observable without structural changes, add only lifecycle/failure logs and leave queue-depth instrumentation to future work.

Verification:

- `cd packages/opencode && bun typecheck`
- Run existing HTTP/event handler tests if present.

Review:

A fresh read-only reviewer must verify logging does not change streaming semantics and does not emit one log per normal event.

## Future Work

- Add JSONL log output mode in `packages/core/src/util/log.ts` for easier automated analysis.
- Add configurable slow-operation thresholds after default thresholds prove useful.
- Add request ID propagation across HTTP, session, provider, and tool logs.
- Add sampled HTTP API access/perf middleware once route-level signal is understood.
- Unify OpenTelemetry spans and normal file logs so important span durations are visible without enabling a separate trace pipeline.
- Add memory indexing/summarization phase logs in `packages/opencode/src/memory/memory.ts`.

## Open Questions

- Should slow thresholds be hard-coded first or configurable immediately? Default recommendation: hard-code first to avoid new config/API surface.
- Should `stream.first` be `INFO` for every stream or only when over a threshold? Default recommendation: `INFO` initially because TTFT is the highest-value model performance signal.
- Should SQLite `sqlShape` include table names? Default recommendation: include statement type and table name when safely derivable, but never include values or parameters.
