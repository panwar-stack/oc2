# Virtual Fugu Proxy Model Audit Gaps

Status note: implemented. This audit originally captured follow-up gaps after the base Fugu proxy landed; the current code has addressed the request-time validation, virtual-provider visibility, hidden-stage tool handling, synthesizer failure logging, and missing coverage items described here.

## Goal

Document the audited Fugu follow-up behavior as implemented, without redesigning the virtual model. Fugu remains a virtual selectable model, non-`fugu` model behavior remains unchanged, and strict validation happens when `fugu/fugu` is selected.

## Implemented Behavior

### Config Validation

- `packages/core/src/config/fugu.ts` uses a permissive schema: branch, judge, and synthesizer `model` fields are optional at parse time.
- Config parsing accepts incomplete or malformed Fugu targets so opencode can start and generated SDK decoding can succeed.
- `packages/opencode/src/session/llm/fugu.ts` is the strict validation boundary.
- Selecting `fugu/fugu` fails before provider requests start when config is missing, branches are empty, the synthesizer is missing, a target model is missing or malformed, a target cannot be resolved, variants are missing/invalid, or any target points to `fugu/fugu`.
- Public docs still describe `model` as required for a usable Fugu configuration.

### Hidden Stage Tool Handling

- Branch and judge stages receive caller tool definitions with `execute` removed, so tool calls from those stages are private suggestions only.
- Branch and judge requests set `forbidImplicitTools: true`, which prevents request preparation from adding compatibility tools such as Copilot `_noop`.
- The synthesizer receives the caller's executable tools and `toolChoice`, sets `forbidImplicitTools: false`, and is the only stage whose tool calls can become session-visible.
- Normal non-`fugu` Copilot requests keep the existing `_noop` compatibility behavior when prior history contains tool calls and no tools are otherwise enabled.

### Virtual Provider Visibility

- Legacy provider lists and model pickers include a connected virtual `fugu` provider/model without requiring a `fugu` config block.
- `enabled_providers` does not hide virtual Fugu. Non-`fugu` providers still respect `enabled_providers` and `disabled_providers` as before.
- `disabled_providers: ["fugu"]` remains the explicit virtual Fugu opt-out.
- The v2 catalog path exposes the same virtual provider/model through `packages/core/src/plugin/fugu.ts`.

### Synthesizer Failure Logging

- Emitted `provider-error` events and thrown synthesizer stream failures both publish failed Fugu status and log Fugu-specific synthesizer failure metadata.
- Failure logging includes the synthesizer target and error message.
- Logs avoid full prompts, branch responses, synthesizer response text, provider keys, and stack traces by default.

### Coverage

- Config parse and v1 migration coverage lives in `packages/opencode/test/config/config.test.ts`.
- Legacy provider visibility, `enabled_providers`, `disabled_providers`, and default-model behavior are covered in `packages/opencode/test/provider/provider.test.ts`.
- Runtime validation, hidden-stage tool handling, synthesizer tool visibility, branch tool-call proposals, judge guidance, status events, and failure paths are covered in `packages/opencode/test/session/llm.test.ts`.
- v2 `/api/model` and `/api/provider` Fugu visibility is covered by `packages/opencode/test/server/httpapi-v2-fugu-model-provider.test.ts`.
- TUI model parsing and picker visibility are covered by `packages/tui/test/util/model.test.ts` and `packages/tui/test/cli/cmd/tui/model-options.test.ts`.

## Current Constraints

- Do not add nested Fugu routing; branch, judge, and synthesizer targets must not resolve to `fugu/fugu`.
- Do not execute tools from private branch or judge stages.
- Do not expose branch output, judge guidance, model IDs, variants, private tool proposals, prompts, provider keys, stack traces, or branch errors through UI status.
- Do not change default model selection to Fugu.

## Future Work

- Add configurable branch timeouts only with a separate runtime policy design.
- Add richer tool-policy controls only with a reviewed design that preserves the private-stage safety boundary.
- Add debug-only expanded observability behind explicit debug controls if needed.

## Open Questions

- Should `disabled_providers: ["fugu"]` continue to hide the virtual model? Current behavior: yes.
- Should generated SDK types remain permissive for Fugu target models? Current behavior: yes, because runtime validation owns user-facing errors.
