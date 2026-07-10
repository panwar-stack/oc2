# V2 Session Contract

This document records the durable boundaries of the native V2 Session runtime. Public schemas and endpoint details remain owned by source code; this contract covers behavior that spans storage, execution, and model context.

## Prompt Admission And Promotion

`SessionV2.prompt(...)` admits input durably before model execution. Admission writes the Session input record and then schedules an advisory `SessionExecution.wake(sessionID)` unless `resume` is `false`.

- Reusing a Session ID adopts the existing Session.
- Reusing a prompt message ID is an exact retry only when Session, prompt, and delivery mode match.
- Admitted input remains outside model-visible history until the serialized runner promotes it.
- Promotion and consumption of the pending input are one durable transaction.

Delivery is explicit:

- `steer` is the default and promotes at the next safe step boundary while the Session still requires continuation.
- `queue` remains pending until the Session would otherwise become idle. One queued input promotes, then continuation is reevaluated.
- Promoting new user input resets the selected agent's step allowance. A batch of steers resets it once.

Manual compaction is admitted as a coalesced barrier in the same pending-input boundary. Later prompts do not promote until the barrier settles.

## Execution Ownership

`SessionExecution` is process-global and keyed by Session ID. A drain loads the Session, resolves its Location through `LocationServiceMap`, and enters Location-scoped runner services.

`SessionRunCoordinator` enforces process-local ownership:

- explicit resumes for the same Session join active execution;
- repeated wakes coalesce;
- different Sessions may run concurrently;
- interruption targets only the active local owner chain;
- interrupting a known but idle or locally unowned Session is a no-op.

Runner, model resolution, tools, permissions, plugins, and filesystem authority remain Location-scoped. Missing workspace identity means implicit local placement. Local ownership is not a clustered execution lease, and durable execution events do not establish current liveness.

## Steps And Physical Attempts

One Step is one logical LLM call and owns one assistant message. Most Steps have one physical provider attempt; overflow recovery may compact and rebuild the same Step for one additional attempt.

The runner uses one explicit `llm.stream(request)` call per physical attempt. It does not bridge through the legacy prompt loop or delegate tool orchestration to an in-memory model loop.

Every complete local tool call is durably represented before side effects begin. Local calls may execute concurrently, but every local or hosted call settles before the Step publishes its terminal result. Continuation reloads projected history after settlement.

Tool call IDs are unique only within their owning Step. Durable tool records therefore carry the owning assistant message ID as well as the call ID.

Before a new request is assembled, orphan reconciliation fails tool calls left pending or running by an earlier process. It attributes settlement to the original assistant message and never replays ambiguous side effects.

## Retry And Recovery

Core retries only typed rate-limit, provider-internal, and transport failures that occur before durable assistant output, tool output, or tool execution evidence exists. Retry scheduling is observable, consumes the selected agent's step allowance, and never becomes automatic crash recovery by itself.

An advisory wake drains eligible admitted work only. It does not infer that provider work interrupted by a hard crash is safe to replay. Explicit resume may continue from durable projected history; automatic crash continuation requires a separate design for dispatch ambiguity, idempotency, retry budgets, and distributed ownership.

## Instructions

Instructions are Session-owned model context, not a global registry. The runner explicitly combines built-ins, ambient discovery, selected-agent skill guidance, references, MCP guidance, and API-managed instruction entries.

`InstructionCheckpoint` stores the exact baseline last shown to the model and the last applied value for each source. The first complete observation establishes the baseline before prompt promotion. Later changes append chronological instruction updates and advance applied state atomically.

Unavailable sources preserve the model's previous belief and block only a Session that has never established a complete baseline. Completed compaction rebaselines instructions. Session movement and committed revert reset the checkpoint.

## Compaction And Replay

Compaction changes active model context, not durable transcript history. A completed checkpoint contains a structured rolling summary and bounded recent context; provider-native continuation state does not cross the boundary.

Overflow-triggered compaction is allowed only before durable assistant output or tool execution and only once for a Step. A second overflow, or overflow after durable output, is terminal.

Durable Session replay is aggregate-scoped and cursor-ordered. Live-only text, reasoning, tool-input, and compaction deltas are not replayable facts. Replay ownership remains separate from Session execution ownership.
