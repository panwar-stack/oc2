# Team Report

Generate a concise post-run effectiveness report for the current agent team.

## Workflow

1. Run the `team_report` tool for the active lead session.
2. If there is no active team, use the most recent shutdown team associated with the lead session when available.
3. If arguments are provided, treat each whitespace-separated token as a baseline lead session id and pass them as `compare_session_ids`.
4. Summarize throughput, task progress, daemon state, mailbox behavior, deterministic findings, residual failures, and cost or token impact if reported by the tool.
5. Keep conclusions actionable and distinguish tool-reported facts from interpretation.

## Examples

- `/team-report`
- `/team-report ses_previous_a ses_previous_b`
