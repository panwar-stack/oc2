# Initialize

Create or update `AGENTS.md` for this repository with compact, high-signal guidance for future oc2 agent sessions.

## Workflow

1. Read the highest-value sources first: `README*`, root manifests, lockfiles, build/test/lint/typecheck config, CI workflows, existing instruction files, and repo-local oc2 or opencode config.
2. If architecture is still unclear, inspect a small number of representative entrypoints and package-boundary files.
3. Prefer executable sources of truth over prose. If docs conflict with scripts or config, trust the executable source and only keep what can be verified.
4. If `AGENTS.md` already exists, improve it in place instead of rewriting blindly. Preserve verified useful guidance, remove stale or generic content, and reconcile it with current code.
5. Ask the user only if the repository cannot answer an important convention, setup requirement, or workflow expectation.

## What To Capture

- Exact developer commands, including focused test commands and required command order when it matters.
- Real app, library, package, or runtime entrypoints.
- Monorepo or multi-root boundaries, ownership, and generated-code rules if present.
- Framework, migration, environment, or test quirks an agent would likely miss.
- Repo-specific style or workflow conventions that differ from defaults.
- Important constraints from existing instruction files worth preserving.

## Required Principles

Include these principles in spirit, adjusting formatting to the target file:

1. Think before coding: do not assume, and surface uncertainty or tradeoffs.
2. Simplicity first: use the minimum code that solves the problem and avoid speculation.
3. Surgical changes: touch only what is needed and clean up only your own work.
4. Goal-driven execution: define success criteria and loop until verified.

## Exclude

- Generic software advice beyond the required principles.
- Long tutorials or exhaustive file trees.
- Obvious language conventions.
- Speculative claims or anything not verified from the repo.
- Content better stored in another referenced instruction file.

When in doubt, omit.
