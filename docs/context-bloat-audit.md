# Context Bloat Audit

## Outcome

Real context bloat exists. Repeated dynamic history is the largest problem, not the base system prompt. This audit changed no code.

Remove duplicate dynamic content first. Do not start with dynamic tool filtering, lower output caps, or prompt restructuring.

## Measurements

| Source | Size | Frequency and effect |
| --- | ---: | --- |
| Tool result | Up to 50 KiB, about 12.8K tokens | Replayed until prune or compaction |
| Team tool block | 40-45 KB, about 10-11K tokens | Present on every request, but usually cacheable |
| Team lead system | About 9 KB | Present on every lead request |
| Applicable `AGENTS.md` | Up to 24,679 B | Added when applicable |
| Teammate bootstrap | 3,512 B plus role and team data | Added for each teammate |
| Loaded skill body | Up to 13,000 B | Added after skill load |

Caching lowers cost and latency. It does not lower context-window use.

## Stage 0: Cache-Prefix Evidence

Add an adjacent-turn cache-prefix test. For a tail-only change, the test must keep these items unchanged:

- Cache key.
- Stable-prefix fingerprint.
- System fingerprint.
- Tools fingerprint.
- Tool order and presence.

The native OpenAI runtime at `packages/opencode/src/session/llm/native-runtime.ts:244-279` must rotate the key for a stable system change, but not for a tail change.

Fix the false prune test at `packages/opencode/test/session/compaction.test.ts:827-914`.

Evidence gaps remain:

- Bedrock replay has no cassette.
- The Gemini test has no positive cache evidence.

## Stage A: Small, Cache-Safe Reductions

Ranked in recommended implementation order:

1. **Remove todo echoes.** Update `packages/opencode/src/tool/todo.ts` and `packages/core/src/tool/todowrite.ts`. Return a fixed short output, but keep exact metadata, structured data, stored data, and UI data.
2. **Remove the manual completion-summary demand.** Remove it from `lifecycle-reconciler.ts:164-172`. Keep canonical delivery at `lifecycle-reconciler.ts:1025-1040`.
3. **Shorten send and broadcast results.** Update `team_send_message.ts:118-130` and `team_broadcast.ts:71-83`. Keep status, wake behavior, async behavior, title, and metadata.
4. **Shorten the mailbox wrapper.** Update `prompt.ts:1382-1399`. Keep tags, sender, body, and one action sentence.
5. **Remove the full role prompt from started mail.** Update `lifecycle-reconciler.ts:1365-1381`. Keep identity, state, and dependency data. Use a bounded preview as the rollback option.
6. **Remove exact generic duplication.** Update `team_get_messages.txt` and `team_task_list.txt`. This removes 1,417 static bytes and causes one cold-cache request. Preserve purpose and the no-poll rule.

## Stage B: Bounded Dynamic Rendering

7. Bound mailbox rendering before the delivery commit. Use FIFO order by time and ID. Keep exact database bodies and results. Provide a managed aggregate and a bounded preview or path. Release claims on failure.
8. Bound background completion rendering only. Keep exact child and lifecycle data.
9. Bound dependency fan-out. Use an ordered preview or path and keep the exact stored result.
10. Aggregate-bound MCP resource text at `prompt.ts:852-877`. Keep the exact managed file, order, and source.
11. Shorten only repeated empty mailbox checks. Keep the first check in full.

## Cache Rules

- Keep exact sorted tool order and stable tool presence.
- Do not select tools from prompt content, recent use, task phase, or token pressure.
- A static edit causes one cold request.
- A dynamic tool set can lose the full 40-45 KB tool-block cache and a later Anthropic or Bedrock prefix.
- A fingerprint is not provider cache proof.

Provider confidence:

| Provider path | Confidence |
| --- | --- |
| Direct Anthropic | Strongest |
| Direct OpenAI | Strongest |
| Bedrock | Replay evidence is missing |
| Gemini | Evidence is implicit; no positive replay exists |

## Reject or Defer

- Lower the 50 KiB result cap.
- Use dynamic pruning.
- Remove skill locations.
- Compress to a single root.
- Broadly delete `team_create` or member tools.
- Prune Core.
- Batch mailbox prefixes.
- Add attachment limits without a retention contract.
- Move dynamic team status.
- Add a history boundary loader.
- Remove storage projections.

Dynamic roster status still rotates the legacy stable-system fingerprint. Address this in later work.

## Operational-Only Work

These changes do not reduce model context:

- Add exact message lookup.
- Coalesce shell metadata.
- Add a visited-session LRU to both TUI stores.
- Remove duplicate terminal shell metadata after the old TUI migration.
- Page event replay.
- Stop full hydration before legacy compaction filtering.

## Audit Checks

| Check | Result |
| --- | ---: |
| Core focused tests | 15 passed |
| Legacy retry and pagination tests | 115 passed |
| TUI v2 sync tests | 17 passed |
| Source, test, provider, cache, and prompt inspection | Targeted inspection completed |
| Git status | Clean |
| Full suite | Not run because the audit was read-only |

## Recommended First Batch

1. Add the adjacent-turn cache test.
2. Remove todo duplication.
3. Remove the manual completion-summary demand.
4. Shorten send and broadcast results.
5. Shorten the mailbox wrapper.

This batch gives useful savings while it keeps exact durable data, stable schemas, tool order, and cache prefixes.
