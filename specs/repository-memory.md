# Repository Memory

Repository Memory is an implemented, repository-scoped retrieval subsystem for historical commits and high-activity file summaries. Its output provides localization hypotheses only; callers must verify every hint against the current working tree before editing.

## Stored Model

SQLite stores normalized repository identity and five related record types:

- repository metadata;
- indexed commits, changed files, bounded diffs, tokens, and optional linked issue data;
- file activity and co-change data;
- generated file summaries with source hashes and important symbols;
- retrieval logs for CLI, tool, API, GitHub, and evaluation use.

Repository deletion cascades to its indexed records. Re-indexing replaces the selected commit and activity window and prunes summaries that no longer match it. Retrieval logs remain historical audit records until the repository is cleared.

## Indexing

Indexing walks local Git history, applies repository identity normalization, excludes generated, vendored, lock, binary, and mass-formatting data by default, and records file activity from the same bounded commit window.

Cutoff commit and cutoff time are exclusive boundaries used by historical evaluation. Data at or after a cutoff is not indexed. The indexer may parse linked issue numbers from commit messages and stores optional issue fields, but it does not fetch issue title or body data.

File summaries target active files and reuse unchanged rows by source hash. Summary generation uses the configured OC2 model path; commit memory and activity remain usable when summary generation is unavailable.

## Retrieval

Commit and summary search use identifier-aware tokenization and bounded BM25-style sparse scoring. Tokens preserve complete identifiers and paths while also splitting common code naming conventions. Exact path and identifier matches are strong signals.

Search is scoped to one stored repository and bounded by configured result limits. Weak matches are identified rather than presented as confident results. Examined commit diffs carry an explicit historical-data warning; summary views report whether their source hash is stale.

## Surfaces

The CLI supports indexing, status, commit and summary search, commit examination, summary viewing, clearing, and historical localization evaluation. The HTTP API exposes the same service behavior and runs server-triggered indexing as a background job.

Four read-only agent tools expose indexed data:

- `memory_search_commit`;
- `memory_examine_commit`;
- `memory_search_summary`;
- `memory_view_summary`.

Tools and prompt guidance are available only when memory is enabled and an index exists for the active repository. Omitted `memory.enabled` means enabled. Indexing remains explicit, and indexing and clearing are not model-callable tools.

## Safety And Evaluation

Memory is never injected wholesale into every prompt. Commit-memory guidance and examination output require current-source verification and distinguish historical line numbers from current code. Summary views expose source-hash staleness instead of a historical-diff warning.

The evaluation harness rebuilds retrieval state at historical cutoffs and reports localization accuracy without future leakage. Retrieval logs record queries and returned IDs; evaluation records its final file candidates.
