# Local Fusion

Local Fusion is explicit local compound-model orchestration exposed through the `local_fusion` tool and `/local:fusion` command. It uses child Sessions for parallel research, structured judging, and final synthesis. It is separate from the transparent Fugu virtual model.

## Configuration And Invocation

Named configurations live under `local_fusion`; tool calls may also provide inline branches, judge, and synthesizer definitions. Every target uses normal `provider/model` parsing and may select a variant.

`limits.maxBranches` defaults to three and is validated before child execution. `limits.timeout` is currently a fallback timeout for each branch that does not define its own timeout; it is not a total judge-and-synthesizer deadline.

Tool policies are `none`, `readonly`, `parent_without_teams`, and `all`. Defaults are `readonly` for branches and `none` for judge and synthesizer.

## Execution

1. Validate the compound configuration and tool policies.
2. Create one child Session per branch and run branches concurrently.
3. Collect successful text and structured failures. Continue when at least one branch succeeds.
4. Create a judge child Session and require structured consensus, contradictions, unique insights, blind spots, failures, and confidence.
5. Create a synthesizer child Session with the original request, branch results, failures, and judge result.
6. Return only the synthesizer output and compact run metadata to the parent tool call.

Parent cancellation interrupts owned child work. Branch timeout cancels that child and records a failure. All-branch failure, judge failure, or synthesizer failure fails the compound run.

## Tool And Write Isolation

Parent deny rules remain ceilings for every child.

- `none` exposes no tools.
- `readonly` exposes read, search, web, and language-server tools.
- `parent_without_teams` delegates parent-style capability while disabling team creation, team spawning, and nested Local Fusion.
- `all` exposes the broad child tool map subject to inherited permissions.

Branches and judge are research stages even under write-capable policies. They receive isolated per-run scratch directories outside every Session root, may use `write` and `edit` only in their own scratch directory, and cannot use `apply_patch` or edit workspace files.

Scratch identity is separated by parent Session, compound run, and branch index or judge role. If no scratch base outside all Session roots can be found, the run fails rather than weakening isolation.

The synthesizer does not use a scratch directory. It is the only stage that may apply final workspace edits, and only when its tool policy and inherited permissions allow them.

## Persistence Boundary

Branches, judge, and synthesizer are normal child Sessions. Local Fusion does not use team mailbox or team task persistence, and it does not copy private branch output directly into the parent assistant response.
