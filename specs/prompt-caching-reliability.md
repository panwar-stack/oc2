# Prompt Caching Reliability

## Goal

Make prompt caching more reliable by ensuring cacheable request prefixes are stable, long enough, consistently ordered, and measurable. The first pass should fix concrete audit gaps without changing provider semantics that already work.

Implementation should focus on V2/core request construction, `@opencode-ai/llm` provider lowering, deterministic tool ordering, cache diagnostics, and historical cache-write stats.

## Current State

- `packages/llm/src/cache-policy.ts` already has `AUTO` cache policy for tools, system, and latest user message.
- `packages/llm/src/protocols/anthropic-messages.ts` and `packages/llm/src/protocols/bedrock-converse.ts` already handle explicit cache breakpoints and provider limits.
- `packages/llm/src/protocols/openai-responses.ts` lowers `promptCacheKey` to `prompt_cache_key`.
- `packages/llm/src/protocols/openai-chat.ts` does not lower `promptCacheKey`.
- `packages/core/src/system-context/builtins.ts` includes date, cwd, workspace, platform, and git status in the V2 baseline.
- `packages/core/src/tool/registry.ts` materializes V2 tools from `Map` order.
- `packages/opencode/src/session/llm/request.ts` already sorts legacy tools by name.
- `packages/llm/src/schema/events.ts` captures cache read/write token fields.
- `packages/opencode/src/session/session.ts` computes differential cache read/write cost.
- `packages/stats/core` aggregates cache read but does not keep cache write as a standalone metric.
- Docs to update: `packages/llm/README.md` and optionally `packages/llm/example/call-sites.md`.

## Non-Negotiables

- Do not regress Anthropic or Bedrock cache breakpoint behavior.
- Do not put date, cwd, usernames, trace IDs, retrieved content, or session-specific IDs before the stable cacheable prefix.
- Preserve `Usage` token invariants in `packages/llm/src/schema/events.ts`.
- Keep tool ordering deterministic for the same effective tool set.
- Do not add Gemini explicit cached-content support in the first pass.
- Do not mix a tool digest into `prompt_cache_key` until reuse tradeoffs are measured.

## Design

Cacheable request order should be:

1. Stable system instructions and policies.
2. Stable sorted tool definitions and schemas.
3. Cache breakpoint after the stable prefix where the provider supports explicit markers.
4. Variable context such as date, cwd, workspace, git status, retrieved snippets, and latest user input.
5. Append-only session history, with compaction treated as a cache reset boundary.

For V2 system context, split stable sources from variable sources. Stable baseline remains durable through `context-epoch`; variable context is recomputed per request and must not be selected as the system cache breakpoint.

For diagnostics, compute a provider-projected toolset digest over sorted tool definitions. Use it for logs/metadata only in the first pass.

## Implementation Slices

### PR 1: OpenAI Chat Cache Key

- Lower `providerOptions.openai.promptCacheKey` to `prompt_cache_key` in `packages/llm/src/protocols/openai-chat.ts`.
- Mirror the existing Responses behavior in `packages/llm/src/protocols/openai-responses.ts`.
- Update `packages/llm/README.md` provider support notes.

Verification:

- `cd packages/llm && bun typecheck`
- `cd packages/llm && bun test`

Review:

A read-only reviewer compares Chat and Responses lowering and confirms unset options are omitted.

### PR 2: Stable V2 System Prefix

- Classify V2 system-context sources as stable or variable in `packages/core/src/system-context`.
- Keep date and environment out of the durable stable baseline.
- Update `packages/core/src/session/runner/llm.ts` so the stable baseline is the explicit cacheable system part.
- Emit variable context after the stable cache boundary.

Verification:

- `cd packages/core && bun typecheck`
- Add a test asserting stable baseline output is identical across date/cwd changes while variable context differs.

Review:

A read-only reviewer confirms date/env no longer appear in the stable baseline and cache hints target the stable part.

### PR 3: Deterministic V2 Tool Ordering

- Sort V2 tool definitions by name before request construction.
- Match legacy behavior from `packages/opencode/src/session/llm/request.ts`.

Verification:

- `cd packages/core && bun typecheck`
- Add a test registering tools out of order and asserting sorted request output.

Review:

A read-only reviewer confirms sorting does not change tool membership or schema content.

### PR 4: Toolset Digest Diagnostics

- Add a deterministic digest over sorted provider-projected tool definitions.
- Canonicalize schema object keys before hashing.
- Log the digest per request and optionally store it in `ToolDefinition.metadata`.
- Do not send the digest as a provider cache key.

Verification:

- `cd packages/core && bun typecheck`
- Add tests for stable digest across order changes and changed digest when tool content changes.

Review:

A read-only reviewer confirms the digest is side-effect-free and diagnostic only.

### PR 5: Cache Write Historical Stats

- Add `cache_write_tokens` through `packages/stats/core` schema, types, aggregate queries, and backfill.
- Preserve existing `cache_read_tokens`.
- Keep current cache-hit ratio read-focused by default, and expose write tokens separately.

Verification:

- `cd packages/stats/core && bun typecheck`
- Add an aggregate test using `tokens_cache_write_5m` and `tokens_cache_write_1h`.

Review:

A read-only reviewer confirms the migration is additive and dashboards still render.

## Future Work

- Refactor legacy prompt assembly in `packages/opencode/src/session/prompt.ts` and `packages/opencode/src/session/system.ts` if legacy traffic remains important.
- Normalize structured-output schemas before wrapping them as tools.
- Pin or digest dynamic Task tool descriptions and MCP tool lists per session.
- Evaluate Gemini explicit cached-content support.
- Consider adding tool/system digests to cache keys after measuring cross-session reuse.

## Open Questions

- Should variable context be a non-cacheable system part or a leading user-context block? Default: non-cacheable system part after the stable cache boundary.
- Should cache-write tokens affect cache-ratio dashboards? Default: no, expose write tokens separately.
- Is legacy prompt assembly in scope for the first implementation wave? Default: no, prioritize V2/core.
