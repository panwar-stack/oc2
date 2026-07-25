# @oc2-ai/llm

Schema-first LLM core for opencode. One typed request, response, event, and tool language; provider quirks live in adapters, not in calling code.

```ts
import { Effect } from "effect"
import { LLM, LLMClient } from "@oc2-ai/llm"
import { OpenAI } from "@oc2-ai/llm/providers"

const model = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).responses("gpt-4o-mini")

const request = LLM.request({
  model,
  system: "You are concise.",
  prompt: "Say hello in one short sentence.",
  generation: { maxTokens: 40 },
})

const program = Effect.gen(function* () {
  const response = yield* LLMClient.generate(request)
  console.log(response.text)
})
```

Run `LLMClient.stream(request)` instead of `generate` when you want incremental `LLMEvent`s. The event stream is provider-neutral — same shape across OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini, Bedrock Converse, and any OpenAI-compatible deployment.

## Public API

- **`LLM.request({...})`** — build a provider-neutral `LLMRequest`. Accepts ergonomic inputs (`system: string`, `prompt: string`) that normalize into the canonical Schema classes.
- **`LLM.generate` / `LLM.stream`** — re-exported from `LLMClient` for one-import use.
- **`Message.user(...)` / `Message.assistant(...)` / `Message.tool(...)`** — message constructors from the canonical schema model.
- **`Model.make(...)` / `ToolCallPart.make(...)` / `ToolResultPart.make(...)` / `ToolDefinition.make(...)`** — model and tool-related constructors from the canonical schema model.
- **`LLMClient.prepare(request)`** — compile a request through protocol body construction, validation, and HTTP preparation without sending. Useful for inspection and testing.
- **`LLMEvent.is.*`** — typed guards (`is.textDelta`, `is.toolCall`, `is.finish`, …) for filtering streams.

## Caching

Prompt caching is planned for every `LLMRequest` from provider/model
capabilities. Supported providers get a `CachePlan` containing the stable-prefix
fingerprint, eligibility, provider-specific request fields, and any explicit
breakpoints. Unsupported or unknown providers keep fingerprints for diagnostics
but send no cache controls.

### Auto placement

`"auto"` separates stable prefix material from dynamic request content. Stable
material includes system guidance, configured agent prompt, enabled tools, and
messages explicitly marked stable. Dynamic material includes current user turns,
tool results, timestamps, request IDs, and manual cache keys.

Provider lowering is intentionally narrow:

- OpenAI-compatible routes receive `prompt_cache_key` only when the selected
  model supports that request field. The key is derived from the stable-prefix
  fingerprint; manual keys are scrubbed.
- Anthropic receives `cache_control` only for planned explicit breakpoints or
  existing manual `CacheHint`s, with the provider breakpoint cap enforced.
- Providers with provider-managed automatic caching, unsupported models, and
  unknown models receive no explicit cache fields.

Cache writes can have additional cost on some providers, while reads often have
discounts. Use normalized cache usage instead of assuming savings when telemetry
is unavailable.

### Opting out

```ts
LLM.request({
  model,
  system,
  prompt: "one-off question",
  cache: "none",
})
```

### Granular policy

```ts
cache: {
  tools?: boolean,
  system?: boolean,
  messages?: "latest-user-message" | "latest-assistant" | { tail: number },
  ttlSeconds?: number,         // ≥ 3600 → 1h on Anthropic/Bedrock; else 5m
}
```

### Manual hints

Inline `CacheHint` on any text / system / tool / tool-result part overrides automatic placement. The auto policy preserves manual hints; it only fills gaps.

```ts
LLM.request({
  model,
  system: [
    { type: "text", text: "stable system prompt", cache: { type: "ephemeral" } },
  ],
  ...
})
```

### Provider behavior table

| Protocol / provider     | `cache: "auto"` |
| ----------------------- | ---------------- |
| OpenAI Chat / Responses | Sends a derived `prompt_cache_key` for supported OpenAI models and reads cached/write token telemetry when present. |
| Anthropic Messages      | Emits planned `cache_control` markers within the 4-breakpoint cap and reads cache creation/read token telemetry. |
| Bedrock Converse        | Emits `cachePoint` blocks from hints/plans where supported by the route. |
| Gemini                  | Does not send inline markers; explicit `CachedContent` is out-of-band. |
| Unknown/unsupported     | Sends no explicit cache fields and reports diagnostics only. |

Normalized cache usage is read back into `response.usage.cacheReadInputTokens` and `cacheWriteInputTokens` across every provider.

### Runtime regression checks

When telemetry is available, the runtime records bounded expectation state keyed
by provider, model, stable-prefix fingerprint, and traffic partition. It
classifies results as hits, writes, expected misses, unexpected misses,
unsupported cache, telemetry unavailable, configuration errors, or provider
errors. First eligible requests and cache writes during provider warmup are
expected; repeated misses after warmup can produce diagnostics.

Self-healing is driven by those diagnostics, not by prompt content. Policies are
off unless a caller enables observe or enforce mode. Observe mode reports the
future action it would take. Enforce mode applies actions only to future request
plans: warning on volatile prefixes or schema churn, rotating a cache partition
after repeated stable-prefix mismatches, or temporarily disabling explicit cache
markers after repeated provider errors. Actions are bounded by thresholds,
cooldowns, and TTLs, and roll back when they expire or successful cache
observations reset counters.

## Providers

Provider facades configure endpoint/auth/deployment details first, then expose model selectors that take only a model or deployment id. The selected model carries the executable route value used at runtime.

```ts
import { OpenAI, CloudflareAIGateway } from "@oc2-ai/llm/providers"

const openai = OpenAI.configure({ apiKey: process.env.OPENAI_API_KEY }).responses("gpt-4o-mini")
const gateway = CloudflareAIGateway.configure({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  gatewayApiKey: process.env.CLOUDFLARE_API_TOKEN,
}).model("workers-ai/@cf/meta/llama-3.1-8b-instruct")
```

Included providers: OpenAI, Anthropic, Google (Gemini), Amazon Bedrock, Azure OpenAI, Cloudflare AI Gateway, Cloudflare Workers AI, GitHub Copilot, OpenRouter, xAI, plus generic OpenAI-compatible helpers for DeepSeek, Cerebras, Groq, Fireworks, Together, etc.

## Provider options & HTTP overlays

Three escape hatches in order of stability:

1. **`generation`** — portable knobs (`maxTokens`, `temperature`, `topP`, `topK`, penalties, seed, stop).
2. **`providerOptions: { <provider>: {...} }`** — typed-at-the-facade provider-specific knobs (OpenAI Chat/Responses `promptCacheKey`, Anthropic `thinking`, Gemini `thinkingConfig`, OpenRouter routing).
3. **`http: { body, headers, query }`** — last-resort serializable overlays merged into the final HTTP request. Reach for this only when a stable typed path doesn't yet exist.

Route/provider defaults are overridden by request-level values for each axis.

## Routes

Adding a new model or deployment is usually 5-15 lines using `Route.make({ protocol, endpoint, auth, framing, ... })`. The route owns endpoint/auth/framing and the protocol owns body construction plus stream parsing. Transports are reusable IO templates that receive route endpoint/auth at compile time. Capability/catalog metadata lives outside this low-level package; unsupported request shapes fail during protocol lowering. See `AGENTS.md` for the architectural detail.

## Effect

This package is built on Effect. Public methods return `Effect` or `Stream`; provide `LLMClient.layer` for runtime dispatch and import the provider/protocol modules for the routes you use. The example at `example/tutorial.ts` is a runnable walkthrough.

## See also

- `AGENTS.md` — architecture, route construction, contributor guide
- `example/tutorial.ts` — runnable end-to-end walkthrough
- `test/provider/*.test.ts` — fixture-first protocol tests; `*.recorded.test.ts` files cover live cassettes
