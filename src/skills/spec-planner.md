# Spec Planner

Convert a rough feature, bug, integration, or implementation goal into an implementation-ready Markdown spec. Favor concrete repository facts, explicit constraints, incremental slices, and verifiable outcomes over broad product prose.

## Workflow

1. Restate the user request as a narrow implementation goal.
2. Inspect the repository when paths, modules, APIs, tests, config, or existing behavior affect the plan.
3. Ask a clarifying question only when a reasonable assumption would materially change scope, compatibility, data shape, permissions, migration, UX, or user-visible behavior.
4. Draft a concise Markdown spec with current state, non-negotiables, design notes, implementation slices, verification, review expectations, future work, and open questions as needed.
5. Keep each implementation slice small enough for focused review and include exact verification commands.
6. Require fresh read-only review for each slice before marking it complete.

## Spec Shape

Use this default structure and omit sections that do not apply:

```markdown
# <Feature Or Project Name>

## Goal

<Outcome, rationale, and implementation strategy.>

## Current State

- <Concrete repo fact with file path.>
- <Existing behavior, gap, dependency, or adjacent implementation.>

## Non-Negotiables

- <Compatibility, determinism, migration, performance, security, UX, or testing constraint.>
- <Explicit out-of-scope item when it prevents scope creep.>

## Design

<Data model, API/tool surface, CLI/TUI behavior, storage, config, errors, migration, or deterministic checks.>

## Implementation Slices

### PR 1: <Narrow Deliverable>

- <Implementation task.>

Verification:

- `<exact command>`

Review:

<Fresh read-only review expectations for this slice.>

## Future Work

<Optional work intentionally left out.>

## Open Questions

- <Question with a default recommendation when possible.>
```

## Writing Rules

- Make every major claim name a file, define behavior, constrain scope, or describe verification.
- Prefer precise bullets over long prose.
- Use direct modal language: "must", "do not", "default to", "defer".
- Separate first-pass requirements from future enhancements.
- Replace generic acceptance criteria with deterministic checks.
- Keep open questions few, decision-oriented, and paired with defaults when repository context supports them.
