# Experimental Flag: Drop Reasoning From Next-Turn Context

## Goal

Give OC2 an experimental opt-in that removes the model's thinking/reasoning output from the
conversation context OC2 sends on follow-up model requests. When the flag is on, an assistant
reasoning part is omitted from the outbound message history; it is not demoted into a text part.
The stored transcript, the UI, and the displayed reasoning never change. The flag must work in
both runtime paths: the V1 live opencode path and the V2 core session runner.

Strategy: gate the two message-lowering funnels that build outbound history. Every V1 outbound
conversation goes through `MessageV2.toModelMessagesEffect`; every V2 outbound conversation goes
through `toLLMMessages`. Gating these two funnels, plus the compaction paths, covers all model
context. Provider protocol lowerers stay flag-agnostic and keep their ability to serialize
reasoning when a reasoning part is present.

Verified premise (repo research): reasoning currently IS part of next-turn context in both paths.
Dropping it does not permanently break prompt caching. Cache keys on an exact prefix; a consistent
drop causes one cache miss and rewrite at the transition, then re-stabilizes on the smaller prefix.
OC2's own stable-prefix fingerprint excludes conversation messages, so no OC2 cache code changes.

## Current State

- V1 live path keeps reasoning in outbound history: `packages/opencode/src/session/message-v2.ts:393-407`
  (same-model keep; different-model demote to text at 394-400). Main call site:
  `packages/opencode/src/session/prompt.ts:1959` `MessageV2.toModelMessagesEffect(msgs, model)`.
- V2 runner keeps reasoning in outbound history: `packages/core/src/session/runner/to-llm-message.ts:76-81`
  (same-model keep with `providerMetadata`; different-model demote/drop). Sole production caller:
  `packages/core/src/session/runner/llm.ts:313` `toLLMMessages(context, model)`.
- Reasoning is durably stored as a first-class part in both paths (`packages/core/src/session/message.ts:132-139`,
  `packages/core/src/v1/session.ts:110-120`) and survives DB reload each turn.
- Two independent `experimental` config objects exist:
  - V1 struct: `packages/core/src/v1/config/config.ts:200-223` (read by the opencode live Config layer,
    spread at `packages/opencode/src/config/config.ts:176-179`).
  - V2 class: `packages/core/src/config/experimental.ts:16-18`, currently holds only `policies`;
    wired at `packages/core/src/config.ts:97`.
- V1 to V2 migration forwards only `policies` from `experimental`: `packages/core/src/v1/config/migrate.ts:69`.
  A key added only to the V2 schema is silently lost for V1-flavored config files unless forwarded here.
- Compaction can re-enter reasoning as text:
  - V2 serializer: `packages/core/src/session/compaction.ts:98-113` writes `[Assistant reasoning]: ...`.
  - V1 compaction builds summary/recent through `toModelMessagesEffect` at `packages/opencode/src/session/compaction.ts:404` and `:415`.
- No flag or code path named `dropReasoning`/`stripReasoning` exists. All existing reasoning toggles
  (`--thinking` at `packages/opencode/src/cli/cmd/run.ts:208-211`, TUI `display_thinking`) are display-only.
- Provider transforms run after lowering and must not silently re-add reasoning:
  - DeepSeek injects an empty reasoning part into every assistant message lacking one:
    `packages/opencode/src/provider/transform.ts:270-286`.
  - Interleaved providers relocate reasoning text into `providerOptions.openaiCompatible[field]`,
    setting the field even when empty: `transform.ts:296-315`.
  - Anthropic/Bedrock strip only empty, unsigned reasoning: `transform.ts:144-159` and `172-188`.
- Tests pin the current retention behavior (they become flag-off models):
  `packages/core/test/session-runner-message.test.ts:206-208, 291-297, 357-358`,
  `packages/core/test/session-runner.test.ts:2391-2444`,
  `packages/opencode/test/session/message-v2.test.ts:604-685, 991-1042, 1044-1115, 1262-1363`.

## Non-Negotiables

- Flag default is OFF. An absent key is equivalent to `false`. No behavior changes when off.
- "Drop" means omit the reasoning part entirely. Do not demote reasoning text into a text part.
  This is distinct from the existing model-switch demotion behavior, which stays unchanged when the
  flag is off.
- Persisted transcript parts, TUI/app display, and reasoning replay rendering are untouched. Only
  outbound model messages change.
- Provider protocol lowerers in `packages/llm/src/protocols/*` are flag-agnostic. No change to
  Anthropic `thinking`+`signature`, OpenAI Responses `encrypted_content`, Gemini `thought`,
  or Copilot `reasoning_opaque` wire lowering.
- No prompt-cache code change. Do not modify `packages/llm/src/cache/*`. The expected cache effect
  (one-time prefix rewrite) is documented behavior of this feature.
- No session-record or SQL schema change. Do not add a session settings column.
- Provider continuation state within an active tool-use loop must not be broken. Reasoning of the
  assistant message that is still being continued in a tool loop is kept (see Design, "Active tool loop").
- First pass does not add an env-var override. Config file flag only.

## Design

### Config Surface

One snake_case boolean under `experimental`, name `drop_reasoning`.

```ts
// packages/core/src/v1/config/config.ts  (V1 struct, ~line 200)
experimental: Schema.optional(Schema.Struct({
  // ...existing keys...
  drop_reasoning: Schema.optional(Schema.Boolean).annotate({
    description: "Drop thinking/reasoning parts from conversation context sent on model requests",
  }),
}))

// packages/core/src/config/experimental.ts  (V2 class, ~line 16)
drop_reasoning: Schema.optional(Schema.Boolean)

// packages/core/src/v1/config/migrate.ts:69  (forward the key alongside policies)
experimental: {
  policies: info.experimental?.policies,
  drop_reasoning: info.experimental?.drop_reasoning,
}
```

Read sites:
- V1: inside the `SessionPrompt` layer closure (`config` at `packages/opencode/src/session/prompt.ts:200`,
  precedent read of `config.get().experimental?.agent_teams` at `prompt.ts:1672`).
- V2: inside the runner layer (`config` at `packages/core/src/session/runner/llm.ts:139`,
  already consumed at `llm.ts:145` as `config.entries()`).

Document the key in the `experimental` block of `oc2.example.json:114-119`. There is no markdown
reference that enumerates experimental keys.

### Semantics

When `experimental.drop_reasoning === true`:

1. Assistant reasoning parts are omitted when outbound messages are built for a model request.
   They are never demoted to text.
2. The flag gates the two lowering funnels and the compaction text paths. Provider transforms need
   no gate (see "Provider transform interplay").
3. Reasoning of the active tool-loop assistant message is preserved (see below).
4. A finished assistant message whose only content was reasoning becomes content-free in outbound
   messages. Existing empty-message handling applies:
   - V1: the parts-length guard at `message-v2.ts:409` drops an assistant message with no parts
     left after the drop; the step-start filter at `message-v2.ts:439` runs after. Anthropic/Bedrock
     empty-message removal at `transform.ts:157`/`185` is the remaining safety net. Anthropic merges
     consecutive same-role user turns. Accepted. The abort-path exclusion of reasoning-only messages
     is existing flag-off behavior (`message-v2.ts:279-287`).
   - V2: the drop must skip an assistant message whose content and tool parts are both empty after
     the drop (mirror of the V1 guard), instead of emitting an empty assistant message. The early
     return at `to-llm-message.ts:91` already covers unfinished or errored messages; the new skip
     covers finished reasoning-only messages.
   - Unit tests must pin this behavior in both packages.
5. In a same-model continuation with the flag off, nothing in this spec changes the existing
   reasoning retention and signed-separator logic (`message-v2.ts:293-311`, `1262-1363` tests).

### Active Tool Loop

Provider continuation rules require prior thinking/signature blocks inside an active tool-use turn
(Anthropic: omission silently disables thinking continuity rather than erroring; modified blocks
return 400). Rule: the reasoning of the assistant message that is still being continued by a tool
loop is kept; reasoning of all completed turns is dropped.

- V2: tool-loop continuations are separate runner steps, each rebuilding context through
  `toLLMMessages` (`runner/llm.ts:611-617`). The runner knows when a step is a tool-loop
  continuation (`needsContinuation`). Add a `keepActiveTurnReasoning` option that `runner/llm.ts`
  sets to `true` only for the continuation step of an active tool loop. The rule is: keep the
  reasoning of every assistant message that belongs to the current open turn being continued
  (each round whose tool results are replayed needs its signed thinking echoed for Anthropic),
  not only the last assistant message. Exact detection condition: confirm in implementation;
  candidate = the request follows an assistant message whose tool parts have results pending this
  step.
- V1: tool loops run inside one AI-SDK step; internal loop rounds do not pass through
  `toModelMessagesEffect`, so mid-turn reasoning is preserved naturally by the AI-SDK. The
  session-level lowering that the flag gates only covers completed turns. No V1 exception needed.

### Compaction

Reasoning must not re-enter context through compaction when the flag is on.

- V2 core: gate the string serializer `packages/core/src/session/compaction.ts:98-113` so that with
  the flag on, reasoning text is omitted from both the summary `head` and the persisted `recent`
  tail (the compaction message is replayed as user text by `to-llm-message.ts:128-146`, bypassing
  the reasoning-part gate).
- V1: the real reasoning re-entrance vectors are (a) the summary-model input at
  `packages/opencode/src/session/compaction.ts:404` (prevents the summary text from embedding
  reasoning) and (b) preserved-tail durable messages replayed through the run-loop funnel at
  `prompt.ts:1959` (already gated by PR 2). Thread the flag through the `toModelMessagesEffect`
  call sites at `:404` and the token estimate at `:226` so estimates match the real lowering. The
  recent-tail string lowered at `:415` feeds only the `Compaction.Ended` event payload
  (`compaction.ts:582-591`); gate it for event-payload hygiene, not because it re-enters context.
- Compaction message text stored under the flag deliberately excludes reasoning. Transcript parts
  remain untouched.

### Provider Transform Interplay

- DeepSeek (`transform.ts:270-286`) re-adds an empty reasoning part when the flag drops it.
  Accept and document for the first pass; the part is empty so it adds no reasoning content.
- Interleaved relocation (`transform.ts:296-315`) sets an empty `reasoning_content` field when no
  reasoning part exists. Accept for the first pass.
- Anthropic/Bedrock empty-strip (`transform.ts:144-159`, `172-188`) becomes a no-op for reasoning
  and remains the safety net for empty assistant messages. No gate needed.
- Copilot `reasoning_opaque` and Responses `encrypted_content` converters only walk reasoning parts
  that already exist, so a dropped part is not re-added. The loss of encrypted continuation state
  across completed turns is an accepted, documented consequence (see "Provider Continuation Tradeoffs").

### Provider Continuation Tradeoffs

- Anthropic across finished turns: omitting prior thinking is allowed by the API. Do not keep later
  signed blocks after dropping an earlier block in the same message; the drop is all-or-nothing per
  message. Never modify a block while keeping it (400).
- OpenAI Responses: dropping reasoning items is not an API error. It removes the encrypted
  continuation state; pre-GPT-5.6 `current_turn` does not render prior-turn reasoning anyway.
  Function-call continuity can degrade. Accepted for the experiment.
- Prompt caching: one-time miss and rewrite of the provider-side prefix at the transition request;
  steady-state caching resumes on the smaller prefix. No code change.

## Implementation Slices

### PR 1: Config Flag Plumbing (no behavior change)

- Add `drop_reasoning: Schema.optional(Schema.Boolean)` to the V1 struct in
  `packages/core/src/v1/config/config.ts:200-223`.
- Add the same field to the V2 class `packages/core/src/config/experimental.ts:16-18`.
- Forward the key in `packages/core/src/v1/config/migrate.ts:69`.
- Document the key in `oc2.example.json` under `experimental` (lines ~114-119).

Verification:

- `bun run --cwd packages/core test test/config/config.test.ts`
- `bun run --cwd packages/core test test/database-migration.test.ts`
- `bun run --cwd packages/core typecheck`

Review:

- Confirm decode round-trip for `true`, `false`, and absent key in both V1 and V2 config tests.
- Confirm migration preserves `drop_reasoning` for a V1-flavored file. Add schema tests for the key
  if the existing test files do not cover it; this PR must include its own tests.

### PR 2: V1 Drop In `toModelMessagesEffect`

- Extend the options bag `packages/opencode/src/session/message-v2.ts:162-166` with
  `dropReasoning?: boolean` (backward compatible; do not add a positional parameter).
- Gate the reasoning emission `message-v2.ts:393-407`: when the option is set, `continue` on
  `part.type === "reasoning"` before both the demote and the keep branches.
- Read the flag in the prompt service (`prompt.ts:200` closure) and pass it at the main run-loop
  call `prompt.ts:1959` and the title call `prompt.ts:388`.
- In `packages/opencode/src/session/compaction.ts`, read the flag via `config.get()` in the layer
  closures (config is in scope at `compaction.ts:204`; `config.get()` precedent at `:218`, `:297`,
  `:385`) and thread `dropReasoning` through the `toModelMessagesEffect` options bag at the summary
  input `:404`, the token estimate `:226` (via `EstimateOptions`, defined at `:59-68`), and the
  recent-tail lowering `:415` (event-payload hygiene only).
- Add flag-on unit tests in `packages/opencode/test/session/message-v2.test.ts` describe
  `"session.message-v2.toModelMessage"`: same-model drop; drop-overrides-demotion when models
  differ; aborted reasoning-only message excluded; empty text separators untouched when reasoning
  is dropped; explicit flag-off retention guard.

Verification:

- `bun run --cwd packages/opencode test test/session/message-v2.test.ts`
- `bun run --cwd packages/opencode test test/session/compaction.test.ts`
- `bun run --cwd packages/opencode typecheck`

Review:

- A fresh read-only reviewer compares the diff against PR 2 scope. Confirm no provider transform,
  protocol lowerer, or cache file changed. Confirm flag-off tests in `message-v2.test.ts` are
  untouched and still pass.

### PR 3: V2 Drop In `toLLMMessages` And Runner Plumbing

- Add an options parameter `toLLMMessages(messages, model, options?: { dropReasoning?: boolean; keepActiveTurnReasoning?: boolean })`
  at `packages/core/src/session/runner/to-llm-message.ts:151-152` and thread it into `assistant(...)`.
- Gate the reasoning branch `to-llm-message.ts:76-81`: when `dropReasoning` is set, return `[]` for
  reasoning items in both the same-model and different-model branches.
- Skip a message whose content and tool parts are both empty after the drop (finished
  reasoning-only assistant), instead of emitting an empty assistant message.
- Read the flag in the runner layer (`config` at `packages/core/src/session/runner/llm.ts:139-145`)
  and pass `dropReasoning` at the sole production call site `llm.ts:313`. Set
  `keepActiveTurnReasoning` only when the step is a tool-loop continuation of the current open
  turn; when set, keep reasoning on every assistant message that belongs to that open turn, not
  only the last one. Resolve and document the exact detection condition in this PR.
- Add unit tests in `packages/core/test/session-runner-message.test.ts` describe `"toLLMMessages"`:
  drop on (same model), drop overrides demotion across a model switch, empty assistant message
  skipped, flag-off retention guard.
- Add an E2E test in `packages/core/test/session-runner.test.ts` describe `"SessionRunnerLLM"`
  mirroring the second-turn test at 2391: drive one turn with reasoning events, assert the second
  request contains no reasoning while `session.context` still stores it.

Verification:

- `bun run --cwd packages/core test test/session-runner-message.test.ts`
- `bun run --cwd packages/core test test/session-runner.test.ts`
- `bun run --cwd packages/core typecheck`

Review:

- Fresh read-only reviewer checks the diff against PR 3 scope. Verify the flag reaches
  `runner/llm.ts` from the core config layer and that `Config.Service` test doubles
  (`session-runner.test.ts:255-271`) are updated where needed.

### PR 4: Compaction Coherence

- V2: gate the serializer `packages/core/src/session/compaction.ts:98-113` so `[Assistant reasoning]:`
  lines are omitted from the summary head and recent tail when the flag is on. Add tests in
  `packages/core/test/session-compaction.test.ts`.
- V1: confirm the token estimate at `packages/opencode/src/session/compaction.ts:226` receives the
  same `dropReasoning` value as the real lowering so budgets stay coherent. Add a compaction
  flag-on test in `packages/opencode/test/session/compaction.test.ts` (config helper shape:
  `it.live(..., { config: { experimental: { drop_reasoning: true } } })`).

Verification:

- `bun run --cwd packages/core test test/session-compaction.test.ts`
- `bun run --cwd packages/opencode test test/session/compaction.test.ts`
- `bun run --cwd packages/opencode typecheck`

Review:

- Fresh read-only reviewer confirms no reasoning text path remains un-gated: V2 serializer summary
  head and persisted recent tail (`core/src/session/compaction.ts:98-113`), V1 summary-model input
  (`opencode compaction.ts:404`), and V1 estimate coherence (`:226`). Confirm transcript parts are
  still stored unchanged.

### PR 5: Optional Strict Wire Gate And Recorded E2E

- Optional: gate DeepSeek empty-reasoning injection (`transform.ts:270-286`) and interleaved empty
  field setting (`transform.ts:296-315`) when a strict mode demands no reasoning field on the wire.
  Do not do this in the first pass unless provider testing shows rejection.
- Optional: record a flag-on two-turn E2E cassette for the V1 path to prove the outbound request has
  no reasoning while the transcript retains it. Use the documented recording mechanism
  (`RECORD=true`, scenario envs in `packages/opencode/test/session/llm-native-recorded.test.ts:185-198`).
  Delete only the single new cassette for updates.

Verification:

- `bun run --cwd packages/opencode test test/session/llm-native-recorded.test.ts`
- `bun run --cwd packages/opencode typecheck`

Review:

- Fresh read-only reviewer inspects any new cassette for reasoning content in the outbound request
  and its absence in the follow-up request body.

## Future Work

- Env override `OC2_EXPERIMENTAL_DROP_REASONING` in `packages/opencode/src/effect/runtime-flags.ts`
  for parity with other flags, and a matching core `Flag` read if the V2 path needs it.
- Move the flag from `experimental` to a documented agent or session setting once per-agent scope is
  designed. Today neither `ConfigAgentV1`/`ConfigAgentV2` nor `SessionSchema.Info` has a settings
  bucket that the lowering call sites can reach.
- Measure token savings and cache behavior on reasoning-heavy sessions before promoting the flag.
- Strict mode that also suppresses empty DeepSeek/interleaved reasoning fields.
- Known transition limitation: if a V2 compaction runs while the flag is OFF, reasoning is stored
  as text inside the compaction message (`[Assistant reasoning]: ...`) and is not re-serialized at
  lowering. Flipping the flag ON afterwards does not strip that embedded text. Acceptable for an
  experimental flag; document it in the release note when the flag ships.

## Open Questions

- Active-turn tool-loop detection in V2: is `keepActiveTurnReasoning` best keyed on "the step is a
  tool-loop continuation" in the runner, or on a message-shape check (assistant messages between
  the last user message and the newest tool results)? Scope must cover every assistant message of
  the current open turn, not only the last one, so multi-round tool loops keep each round's signed
  thinking. Default: runner-owned flag at `needsContinuation` (`runner/llm.ts:611-617`); confirm
  the open-turn boundary during PR 3.
- DeepSeek and interleaved providers: leave the re-added empty reasoning field on the wire when the
  flag is on, or suppress it? Default: leave it; suppressing risks provider rejection and adds no
  reasoning content.
- Key name `drop_reasoning` vs alternatives (`exclude_reasoning`, `strip_reasoning`). Default:
  `drop_reasoning`, matching the snake_case `experimental` convention.
- Should the V2 migration forward all future `experimental` keys instead of only `policies` +
  `drop_reasoning`? Default for this spec: forward the full experimental struct to prevent the
  silent-loss class of bug found at `migrate.ts:69`.
