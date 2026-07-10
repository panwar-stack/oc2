# Agent Team Evaluation

Agent Team Evaluation is a deterministic read-side analysis of persisted team activity. It reconstructs a directed graph, reports structural and lifecycle findings, attributes propagated failures, and feeds the `team_report` effectiveness report.

## Inputs And Graph

Evaluation reads the persisted team, member, task, mailbox message, recipient, and usage-event tables. It does not schedule work or mutate team state. Most findings use typed persisted fields; daemon activity checks also recognize narrow runtime-authored status and result markers in mailbox bodies.

Current graph nodes represent:

- the team;
- members;
- shared tasks;
- mailbox messages;
- completed member results.

Current edges represent containment, lead-to-member spawning, declared member and task dependencies, mailbox delivery, and member-produced results. The public node and edge vocabularies reserve session-event shapes, but the current builder does not ingest Session step or tool-call history.

## Findings

Checks are deterministic and derived from persisted fields. They cover invalid dependencies, ambiguous member names, cancelled or empty-result members, members blocked after dependencies settle, pending mailbox delivery, premature shutdown, structural deviations, shallow team usage, missing task or final-report behavior, and daemon lifecycle misuse.

Findings have `info`, `warning`, or `error` severity and stable categories. Expected-edge fixtures may request structural comparison; ordinary production reports do not require a predefined graph.

## Attribution

A non-informational finding without a failed upstream parent is a root cause. When a failed parent exists, the finding is marked propagated and receives a `propagates_to` edge. Parent selection prefers higher severity, then earlier creation time.

The summary includes node and edge counts, root and propagated failure counts, structural deviation count, longest dependency chain, and team-usage metrics.

## Surfaces

`GET /team/:teamID/eval` builds the report on read. Reports are not persisted snapshots.

`team_report` includes evaluation summary counts and the highest-priority root causes in its human-readable output, with the complete evaluation report in metadata. It combines evaluation with throughput, messaging, daemon, cost, token, and comparison metrics without changing the deterministic graph.
