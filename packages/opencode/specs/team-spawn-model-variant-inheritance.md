# Team Spawn Model Variant Inheritance

## Goal

The lead session must pass its active model and variant to every spawned teammate session. Spawned teammates should run with that lead model and variant when the teammate agent does not explicitly configure its own model. This makes `team_spawn` behave like the existing `task` subagent path for model inheritance, while also preserving the currently supported variant overlay path in `SessionPrompt` and `LLMRequestPrep`.

The first implementation should be internal and surgical: resolve the lead assistant message model at `team_spawn` time, pass the lead model and variant into the child teammate session, pass the effective model and variant into the teammate prompt, and avoid SQLite migrations or public API schema changes unless implementation proves they are required.

## Current State

- `packages/opencode/src/tool/team_spawn.ts:161-179` creates a child session with `parentID`, `title`, and `permission`, then records `team_member.model` from `ag.model` only. It does not resolve the lead session model and does not store variant.
- `packages/opencode/src/tool/team_spawn.ts:305-314` starts the teammate with `ops.prompt({ model: nextAgent.model, agent: nextAgent.name, ... })`. If the teammate agent has no configured model, `model` is omitted.
- `packages/opencode/src/tool/task.ts:165-180` already resolves subagent model inheritance from the current assistant message when the subagent agent has no configured model.
- `packages/opencode/src/tool/task.ts:190-208` passes the resolved model into `ops.prompt`, but does not currently pass variant.
- `packages/opencode/src/session/prompt.ts:689-708` resolves `currentModel(sessionID)` from `SessionTable.model`, then a prior user message model, then provider default. A new teammate child session has no stored model or prior messages, so omitted model falls through to provider default.
- `packages/opencode/src/session/prompt.ts:710-748` resolves prompt model as `input.model ?? ag.model ?? currentModel(input.sessionID)`. It resolves variant as `input.variant`, otherwise the agent configured variant only when the agent model matches and the provider model exposes that variant.
- `packages/opencode/src/session/prompt.ts:1414-1470` uses `lastUser.model` to fetch the provider model and copies `lastUser.model.variant` into assistant messages.
- `packages/opencode/src/session/llm/request.ts:79-90` applies runtime variant options from `input.user.model.variant`, then merges those options after base, model, and agent options.
- `packages/opencode/src/config/agent.ts:21-26` supports agent `model` and `variant`. The variant description says it applies only when using the agent's configured model.
- `packages/opencode/src/agent/agent.ts:30-50` exposes optional agent `model` and `variant`; `packages/opencode/src/agent/agent.ts:293-319` loads both from config.
- `packages/opencode/src/team/team.sql.ts:24-43` stores `team_member.model` as JSON typed as provider/model only. It does not currently type or store variant, but adding an optional JSON field does not require a SQLite column migration.
- `packages/opencode/src/server/routes/instance/httpapi/groups/team.ts:18-32` defines the public `TeamMember` schema without `model`, so internal `team_member.model` JSON changes do not need to affect generated API output.
- `packages/core/src/session/sql.ts:47-51` already supports `session.model.variant`.

## Non-Negotiables

- Preserve explicit teammate agent model behavior. If the selected teammate agent configures `model`, that model must win over the lead session model.
- Preserve agent variant behavior. If the selected teammate agent configures `model` and `variant`, `SessionPrompt.createUserMessage` should continue to apply that variant only when valid for that model.
- Every teammate child session must be created with the lead session's active model and variant. Do not create teammate sessions with an empty `model` field.
- Inherit lead variant only when inheriting lead model. Do not apply the lead variant to an explicit teammate agent model.
- Do not add a SQLite migration in the first pass. It is acceptable to extend the existing internal `team_member.model` JSON type with optional `variant` if delayed blocked teammates need to preserve the resolved variant.
- Do not change tool parameters, HTTP response schemas, or generated SDK shapes in the first pass.
- Keep the implementation inside existing boundaries: `team_spawn` may read the current assistant message and pass `PromptInput.model`/`PromptInput.variant`; `SessionPrompt` and `LLMRequestPrep` should not need broad rewrites.
- Verification must run from `packages/opencode`, never from repo root.

## Desired Behavior

### Lead Session Handoff

`team_spawn` must resolve the lead assistant message associated with the tool call before creating the teammate session. The teammate child session must receive the lead model and variant through `sessions.create`:

```ts
const leadModel = {
  id: leadAssistant.modelID,
  providerID: leadAssistant.providerID,
  ...(leadAssistant.variant ? { variant: leadAssistant.variant } : {}),
}

const childSession = yield* sessions.create({
  parentID: ctx.sessionID,
  title: `${params.name} (@${ag.name} teammate)`,
  model: leadModel,
  permission: permissionRules,
})
```

This session-level handoff is mandatory even when the teammate agent has an explicit model that later wins for the first prompt. The child session should never be created in a state where `currentModel(childSession.id)` would fall through to provider default before the first teammate message exists.

### Model Selection

For each spawned teammate run, resolve the prompt model before calling `ops.prompt`:

```ts
const teammateModel = nextAgent.model ?? {
  providerID: leadAssistant.providerID,
  modelID: leadAssistant.modelID,
}
```

Behavior rules:

- If `nextAgent.model` exists, pass that model to `ops.prompt`.
- If `nextAgent.model` is absent, inherit `providerID` and `modelID` from the lead assistant message associated with the `team_spawn` tool call.
- If the lead assistant message cannot be loaded or is not an assistant message, fail the tool with a clear internal error instead of silently falling back to provider default.
- Use the same lead-message lookup pattern already used by `TaskTool` in `packages/opencode/src/tool/task.ts`.

### Variant Selection

Resolve the prompt variant with these rules:

- If `nextAgent.model` exists, do not pass an inherited variant. Let `SessionPrompt.createUserMessage` apply the teammate agent's configured `variant` when it is valid for that configured model.
- If `nextAgent.model` is absent, pass the lead assistant message variant into `ops.prompt({ variant })` when present.
- If the inherited lead assistant variant is absent or equal to the default/no-variant representation, omit `variant` from `ops.prompt`.

Expected prompt input shape when inheriting from the lead:

```ts
yield* ops.prompt({
  sessionID: member.session_id,
  model: {
    providerID: leadAssistant.providerID,
    modelID: leadAssistant.modelID,
  },
  variant: leadAssistant.variant,
  agent: nextAgent.name,
  tools,
  parts,
})
```

Expected prompt input shape when the teammate agent has its own model:

```ts
yield* ops.prompt({
  sessionID: member.session_id,
  model: nextAgent.model,
  agent: nextAgent.name,
  tools,
  parts,
})
```

### Team Metadata

For the first pass, `team.addMember({ model })` should use the existing `team_member.model` JSON column and may extend its TypeScript shape to include optional `variant`:

```ts
model: teammateModel
  ? {
      providerID: teammateModel.providerID,
      modelID: teammateModel.modelID,
      ...(teammateVariant ? { variant: teammateVariant } : {}),
    }
  : undefined
```

This keeps delayed blocked teammates deterministic without a SQLite migration. Public `TeamMember` HTTP schemas should remain unchanged unless a later UI/API requirement needs to expose model or variant.

## Edge Cases

- Blocked teammates must preserve the resolved model and variant when they start after dependencies complete. Do not recompute from a dependency teammate's model or from provider default.
- Dependency-triggered starts should use the same resolved model/variant as immediate starts for the same member.
- A teammate with an explicit model and no explicit variant should not inherit the lead variant.
- A teammate with an explicit model and explicit invalid variant should retain the existing `SessionPrompt` behavior, which omits the invalid agent variant.
- Lead assistant variants represented as `"default"` should be treated the same as no variant unless the current prompt/LLM path requires an explicit value.

## Implementation Slices

### PR 1: Inherit Lead Model And Variant In `team_spawn`

- In `packages/opencode/src/tool/team_spawn.ts`, load the current assistant message using `ctx.messageID`, matching the `TaskTool` pattern in `packages/opencode/src/tool/task.ts`.
- Pass the lead assistant message model and variant into `sessions.create({ model })` for the teammate child session.
- Derive a per-member effective model at spawn time:
  - `nextAgent.model` when configured.
  - Otherwise `{ providerID: leadAssistant.providerID, modelID: leadAssistant.modelID }`.
- Derive a per-member inherited variant only when using the lead model.
- Extend the internal `team_member.model` JSON type and `Team.addMember` input/output type to allow optional `variant`.
- Pass the effective model and inherited variant into `ops.prompt` in `startMember`.
- Ensure blocked/dependency-delayed teammates read the stored provider/model/variant from `member.model` instead of recomputing from current session defaults.
- Keep the public `TeamMember` HTTP schema unchanged.
- Add or update `packages/opencode/test/tool/team_spawn.test.ts` coverage for a teammate agent without explicit model inheriting the lead assistant `providerID`, `modelID`, and `variant`.
- Add coverage for explicit teammate agent model overriding inherited lead model and not inheriting lead variant.
- Add coverage for dependency-blocked teammate start preserving the originally resolved model/variant.

Verification:

- `bun test test/tool/team_spawn.test.ts`
- `bun test test/session/prompt.test.ts`
- `bun typecheck`

Review:

- Add a read-only review pass against `packages/opencode/src/tool/team_spawn.ts` and `test/tool/team_spawn.test.ts` before merging.
- Confirm the diff does not modify HTTP schemas, SDK generated output, or SQLite table columns.

### PR 2: Align `task` Variant Propagation

- In `packages/opencode/src/tool/task.ts`, when a subagent inherits the parent assistant model, also pass the parent assistant variant into `ops.prompt`.
- Do not pass parent variant when `next.model` exists.
- Add focused tests in `packages/opencode/test/tool/task.test.ts` for inherited variant and explicit-model no-inheritance behavior.

Verification:

- `bun test test/tool/task.test.ts`
- `bun test test/session/prompt.test.ts`
- `bun typecheck`

Review:

- Keep this separate from PR 1 if the team-spawn fix needs to land first. This slice is related consistency work, not required for the first team-spawn behavior fix.

## SDK And Migration Impact

- No SDK regeneration is expected for PR 1 or PR 2 if changes remain internal to `team_spawn`, `task`, prompt inputs, tests, and the non-public `team_member.model` JSON field.
- Run `./packages/sdk/js/script/build.ts` only if an implementation changes public HTTP/OpenAPI schemas, tool parameter schemas, or generated SDK types.
- A SQLite migration is intentionally out of scope for the first pass.

## Future Work

- Expose `team_member.model.variant` publicly if team reports, TUI team panels, or evaluation output need to display the exact effective variant.
- Consider persisting the effective model on the child session at session creation time if future code needs model visibility before the first teammate prompt is written.
- Consider centralizing subagent/team effective model resolution if `task` and `team_spawn` accumulate more shared behavior.

## Open Questions

- Should `team_member.model` store the effective inherited model and variant in PR 1? Default: yes, store provider/model/optional variant in the existing JSON column, because delayed blocked teammates need deterministic startup and no SQLite migration is required.
- Should `task` variant propagation land with `team_spawn`? Default: no, keep it as PR 2 unless the implementation naturally shares a small helper.
