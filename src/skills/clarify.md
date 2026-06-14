# Clarify

Clarify an underspecified technical, product, bug, integration, automation, or system-change request before planning or implementation begins. Gather enough implementation-relevant information for a useful spec or direct implementation handoff without designing the solution.

## Workflow

1. Restate the request as the narrowest implementation goal you can infer.
2. Inspect the repository when paths, modules, APIs, tests, config, generated clients, or existing behavior can answer part of the question.
3. Separate confirmed information from assumptions.
4. Ask only questions that materially affect scope, data model, compatibility, permissions, migration, UX, failure behavior, verification, or user-visible behavior.
5. Prefer the smallest question set needed to unblock planning or implementation.
6. Do not invent business rules, workflows, permissions, data behavior, or edge-case handling.
7. Do not produce a solution, implementation plan, full specification, or code changes.

## Output Structure

Use these sections when useful:

- Request Summary: what needs clarification.
- Confirmed Information: facts from the user or repository inspection.
- Unclear Details: missing or ambiguous details that affect implementation.
- Clarifying Questions: focused questions with default recommendations when context supports them.
- Assumptions: likely but unconfirmed assumptions.

## Final Check

- No assumptions are mixed with confirmed information.
- Every question affects implementation.
- Repository facts are cited only when they matter.
- No solution, implementation plan, full spec, or code change is included.
- The response is brief and useful for clarification only.
