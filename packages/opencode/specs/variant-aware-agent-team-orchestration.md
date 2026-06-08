# Variant-Aware Agent Team Orchestration

## Goal

Let a team lead keep the selected provider/model for teammates while choosing an available model variant per teammate based on task complexity. If the lead session is running e.g. `gpt-5.5`, spawned teammates should still run `gpt-5.5`; the lead may choose an exposed lower reasoning-effort variant for simple, well-scoped work and a stronger/default variant for complex implementation, debugging, decomposition, or review.

The first pass should stay inside the existing tool-driven team model: expose the current lead model's available teammate variants in the lead prompt, add an optional `variant` input to `team_spawn`, validate it against the teammate's effective model, persist lead-selected variants in the existing member model JSON, and update lead-facing instructions so variant choice is part of DAG/task decomposition. Do not add a central scheduler, automatic cost optimizer, or model-ranking system.

## Current State

- `packages/opencode/src/team/README.md` says agent teams are normal lead and teammate sessions using tools, not a separate runtime or central scheduler.
- `packages/opencode/src/tool/team_spawn.ts` accepts `name`, `agent_type`, `role_prompt`, `depends_on`/`wait_for`, and `plan_mode`; it has no `variant`, `complexity`, or `effort` parameter.
- `packages/opencode/src/tool/team_spawn.ts` already loads the lead assistant message, creates the child session with the lead model/variant, stores `team_member.model`, and passes stored `model`/`variant` into `ops.prompt`.
- `packages/opencode/test/tool/team_spawn.test.ts` covers lead model/variant inheritance, explicit teammate agent model override, dependency-blocked teammate model/variant preservation, prompt context, nested-team protections, and dependency starts.
- `packages/opencode/src/session/prompt.ts` resolves prompt model as explicit input, then agent model, then current session model; explicit prompt `variant` wins, otherwise agent-configured `variant` applies only when valid for the agent model.
- `packages/opencode/src/session/llm/request.ts` applies runtime variant options from the selected user-message model variant.
- `packages/opencode/src/provider/provider.ts` exposes `Provider.Service.getModel`, and `packages/opencode/src/provider/transform.ts` derives provider/model-specific `variants` such as `low`, `medium`, `high`, `minimal`, `xhigh`, or provider-specific keys.
- `packages/opencode/src/config/agent.ts` and `packages/opencode/src/agent/agent.ts` support explicit agent `model` and `variant` config.
- `packages/opencode/src/team/eval.ts` includes `member.model` in member node metadata, so lead-selected variants can appear in team evaluation output without a new HTTP team member field.
- `packages/opencode/src/server/routes/instance/httpapi/groups/team.ts` omits `model` from the public `TeamMemberSchema`; keeping the change internal avoids generated SDK churn.
- Lead orchestration guidance lives in `packages/opencode/src/session/prompt.ts` (`teamLeadSystemPrompt`) and tool descriptions such as `packages/opencode/src/tool/team_spawn.txt` and `packages/opencode/src/tool/team_create.txt`.
- `teamLeadSystemPrompt` currently gives static team-orchestration guidance; it does not tell the lead which variant keys are available for the active model.

## Non-Negotiables

- Do not add a `model` parameter to `team_spawn` in the first pass. The lead controls the DAG and variant; teammates keep the lead's selected provider/model unless an existing explicit teammate agent model config applies.
- Do not rely on model-memory or guessing for variant names. The lead prompt must surface the active model's available variant keys before the lead is expected to choose `team_spawn.variant`.
- Preserve current behavior when `variant` is omitted.
- Validate an explicit `team_spawn.variant` against the effective model's `Provider.Model.variants`. Invalid variants must return a clear `Team Spawn Failed` result instead of silently falling back or defecting through `Effect.orDie`.
- Store the resolved provider/model and any lead-selected or lead-inherited variant in `team_member.model` so blocked teammates start with the same variant chosen at spawn time.
- Leave agent-configured variants implicit in `SessionPrompt.createUserMessage` when `team_spawn.variant` is omitted and the agent has its own model. Do not start persisting agent-configured variants in `team_member.model` in the first pass.
- If `team_spawn.variant` changes the variant for a teammate inheriting the lead model, create the child session with that selected variant so session-level `currentModel` is consistent with the first teammate prompt.
- Do not add a SQLite migration; use the existing `team_member.model` JSON shape with optional `variant`.
- Do not change public HTTP team schemas or generated SDK types in the first pass.
- Leave automatic model ranking, cost optimization, and post-hoc quality scoring out of scope.
- Run tests and typecheck from `packages/opencode`, never from repo root.

## Tool Surface And Selection Rules

### Variant Discovery

Update `packages/opencode/src/session/prompt.ts` so `teamLeadSystemPrompt` includes the active lead model and available variant keys when agent teams are enabled:

```text
Current teammate model: <providerID>/<modelID>
Available teammate variants for this model: low, medium, high
Use team_spawn.variant only with one of these exact values. Omit variant for default behavior.
```

Behavior rules:

- Resolve the active model through the same current-model path already used by prompt creation, then fetch the provider model with `Provider.Service.getModel`.
- If `model.variants` is empty, say the current model exposes no teammate variants and instruct the lead to omit `variant`.
- If model lookup fails, omit the variant list and instruct the lead to omit `variant` rather than guessing.
- This prompt context is the source of truth for the lead's variant choices. `team_spawn` validation remains the enforcement layer.
- Do not list variants for every provider/model in the static prompt; only show the current active model to reduce cognitive load.

### `team_spawn` Parameter

Add one optional parameter to `packages/opencode/src/tool/team_spawn.ts`:

```ts
const Parameters = Schema.Struct({
  name: Schema.String,
  agent_type: Schema.String,
  role_prompt: Schema.String,
  depends_on: Schema.optional(Schema.Array(Schema.String)),
  wait_for: Schema.optional(Schema.Array(Schema.String)),
  plan_mode: Schema.optional(Schema.Boolean),
  variant: Schema.optional(Schema.String).annotate({
    description: "Optional variant of the teammate's effective model, selected by the lead for this task's complexity",
  }),
})
```

Effective model rules:

- Resolve the lead assistant message exactly once at spawn time, as `team_spawn` already does.
- `effectiveModel = ag.model ?? { providerID: lead.providerID, modelID: lead.modelID }`.
- Preserve explicit teammate agent model override behavior for compatibility.

Effective variant rules:

- If `params.variant` is present, validate it against `Provider.Service.getModel(effectiveModel.providerID, effectiveModel.modelID).variants` and use it as `effectiveVariant`.
- If `params.variant` is absent and the teammate inherits the lead model, use the current inherited lead variant behavior.
- If `params.variant` is absent and the teammate agent has an explicit model, omit prompt `variant` and let `SessionPrompt.createUserMessage` apply the agent-configured variant when valid.
- Treat the string `default` in the lead assistant message as no inherited variant. For `params.variant`, require a real variant key; if the lead wants default behavior, it must omit the parameter.
- Pass `{ model: { providerID, modelID }, variant: effectiveVariant }` to `ops.prompt` when `team_spawn` owns the variant choice.
- Store the same optional `effectiveVariant` in `team_member.model` only for lead-selected or lead-inherited variants.

Failure behavior:

- Unknown agent type continues to fail before variant validation.
- Unknown effective model should return `Team Spawn Failed` with a clear model/provider message.
- Invalid `params.variant` fails before creating or starting the child session; do not create a blocked teammate with an invalid variant.
- Models with no exposed variants must reject explicit `team_spawn.variant` and tell the lead to omit `variant` for default behavior.

## Lead Orchestration Guidance

Update `teamLeadSystemPrompt` and `team_spawn.txt` so leads select variants while decomposing the DAG:

- Read the current model's available variant keys from the team lead prompt before using `team_spawn.variant`.
- Use lower reasoning-effort variants only when the selected model exposes them and the task is simple, well-scoped, and has precise instructions.
- Use default or medium variants for bounded implementation slices, moderate debugging, and verification that requires judgment.
- Use the lead/default/highest appropriate variant for ambiguous root-cause analysis, architecture decisions, security-sensitive changes, broad refactors, and adversarial review.
- When the available variant names for the selected model are uncertain, omit `variant` rather than guessing.
- Keep model choice out of teammate prompts; the lead owns model variant selection through `team_spawn`.

## Implementation Slices

### PR 1: Expose Current Model Variants To Team Leads

- Update `packages/opencode/src/session/prompt.ts` `teamLeadSystemPrompt` to include the active lead model and its available variant keys when `experimental.agent_teams` is enabled.
- Use `Provider.Service.getModel` to read `model.variants` for the active model.
- If the active model has no variants or lookup fails, tell the lead to omit `team_spawn.variant`.
- Keep the prompt short and current-model scoped; do not add a full provider/model catalog.
- Add or update `packages/opencode/test/session/prompt.test.ts` coverage for prompt output with variants, no variants, and model lookup failure.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/prompt.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

- Before checking off the slice, run a fresh read-only sub-agent/teammate against the diff and this PR checklist.
- Confirm the prompt gives exact allowed values and tells leads to omit `variant` when no values are listed.

### PR 2: Add Explicit Teammate Variant Selection

- Add `variant?: string` to `packages/opencode/src/tool/team_spawn.ts` parameter schema and `packages/opencode/src/tool/team_spawn.txt`.
- Use `Provider.Service` in `team_spawn` to validate explicit variants against the effective model before creating a teammate.
- Catch provider/model lookup failures inside `team_spawn.execute` and return `Team Spawn Failed` instead of allowing provider errors to defect through `Effect.orDie`.
- Keep `effectiveModel` as the explicit agent model when configured, otherwise the lead provider/model.
- Resolve `effectiveVariant` from `params.variant`, inherited lead variant, or existing agent-configured variant behavior according to the selection rules above.
- Create child sessions with the selected variant when the teammate inherits the lead model and `params.variant` overrides the lead variant.
- Persist only lead-selected or lead-inherited variants in the existing `team_member.model` JSON object.
- Ensure dependency-blocked teammates use the stored provider/model/variant and do not recompute from the current lead/session state.
- Update `packages/opencode/test/tool/team_spawn.test.ts` layers or fixtures to provide a provider model with real `variants`.
- Add test coverage for explicit requested variant on an inherited lead model.
- Add test coverage for invalid requested variant failing before teammate creation.
- Add test coverage that omitted `variant` preserves current inherited lead variant behavior and explicit agent model behavior.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/tool/team_spawn.test.ts`
- `cd packages/opencode && bun typecheck`

Review:

- Before checking off the slice, run a fresh read-only sub-agent/teammate against the diff and this PR checklist.
- Confirm the diff does not modify `packages/opencode/src/server/routes/instance/httpapi/groups/team.ts`, generated SDK files, or SQLite table columns.

### PR 3: Teach Leads To Use Variants In The Team DAG

- Update `packages/opencode/src/session/prompt.ts` `teamLeadSystemPrompt` with concise variant-selection guidance tied to task complexity and DAG decomposition.
- Update `packages/opencode/src/tool/team_spawn.txt` so the tool description tells leads to set `variant` for task complexity when the model's variant names are known.
- Update `packages/opencode/src/team/README.md` with developer-facing notes for variant-aware team spawning, dependency-blocked determinism, and the first-pass non-goals.
- Update `packages/web/src/content/docs/agent-teams.mdx` if public docs describe teammate spawning or model inheritance.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/prompt.test.ts test/tool/registry.test.ts`
- `cd packages/opencode && bun typecheck`
- `cd packages/web && bun run build`

Review:

- Before checking off the slice, run a fresh read-only sub-agent/teammate against the prompt/docs diff and confirm the guidance is specific enough for lower-effort teammates to succeed with precise instructions.
- Confirm docs do not promise automatic model selection, cost optimization, or variants that are not exposed by `Provider.Model.variants`.

## SDK And Migration Impact

- No SQLite migration is expected because `team_member.model` is existing JSON and already carries optional `variant` in current behavior.
- No JS SDK regeneration is expected if public HTTP/OpenAPI schemas stay unchanged and tool schemas are not exported into generated client types.
- If implementation changes public HTTP schemas, exported tool schemas, or generated SDK-visible types, run `./packages/sdk/js/script/build.ts` from the repo root and `cd packages/sdk/js && bun typecheck`.

## Future Work

- Add a normalized `complexity` or `effort` enum if raw variant names lead to frequent invalid selections.
- Surface chosen teammate variants in TUI or public team APIs if users need visibility beyond team evaluation metadata.
- Add team-report findings for variant selection quality once enough usage data exists.
- Consider centralizing variant resolution if `task` and `team_spawn` need shared behavior.

## Open Questions

- Should explicit teammate agent model config continue to override the lead model? Default: yes for compatibility; `team_spawn.variant` applies to the effective model and does not introduce a teammate `model` parameter.
- Should invalid `team_spawn.variant` fail or silently omit? Default: fail, because silent fallback hides cost/quality mistakes in the lead's DAG.
- Should the first pass accept raw `variant` or a normalized `complexity` enum? Default: raw `variant` for the smallest change, with normalized mapping left for future work.
