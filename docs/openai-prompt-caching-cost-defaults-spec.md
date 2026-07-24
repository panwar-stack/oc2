# OpenAI Prompt Caching Cost Defaults

## Goal

Fill the OpenAI prompt caching gaps with conservative cost-saving defaults. OC2 should continue to use deterministic `prompt_cache_key` routing for first-party OpenAI, improve accounting correctness, and avoid default settings that can add billable cache writes without proven savings.

First pass must favor implicit keyed caching over explicit OpenAI breakpoints. Explicit OpenAI breakpoint support, `prompt_cache_options`, and legacy `prompt_cache_retention` should be designed as capability-gated future work, not enabled by default.

## Current State

- `packages/opencode/src/provider/transform.ts` already adds `promptCacheKey` from the cache plan for OpenAI.
- `packages/opencode/src/session/llm/request.ts` scrubs manual `promptCacheKey` / `prompt_cache_key` and replaces it with the planned key.
- `packages/llm/src/protocols/openai-responses.ts` lowers only `prompt_cache_key` for OpenAI Responses.
- `packages/llm/src/protocols/openai-chat.ts` lowers only `prompt_cache_key` for Chat Completions.
- `packages/llm/src/cache/capability.ts` marks OpenAI as `supportsBreakpoints: false`, `supportsDuration: false`, and `requestFields: ["prompt_cache_key"]`.
- `packages/llm/src/protocols/openai-responses.ts` parses both `cached_tokens` and `cache_write_tokens`.
- `packages/llm/src/protocols/openai-chat.ts` parses `cached_tokens`, but direct OpenAI Chat does not count `cache_write_tokens`.
- `packages/opencode/src/session/llm/request.ts` joins stable system prompt content with dynamic context before sending the request, reducing reusable prefix stability.
- Tool definitions are sorted before provider execution, but cache planning fingerprints tools before the final sorted order.

## Non-Negotiables

- Default behavior must optimize for net cost savings, not maximum cache writes.
- Do not emit OpenAI `prompt_cache_options.mode: "explicit"` by default.
- Do not emit OpenAI `prompt_cache_breakpoint` by default.
- Do not emit legacy `prompt_cache_retention` by default.
- Continue replacing user-supplied OpenAI cache keys with deterministic OC2 keys for managed OpenAI defaults.
- Do not change Anthropic/Bedrock explicit cache behavior in this project.
- Do not add cache warmup requests or synthetic prefill requests.
- Do not share cache keys across providers, models, organizations, or incompatible tool/schema prefixes.
- Every implementation slice must get a fresh read-only adversarial review before merge.

## Cache Policy

### First-Party OpenAI Defaults

For first-party OpenAI models:

```ts
{
  prompt_cache_key: "oc2-v<planner-version>-<stable-prefix-fingerprint>"
}
```

Rules:

- Set `prompt_cache_key` when the cache planner produces a non-empty stable prefix.
- Include these inputs in the fingerprint:
  - provider ID
  - model ID
  - cache planner version
  - stable system prompt content
  - sorted tool schemas
  - relevant model/provider config that affects rendered prompt shape
- Do not forward user-provided `promptCacheKey` or `prompt_cache_key` for managed defaults.
- Do not set `prompt_cache_key` for OpenAI-compatible providers unless capability-approved.

### GPT-5.6+ Defaults

Default GPT-5.6+ to implicit keyed caching:

```json
{
  "prompt_cache_key": "oc2-v1-..."
}
```

Do not send this by default:

```json
{
  "prompt_cache_options": {
    "mode": "explicit"
  }
}
```

Rationale:

- OpenAI docs say GPT-5.6+ cache writes are billable at `1.25x`.
- Implicit keyed caching can improve routing without forcing explicit write points.
- Explicit breakpoints should be opt-in later, after telemetry proves net savings.

### Legacy Retention Defaults

Do not send:

```json
{
  "prompt_cache_retention": "24h"
}
```

Rationale:

- It is deprecated for GPT-5.6+.
- It may increase retention beyond what users expect.
- It should require an explicit provider capability and user opt-in if added later.

## Prompt Prefix Stability

- Sort tools before cache planning and before provider execution.
- Keep the stable prompt prefix separate from dynamic context where possible.
- Stable prefix candidates:
  - token budget guidance
  - agent/provider prompt
  - stable tool schemas
- Dynamic content must remain after the stable prefix:
  - workspace path
  - date
  - environment context
  - user-specific system additions
  - current conversation input
  - reminders

## Implementation Slices

### PR 1: Correct OpenAI Cache Key Determinism

- Sort tool definitions before calling `CachePlanner.planCache(...)` in `packages/opencode/src/session/llm/request.ts`.
- Add tests proving the generated OpenAI `prompt_cache_key` is stable when tool insertion order changes.
- Confirm user-supplied `promptCacheKey` / `prompt_cache_key` is still scrubbed and replaced.

Verification:

- `cd packages/opencode && bun test test/cache/*.test.ts --timeout 30000`
- `cd packages/opencode && bun run typecheck`
- `cd packages/llm && bun test test/cache/*.test.ts --timeout 30000`

Review:

A fresh read-only reviewer must compare the diff against this slice and confirm no OpenAI `prompt_cache_options`, `prompt_cache_breakpoint`, or `prompt_cache_retention` fields were added.

### PR 2: Fix Direct OpenAI Chat Cache Write Accounting

- Update `packages/llm/src/protocols/openai-chat.ts` so first-party OpenAI Chat counts `prompt_tokens_details.cache_write_tokens`.
- Add or update provider tests for direct OpenAI Chat usage parsing.
- Ensure `cache_write_tokens` flows into existing usage fields, not a new storage shape.

Verification:

- `cd packages/llm && bun test test/provider/openai-chat.test.ts --timeout 30000`
- `cd packages/llm && bun test test/cache/canonical.test.ts test/cache/cost.test.ts --timeout 30000`
- `cd packages/llm && bun run typecheck`

Review:

A fresh read-only reviewer must confirm cache writes are counted only from provider usage telemetry and no synthetic write estimates are introduced.

### PR 3: Document Cost-Saving OpenAI Cache Defaults

- Add docs covering OpenAI default behavior:
  - deterministic `prompt_cache_key`
  - no default `prompt_cache_options`
  - no default `prompt_cache_breakpoint`
  - no default `prompt_cache_retention`
- Mention GPT-5.6+ cache writes can be billable and explicit breakpoints are intentionally not default.
- Point users to stats output that reports cache read/write tokens.

Docs candidates:

- `packages/opencode/README.md`
- `docs/prompt-caching.md`

Verification:

- `cd packages/opencode && bun run typecheck`
- `cd packages/opencode && bun test test/cli/run/session-data.test.ts test/cli/run/footer.view.test.tsx --timeout 30000`

Review:

A fresh read-only reviewer must check that docs do not promise manual cache-key control or explicit breakpoint support.

### PR 4: Prepare Capability-Gated OpenAI Explicit Cache Design

- Add type-level support only if needed, but keep runtime default disabled.
- Define capability fields for future OpenAI explicit support without changing current OpenAI behavior:
  - `supportsPromptCacheOptions`
  - `supportsPromptCacheBreakpoints`
  - `supportsPromptCacheRetention`
- Add guardrail tests proving unsupported OpenAI fields are rejected or dropped unless capability-enabled.
- Do not emit `prompt_cache_options`, `prompt_cache_breakpoint`, or `prompt_cache_retention` from default OpenAI paths.

Verification:

- `cd packages/llm && bun test test/cache/capability.test.ts test/cache/guardrails.test.ts test/cache/provider-lowering.test.ts --timeout 30000`
- `cd packages/llm && bun run typecheck`
- `cd packages/opencode && bun test test/cache/*.test.ts --timeout 30000`

Review:

A fresh read-only reviewer must confirm this PR is preparatory only and does not alter first-party OpenAI request payloads except existing `prompt_cache_key`.

## Future Work

- Add opt-in OpenAI explicit breakpoint support after telemetry proves net savings for GPT-5.6+.
- Add `prompt_cache_options.ttl` only when OpenAI supports useful values beyond the default `30m`.
- Add `prompt_cache_retention` only behind explicit user opt-in and provider capability.
- Split stable and dynamic system messages more deeply if provider rendering preserves the intended prefix.
- Add cache efficiency reporting that compares `cache_write_tokens` cost against later `cached_tokens` savings.

## Open Questions

- Should OC2 expose manual OpenAI cache keys later?
  - Default: no. Deterministic OC2-managed keys are safer and avoid accidental high-traffic key collisions.
- Should explicit OpenAI breakpoints be enabled for GPT-5.6+ immediately?
  - Default: no. Use implicit keyed caching first because explicit writes can be billable.
- Should legacy `prompt_cache_retention: "24h"` be exposed?
  - Default: no. Keep it out of the cost-saving default path unless a user explicitly opts in.
