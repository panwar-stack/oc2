# Providers And Models

OC2 builds its available model list at startup. It combines the current
models.dev catalog with provider and model entries from configuration, plugin
contributions, saved credentials, and recognized credential environment
variables. The catalog changes over time, so use the CLI rather than a fixed
provider list:

```sh
oc2 providers list
oc2 models
oc2 models anthropic
```

`enabled_providers` limits discovery to the named provider IDs, while
`disabled_providers` removes named providers. A disabled provider takes
precedence. See [Configuration](configuration.md) for configuration locations,
source order, and merge behavior.

## Authentication

`providers` is also available as `auth`:

```sh
oc2 providers login
oc2 providers login --provider anthropic
oc2 providers list
oc2 providers logout anthropic
```

`login` offers the methods supplied by the selected provider or its plugin,
such as an API key or OAuth flow. `list` shows saved credentials and recognized
provider environment variables without printing their values. `logout`
removes a saved credential; it does not unset environment variables.

For supported credential variables and other environment controls, see the
[Environment Reference](reference/environment.md). Do not put literal secrets
in committed configuration.

### Tinker Connect

Select Tinker in Connect and enter your API key. `TINKER_API_KEY` is the
credential name for environment-based configuration. The preset supplies
Tinker's fixed base URL, so you do not need to configure an endpoint.

Tinker provides `tinker/thinkingmachines/Inkling`, with normal streaming chat
and tool support.

## Select A Model

Model IDs use `provider/model` form. List the IDs currently available to this
OC2 instance before selecting one:

```sh
oc2 models --refresh
oc2 models openai
oc2 run --model openai/gpt-5 "Summarize this project"
```

`--verbose` adds model metadata to `oc2 models` output. In the TUI, use the
model picker described in the [TUI Guide](tui.md). To set project defaults, use
the singular V1 keys `model` and `small_model`:

<!-- docs-check: oc2 -->

```jsonc
{
  "$schema": "https://oc2.ai/config.json",
  "model": "anthropic/claude-sonnet-4-6",
  "small_model": "anthropic/claude-haiku-4-5",
}
```

An agent or configured command can set its own `model`. If no model is set for
a request, OC2 first considers a recent model that is still available, then an
available model from an eligible provider. Configure `model` when a stable
default matters.

## Configure A Provider

Use the singular `provider` map. Existing catalog entries can be narrowed or
overridden with `whitelist`, `blacklist`, `options`, and `models`:

<!-- docs-check: oc2 -->

```jsonc
{
  "$schema": "https://oc2.ai/config.json",
  "provider": {
    "anthropic": {
      "whitelist": ["claude-sonnet-4-6", "claude-haiku-4-5"],
      "options": {
        "timeout": 60000,
      },
    },
  },
}
```

Custom OpenAI-compatible endpoints need a provider package, base URL, model
definitions, and a credential source:

<!-- docs-check: oc2 -->

```jsonc
{
  "$schema": "https://oc2.ai/config.json",
  "model": "acme/chat-v1",
  "provider": {
    "acme": {
      "name": "Acme gateway",
      "npm": "@ai-sdk/openai-compatible",
      "env": ["ACME_API_KEY"],
      "options": {
        "baseURL": "https://llm.acme.example/v1",
      },
      "models": {
        "chat-v1": {
          "name": "Chat v1",
          "limit": {
            "context": 128000,
            "output": 8192,
          },
        },
      },
    },
  },
}
```

Set `ACME_API_KEY` as described in the
[Environment Reference](reference/environment.md). Provider-specific options
are passed to the provider SDK; consult that provider's documentation before
adding them. Plugins that add providers or authentication are covered in
[Extensions](extensions.md).

## Prompt Caching Compatibility

OC2 plans prompt caching per provider and only sends request fields that the
selected provider supports. See [Prompt Caching](prompt-caching.md) for the
planner, telemetry, diagnostics, guardrails, lifecycle, and cost details.

| Provider | Models | Cache mode | Request fields | Usage telemetry | Verification |
| --- | --- | --- | --- | --- | --- |
| OpenAI | `gpt-4.1*`, `gpt-4o*`, `gpt-5*`, `o1*`, `o3*`, `o4*` | Automatic with OC2-derived routing key | `prompt_cache_key` | cached read and write tokens | conclusive |
| Anthropic | `claude-*` | Explicit breakpoints | `cache_control` | cache creation and read tokens | conclusive |
| Moonshot / Kimi | `kimi*`, `moonshot*` | Provider-managed automatic | none | unavailable | best effort |
| DeepSeek | `deepseek-*` | Provider-managed automatic | none | hit and miss tokens | best effort |
| Unknown providers or models | unmatched | disabled | none | unavailable | unavailable |

Provider-specific cache fields are not portable. For example, OC2 will not send
OpenAI `prompt_cache_key` to Kimi or DeepSeek OpenAI-compatible endpoints, and
will not send Anthropic `cache_control` outside providers that accept explicit
breakpoints.

For first-party OpenAI, OC2 derives a deterministic `prompt_cache_key` from the
stable prompt prefix when the selected model supports it. OC2 does not send
default OpenAI `prompt_cache_options`, `prompt_cache_breakpoint`, or legacy
`prompt_cache_retention` fields. GPT-5.6+ cache writes can be billable, so
explicit breakpoints are not enabled by default. Use session stats output to see
reported cache read and write tokens.
