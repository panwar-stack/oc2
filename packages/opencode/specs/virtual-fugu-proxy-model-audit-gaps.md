# Virtual Fugu Proxy Model Audit Gaps

Status note: this audit captured first-pass hidden-tool constraints. Current behavior keeps private branch/judge stages non-executing, but may pass caller tool definitions to them as suggestions; only the synthesizer receives executable tools and returns caller-visible tool calls.

## Goal

Close the audited implementation gaps in `packages/opencode/specs/virtual-fugu-proxy-model.md` without redesigning the Fugu proxy model. The follow-up work must preserve the existing virtual model approach, keep non-`fugu` model behavior unchanged, and make the original spec's request-time validation, no-hidden-tools, visibility, logging, and coverage requirements deterministic.

## Current State

- `packages/opencode/specs/virtual-fugu-proxy-model.md` requires missing or invalid `fugu` config to fail at request time, before provider requests start.
- `packages/core/src/config/fugu.ts:5` currently enforces a `provider/model` regex in the config schema, and `packages/core/src/config/fugu.ts:7` makes each target `model` required. Because this schema is wired through `packages/core/src/config.ts:111` and `packages/core/src/v1/config/config.ts:117`, malformed `fugu` targets can fail while loading config rather than when selecting `fugu/fugu`.
- `packages/opencode/src/session/llm/fugu.ts:84` and `packages/opencode/src/session/llm/fugu.ts:151` clear tools for synthesizer and branch requests, but `packages/opencode/src/session/llm/request.ts:148` can re-add an executable `_noop` tool for `github-copilot` histories that contain prior tool calls.
- `packages/opencode/src/provider/provider.ts:1395` applies `enabled_providers` as an allowlist, and `packages/opencode/src/provider/provider.ts:1616` injects virtual `fugu` only when that allowlist permits it. `packages/opencode/test/provider/provider.test.ts:126` currently asserts this behavior.
- `packages/opencode/src/session/llm/fugu.ts:92` logs synthesizer `finish` and emitted `provider-error` events, but thrown stream failures can bypass Fugu-specific failure logging and fall through to the generic stream error path in `packages/opencode/src/session/llm.ts:301`.
- Existing coverage includes config, provider, catalog, app model context, LLM adapter, and processor tests, but there is no TUI-specific picker visibility test and no server-level v2 `/api/model` or `/api/provider` Fugu endpoint test.

## Non-Negotiables

- Config parse must accept the top-level `fugu` object well enough for opencode to start; selecting `fugu/fugu` must perform strict request-time validation and return a clear configuration error.
- Branch, judge, and synthesizer validation must still reject missing targets, malformed model strings, invalid target models, missing required variants, invalid variants, and circular `fugu/fugu` targets before any branch or synthesizer provider request starts.
- Branch and synthesizer requests must not receive executable tools in the first pass, including compatibility shims such as `_noop`.
- `fugu` must remain selectable without a `fugu` config. Default behavior: `enabled_providers` must not hide virtual `fugu`; `disabled_providers: ["fugu"]` may explicitly hide it.
- Logs must include Fugu selection, branch count, branch target names, branch success/failure, synthesizer target, and synthesizer success/failure without full prompts, responses, provider keys, or stack traces by default.
- Do not add judge execution, nested `fugu`, branch timeouts, tool policy, prompt customization, provider-specific routing, or a new target model registry in this follow-up.

## Required Behavior

### Config Validation

- Keep the public `fugu` shape aligned with the base spec, but make the parse schema permissive enough to defer validation:

```ts
fugu?: {
  branches?: Array<{
    model?: string
    variant?: string
  }>
  judge?: {
    model?: string
    variant?: string
  }
  synthesizer?: {
    model?: string
    variant?: string
  }
}
```

- `packages/opencode/src/session/llm/fugu.ts` must be the strict runtime validation boundary.
- Missing `model`, empty model strings, strings without both provider and model components, and unresolved targets must produce clear Fugu configuration errors.
- Validation must complete for branches, judge, and synthesizer before `execute(...)` is called for any branch or synthesizer request.
- Docs in `packages/web/src/content/docs/config.mdx` should continue to document `model` as required for a usable `fugu` configuration, even if generated types are permissive to support request-time failure.

### Hidden Tool Prevention

- Branch and synthesizer requests must pass an internal signal to request preparation that disables implicit compatibility tools.
- `packages/opencode/src/session/llm/request.ts` must skip the Copilot `_noop` injection when that internal signal is set.
- The change must preserve the current `_noop` behavior for normal non-`fugu` Copilot requests.

### Virtual Provider Visibility

- Virtual `fugu` should be additive to legacy provider lists and model pickers even when `enabled_providers` is configured.
- `disabled_providers: ["fugu"]` should remain the explicit escape hatch unless reviewers decide the virtual model must be impossible to hide.
- Non-`fugu` providers must keep the existing `enabled_providers` and `disabled_providers` behavior.

### Synthesizer Failure Logging

- Fugu synthesizer logging must cover both emitted `provider-error` events and thrown stream failures.
- The failure log must include the synthesizer target model and variant when present.
- The failure log must not include full prompts, branch responses, synthesizer response text, provider keys, or stack traces by default.

## Implementation Slices

### PR 1: Request-Time Config Validation And Visibility

- Relax `packages/core/src/config/fugu.ts` so malformed or incomplete Fugu targets can survive config parsing and generated SDK decoding.
- Keep `fugu` wired through `packages/core/src/config.ts` and `packages/core/src/v1/config/config.ts`.
- Update `packages/opencode/src/session/llm/fugu.ts` validation to reject missing target model, malformed target model, unresolved model, invalid required variant, invalid supplied variant, and circular `fugu/fugu` before any provider request starts.
- Update `packages/opencode/src/provider/provider.ts` so virtual `fugu` is visible when `enabled_providers` omits it, while preserving `disabled_providers: ["fugu"]` unless the open question below is resolved differently.
- Update tests in `packages/opencode/test/config/config.test.ts`, `packages/opencode/test/session/llm.test.ts`, and `packages/opencode/test/provider/provider.test.ts` for permissive parse, strict runtime failure, and allowlist visibility.
- Update `packages/web/src/content/docs/config.mdx` if generated type optionality could confuse users.
- Regenerate SDK types after schema changes.

Verification:

- `cd packages/core && bun typecheck`
- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/config/config.test.ts test/session/llm.test.ts test/provider/provider.test.ts --timeout 30000`
- `./packages/sdk/js/script/build.ts`

Review:

Run a fresh read-only sub-agent/teammate against the PR diff and this spec. Verify config parse no longer rejects incomplete `fugu`, runtime validation fails before provider requests, `fugu` remains visible with `enabled_providers`, and non-`fugu` provider filtering is unchanged.

### PR 2: Hidden Tool And Synthesizer Failure Logging Fixes

- Add a narrow internal request flag or equivalent mechanism so Fugu branch and synthesizer calls can forbid implicit tools.
- Set that flag from `packages/opencode/src/session/llm/fugu.ts` for both branch and synthesizer requests.
- Update `packages/opencode/src/session/llm/request.ts` so Copilot `_noop` injection is skipped only for requests that explicitly forbid implicit tools.
- Add tests where a Fugu branch or synthesizer target is `github-copilot/...`, prior history contains tool-call/tool-result parts, and the outgoing provider request still contains no tools.
- Wrap or observe the synthesizer stream so thrown stream failures produce a Fugu-specific failure log with synthesizer target annotations.
- Add a failure-log test for thrown synthesizer stream errors, not only emitted `provider-error` events.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/opencode && bun test test/session/llm.test.ts --timeout 30000`

Review:

Run a fresh read-only sub-agent/teammate against the PR diff and this spec. Verify the `_noop` compatibility path still works for normal non-`fugu` Copilot requests, Fugu hidden calls cannot execute tools, and logs do not expose prompts or responses.

### PR 3: Missing Picker And V2 API Coverage

- Add TUI picker coverage showing `fugu/fugu` is available through the model-option path used by `packages/tui/src/component/dialog-model.tsx`.
- Add server-level v2 endpoint coverage for `packages/server/src/handlers/model.ts` and `packages/server/src/handlers/provider.ts` showing `/api/model` and `/api/provider` include virtual `fugu`; prefer a focused new test file such as `packages/opencode/test/server/httpapi-v2-fugu-model-provider.test.ts`.
- Keep existing core catalog and app context tests; do not duplicate catalog internals in endpoint tests.

Verification:

- `cd packages/tui && bun typecheck`
- `cd packages/tui && bun test test/cli/cmd/tui/model-options.test.ts test/util/model.test.ts --timeout 30000`
- `cd packages/server && bun typecheck`
- `cd packages/opencode && bun test test/server/httpapi-provider.test.ts test/server/httpapi-v2-fugu-model-provider.test.ts --timeout 30000`

Review:

Run a fresh read-only sub-agent/teammate against the PR diff and this spec. Verify the new tests cover the user-facing surfaces named by the base spec and do not rely only on core catalog internals.

## Future Work

- Add a reviewed tool-policy design for Fugu branches and synthesizer calls if hidden tool execution becomes a product requirement.
- Add judge execution only if `fugu.judge` becomes user-visible behavior.
- Add richer debug observability behind existing debug controls.

## Open Questions

- Should `disabled_providers: ["fugu"]` hide the virtual model? Default: yes, because it is an explicit user opt-out and does not conflict with the original requirement that `fugu` appears without `fugu` config.
- Is it acceptable for generated SDK types to show `fugu.branches[].model` and related target models as optional so request-time validation can own errors? Default: yes, document them as required for a usable config and keep strict validation in `packages/opencode/src/session/llm/fugu.ts`.
