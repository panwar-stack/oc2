# Prompt Caching

OC2 plans prompt caching from provider capabilities and lowers only the fields
that are valid for the selected provider. The goal is to reuse stable prompt
prefixes without leaking provider-specific cache controls across SDKs.

## Provider Behavior

| Provider | Models | Cache mode | Request fields | Usage telemetry | Notes |
| --- | --- | --- | --- | --- | --- |
| OpenAI | `gpt-4.1*`, `gpt-4o*`, `gpt-5*`, `o1*`, `o3*`, `o4*` | Automatic with explicit routing key | `prompt_cache_key` | Cached read and write tokens | OC2 derives the key from the stable-prefix fingerprint and ignores manual keys. |
| Anthropic | `claude-*` | Explicit breakpoints | `cache_control` | Cache creation and read tokens | Supports up to four breakpoints and `5m` or `1h` ephemeral TTLs. Haiku uses a 2048-token minimum prefix; other Claude models use 1024. |
| Moonshot / Kimi | `kimi*`, `moonshot*` | Provider-managed automatic | none | unavailable | OC2 does not send OpenAI or Anthropic cache fields because verification is not conclusive. |
| DeepSeek | `deepseek-*` | Provider-managed automatic | none | Hit and miss tokens | OC2 uses telemetry for diagnostics but does not send explicit OpenAI-compatible cache fields. |
| Unknown | unmatched provider/model | disabled | none | unavailable | OC2 keeps fingerprints for diagnostics but treats caching as unsupported. |

See [Providers And Models](providers.md#prompt-caching-compatibility) for the
same compatibility matrix in the provider guide.

## Planning And Fingerprints

Every request gets a `CachePlan` before provider lowering. The planner separates
stable prefix material from dynamic content:

- Stable: OC2 system guidance, configured agent prompt, enabled tools, and
  messages explicitly marked stable.
- Dynamic: current user turns, tool results, unmarked system text, timestamps,
  and other per-request content.

The stable prefix is canonicalized into component fingerprints and a combined
stable-prefix fingerprint. Dynamic user turns and volatile routing fields such as
manual prompt cache keys or request IDs are excluded, so retries and follow-up
turns can keep the same prefix when the stable prompt did not change.

OpenAI-compatible routing keys use the `oc2-v1-...` prefix and are derived only
from the stable-prefix fingerprint. Unknown models still receive fingerprints for
diagnostics, but the plan is disabled and no cache key is produced.

## Provider Lowering

OC2 lowers the shared plan into provider-local wire fields:

- OpenAI receives `prompt_cache_key` only for known OpenAI models with an
  eligible plan.
- Anthropic receives `cache_control` only on planned explicit breakpoints or on
  pre-existing manual `CacheHint`s.
- Moonshot/Kimi, DeepSeek, and unknown models receive no explicit prompt cache
  fields.

Provider-specific fields are scrubbed after plugin hooks. A plugin cannot add or
override `promptCacheKey` unless OC2 produced an eligible OpenAI cache plan.

## Telemetry And Classification

OC2 normalizes provider usage into cache telemetry with nullable fields for
read, write, miss, and uncached input tokens. Classifications include:

- `cache_hit`
- `cache_write`
- `expected_cache_miss`
- `unexpected_cache_miss`
- `cache_unsupported`
- `cache_telemetry_unavailable`
- `cache_configuration_error`
- `provider_error`

Providers with conclusive telemetry, such as OpenAI and Anthropic, can verify
hits and writes. Providers without conclusive telemetry, such as Moonshot/Kimi
and best-effort DeepSeek flows, remain diagnostic rather than authoritative.

## Guardrails, State, And Diagnostics

Prompt caching guardrails detect unsupported request fields, provider field
leakage, invalid durations, breakpoint overflow, incompatible cache key reuse,
unstable prefix changes, and retry prefix changes.

The shared cache layer exposes bounded expectation-state helpers keyed by safe
fingerprints. Runtime session metadata records cache-affecting retry and
lifecycle changes without storing prompt content. Diagnostics use the available
plan, telemetry, and lifecycle fingerprints to identify changed components,
explain why caching was not verified, and suggest corrective action when
possible.

## Cost Impact

Assistant usage keeps cache read and write tokens separate from uncached input
and output tokens. Session stats, ACP usage updates, and compaction accounting
include cache tokens so users can see prompt-cache impact and provider cost
discounts where the model catalog exposes cache read and write rates.

Cache writes may cost more on providers such as Anthropic. Cache reads usually
receive discounts, but OC2 reports the provider usage it observes rather than
assuming savings when telemetry is unavailable.

## Lifecycle

Prompt caching is enabled automatically for supported providers. Stable prompt
changes create a new fingerprint and therefore a new cache expectation. Dynamic
conversation turns should not perturb the stable prefix. If a retry changes the
stable prefix, OC2 treats it as a warning instead of an exact cache retry.
