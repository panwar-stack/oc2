# Spec Implement

Implement one Markdown specification slice at a time with minimal, verified changes.

## Inputs

- Spec path or pasted spec content.
- Optional PR or slice number.
- Optional user constraints that narrow the scope.

## Workflow

1. Read the full spec before editing.
2. Identify the exact requested slice. If no slice is provided, start with the first incomplete slice and do not proceed to later slices until the current one is implemented, verified, and reviewed.
3. Inspect the current repository state and existing tests before choosing an approach.
4. Implement only the selected slice. Do not include adjacent improvements, future work, or unrelated cleanup unless strictly required for the slice to function.
5. Update documentation that the slice explicitly requires or that would otherwise become inaccurate.
6. Run the slice's verification commands when feasible. If a command cannot run, report the reason and the remaining risk.
7. Request or perform a fresh read-only review against the spec and diff before completion.

## Guardrails

- Keep changes surgical and local to the selected slice.
- Preserve user or teammate changes that are outside the slice.
- Do not introduce compatibility shims, plugin systems, generated clients, or new command machinery unless the selected slice explicitly requires them.
- Do not mark the slice complete based only on implementation intent; verification and review status must be clear.
