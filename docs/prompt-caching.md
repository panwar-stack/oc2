# Prompt Caching

OC2 plans prompt caching from provider capabilities and lowers only the fields
that are valid for the selected provider. The goal is to reuse stable prompt
prefixes without leaking provider-specific cache controls across SDKs.

## Provider Behavior

| Provider                                      | Models                                               | Cache mode                          | Request fields                                 | Usage telemetry                | Notes                                                                                                            |
| --------------------------------------------- | ---------------------------------------------------- | ----------------------------------- | ---------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| OpenAI                                        | `gpt-4.1*`, `gpt-4o*`, `gpt-5*`, `o1*`, `o3*`, `o4*` | Automatic with explicit routing key | `prompt_cache_key`                             | Cached read and write tokens   | OC2 derives the key from the stable-prefix fingerprint and ignores manual keys.                                  |
| Anthropic                                     | `claude-*`                                           | Automatic plus explicit breakpoints | top-level and block-level `cache_control`      | Cache creation and read tokens | Defaults to the lower-write-cost `5m` ephemeral TTL. `1h` is opt-in.                                             |
| Moonshot / Kimi                               | `kimi*`, `moonshot*`                                 | Provider-managed automatic          | none                                           | unavailable                    | OC2 does not send OpenAI or Anthropic cache fields because verification is not conclusive.                       |
| DeepSeek                                      | `deepseek-*`                                         | Provider-managed automatic          | none                                           | Hit and miss tokens            | OC2 uses telemetry for diagnostics but does not send explicit OpenAI-compatible cache fields.                    |
| Alibaba Cloud Model Studio / DashScope (Qwen) | `qwen*`                                              | Explicit breakpoints                | block-level `cache_control` on message content | Cache creation and read tokens | Max 4 markers per request, 1024-token minimum, fixed 5-minute TTL; writes at 1.25x and reads at 0.1x base input. |
| Unknown                                       | unmatched provider/model                             | disabled                            | none                                           | unavailable                    | OC2 keeps fingerprints for diagnostics but treats caching as unsupported.                                        |

See [Providers And Models](providers.md#prompt-caching-compatibility) for the
same compatibility matrix in the provider guide.

### Alibaba Cloud Model Studio (DashScope) Qwen

Qwen models on the `alibaba`, `alibaba-cn`, `alibaba-coding-plan`, and
`alibaba-coding-plan-cn` providers cache explicitly. OC2 adds
`"cache_control": { "type": "ephemeral" }` to the stable system prompt
(system message) content. User and tool messages may also receive markers
when targeted by a cache policy. Assistant messages are not marked. Tool
definitions take no markers; DashScope caches them as part of the system
message.

- At most 4 markers take effect per request; only the last 4 count.
- The cacheable prefix must be at least 1024 tokens.
- A backward prefix search looks up to 20 preceding content blocks.
- Cache validity is fixed at 5 minutes and resets on each hit.
- Cache creation tokens bill at 125% of the standard input price; cache hits
  bill at 10%.

Usage telemetry reports `prompt_tokens_details.cached_tokens` (read) and
`prompt_tokens_details.cache_creation_input_tokens` (write) on the
OpenAI-compatible shape, or `cache_read_input_tokens` and
`cache_creation_input_tokens` on the Anthropic-compatible shape. OC2 surfaces
cache reads and writes in session usage and cost accounting.

DashScope also caches implicitly for supported models. Implicit caching is
automatic, cannot be disabled, and needs no OC2 configuration; OC2 sends no
fields for it.

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
- OpenAI does not receive default `prompt_cache_options`,
  `prompt_cache_breakpoint`, or `prompt_cache_retention` fields. GPT-5.6+
  cache writes can be billable, so explicit breakpoints are intentionally not a
  default cost-saving behavior.
- Anthropic receives top-level `cache_control` for automatic caching together
  with block-level `cache_control` on planned explicit breakpoints or
  pre-existing manual `CacheHint`s. Anthropic permits four cache controls per
  request, so OC2 preserves four explicit breakpoints and omits the automatic
  control when no slot remains.
- Alibaba/DashScope Qwen models receive block-level `cache_control` markers on
  planned explicit breakpoints in message content blocks.
- Moonshot/Kimi, DeepSeek, and unknown models receive no explicit prompt cache
  fields.

Provider-specific fields are scrubbed after plugin hooks. A plugin cannot add or
override `promptCacheKey` unless OC2 produced an eligible OpenAI cache plan.

## Telemetry And Classification

OC2 normalizes provider usage into cache telemetry with nullable fields for
read, write, miss, and uncached input tokens. Classifications include:

- `cache_hit`: conclusive telemetry reported cached input tokens for an
  eligible prompt-cache plan.
- `cache_write`: the provider created or refreshed cache state. This is normal
  during warmup and after provider retention expires.
- `expected_cache_miss`: OC2 expected the request not to hit cache, for example
  the first eligible request for a stable prefix, an explicit compaction miss,
  or a known retention-window miss.
- `unexpected_cache_miss`: telemetry showed a miss after the stable prefix was
  already expected to be warm.
- `cache_unsupported`: the provider/model does not have supported prompt-cache
  request fields or conclusive cache behavior.
- `cache_telemetry_unavailable`: the provider response did not include enough
  usage fields to verify cache behavior.
- `cache_configuration_error`: OC2 detected invalid or incompatible cache
  configuration before treating the response as a cache result.
- `provider_error`: the provider call failed, so cache behavior could not be
  verified.

Providers with conclusive telemetry, such as OpenAI and Anthropic, can verify
hits and writes. Providers without conclusive telemetry, such as Moonshot/Kimi
and best-effort DeepSeek flows, remain diagnostic rather than authoritative.

## Runtime Regression Checker

The runtime checker is separate from cache planning. Planning decides which
stable prompt prefix, routing key, and explicit breakpoints are eligible before a
request is sent. The checker observes completed requests and compares the
provider telemetry against the expectation for the already-planned stable-prefix
fingerprint.

For each eligible request, OC2 stores bounded expectation state keyed by
provider, model, stable-prefix fingerprint, and traffic partition. The state
tracks first and last observation time, eligible request count, reads, writes,
misses, telemetry gaps, warmup status, retention expiry, and component
fingerprints. It stores only fingerprints and counters, not prompt text, user
messages, tool output, or other prompt content.

Regression statuses are:

- `pass`: a hit or otherwise valid cache result matched the expectation.
- `warmup`: the provider wrote cache during the configured warmup window.
- `expected_miss`: the miss was known in advance, such as first use,
  compaction, or retention expiry.
- `unexpected_miss`: conclusive telemetry reported a miss after the prefix was
  expected to be warm.
- `unsupported`: the plan or provider does not support verified prompt caching.
- `inconclusive`: telemetry was missing or the provider failed, so OC2 cannot
  prove a regression.

### Expected warmup behavior

Supported providers normally need at least one eligible request to populate the
cache. During this warmup window, cache writes and first-request misses are
expected and should not be treated as regressions. Providers with fixed retention
windows, such as Anthropic's default ephemeral cache, can also return expected
misses after expiry. Providers without conclusive telemetry may stay
`inconclusive` even when caching is working.

### Self-healing actions and rollback

Self-healing consumes only regression results, safe fingerprints, telemetry
counts, and diagnostic component names. It never retries or alters an in-flight
user request just to improve caching. Actions apply only to future requests and
are bounded by thresholds, cooldowns, and TTLs so they can roll back
automatically when the action expires or a pass resets the relevant counters.

Possible actions are:

- `emit_warning`: warn that repeated unexpected misses correlate with volatile
  stable-prefix components or tool/schema churn. Operators should move dynamic
  content behind the cache boundary or stabilize tool schema order and
  definitions.
- `rotate_cache_partition`: rotate the future routing-key partition for a stable
  prefix after repeated stable-prefix mismatches.
- `disable_explicit_cache`: temporarily disable future explicit cache markers for
  a provider/model after repeated provider errors.

In opencode, the policy is off by default and can be enabled in observe-only mode
with `OC2_EXPERIMENTAL_PROMPT_CACHE_SELF_HEALING`. In observe mode, OC2 records
and logs the action it would take without changing future request plans. The LLM
policy also supports an explicit enforce mode for callers that opt into applying
active actions to future plans. Rollback is automatic: expired interventions are
pruned, and successful cache observations reset non-provider-error counters.

## Guardrails, State, And Diagnostics

Prompt caching guardrails detect unsupported request fields, provider field
leakage, invalid durations, breakpoint overflow, incompatible cache key reuse,
unstable prefix changes, and retry prefix changes.

Definitely invalid request fields and incompatible cache-key reuse fail before
the provider call. Ambiguous cases, breakpoint overflow, and prefix changes are
recorded as warning logs. When OC2 runs inside the TUI and the event bridge is
available, warning/error toast events are also published on that existing TUI
notification channel; non-TUI and headless runs should rely on logs.

The shared cache layer exposes bounded expectation-state helpers keyed by safe
fingerprints. Runtime session metadata records cache-affecting retry and
lifecycle changes without storing prompt content. Diagnostics use the available
plan, telemetry, and lifecycle fingerprints to identify changed components,
explain why caching was not verified, and suggest corrective action when
possible.

When OC2 runs in an interactive TUI with the event bridge available, runtime
cache warnings and errors can also appear as Prompt Cache toast notifications.
Headless and non-TUI runs should use structured logs and cache-regression events.

## Cost Impact

Assistant usage keeps cache read and write tokens separate from uncached input
and output tokens. Session stats output, ACP usage updates, and compaction
accounting include cache tokens so users can see prompt-cache reads, writes,
and provider cost discounts where the model catalog exposes cache read and write
rates.

Cache writes may cost more on providers such as Anthropic and GPT-5.6+ OpenAI
models. Anthropic defaults to the `5m` ephemeral TTL, whose cache writes cost
1.25x base input, instead of `1h`, whose cache writes cost 2x base input. The
`1h` TTL is an explicit opt-in for workloads that value reuse across longer
gaps enough to accept the higher write cost. The lower default write cost does
not guarantee savings; net cost depends on reuse and cache-read discounts. OC2
reports the usage it observes rather than assuming savings.

## Lifecycle

Prompt caching is enabled automatically for supported providers. Stable prompt
changes create a new fingerprint and therefore a new cache expectation. Dynamic
conversation turns should not perturb the stable prefix. If a retry changes the
stable prefix, OC2 treats it as a warning instead of an exact cache retry.
