# Harness Performance Improvements

Status: proposed

## Goal

Reduce controlled harness latency in four narrow areas: TUI startup, truthful first pixel, first visible chat
content, and lead-teammate mailbox work. Keep the current architecture and use bounded waits, immediate first
updates, and set-based database operations instead of broad startup or transport changes.

The first pass is the 10-file candidate diff described below. The candidate remained independently reviewable,
preserved existing semantics, and passed focused tests, package type checks, a compiled build, measured diagnostics,
and two independent adversarial audits.

## Current State

- `packages/tui/src/app.tsx` waits for terminal theme mode before mounting the renderer tree. The candidate calls a
  shared helper instead of using the previous 1,000 ms wait inline.
- `packages/tui/src/context/theme.tsx` owns startup theme fallback and later theme reconciliation. The candidate
  defines a 250 ms startup wait, which aligns with the terminal theme query window, then falls back to dark if no
  valid response arrives.
- `packages/tui/test/theme.test.ts` covers responsive dark/light results, the exact 250 ms argument, and dark
  fallback. `packages/tui/test/app-lifecycle.test.tsx` covers later theme reconciliation and user-lock precedence.
- `packages/tui/src/context/sync.tsx` batches legacy chat text deltas every 33 ms. The candidate flushes the first
  delta immediately when the stored part is empty and keeps later deltas at 33 ms.
- `packages/tui/src/context/sync-v2.tsx` batches V2 text and reasoning deltas every 33 ms. The candidate applies the
  same immediate-first-delta rule to both content types and keeps later deltas at 33 ms.
- `packages/tui/test/cli/cmd/tui/sync-live-hydration.test.tsx` and
  `packages/tui/test/cli/tui/sync-v2.test.tsx` cover immediate first legacy and V2 text, immediate first V2
  reasoning, later 33 ms coalescing, and final update/end reconciliation.
- `packages/opencode/src/team/team.ts` inserts one mailbox recipient row per recipient and claims pending rows in
  an immediate transaction. The candidate uses one set-based recipient insert and one set-based claim update,
  while preserving deduplication and exact-once claim semantics.
- `packages/opencode/test/team/team.test.ts` covers duplicate-recipient deduplication and two concurrent claims in
  which one claim receives all three messages and the other receives none.
- The candidate changes only these five source files and their five focused test files. It does not add a schema,
  API, protocol, configuration, generated client, or tracked benchmark artifact.

## Non-Negotiables

- Keep the startup theme wait at 250 ms unless a later same-artifact A/B result and terminal contract change justify
  another value. A shorter wait must not discard a response that is valid inside the terminal query window.
- A valid dark or light startup response must control the first rendered tree. No response must use the existing
  dark fallback. A later valid renderer event must reconcile an unlocked normal UI, while an explicit user lock
  must win.
- Do not claim terminal-cell-proven first paint from the current `ready_ms`, `ttfd_ms`, or first-byte diagnostics.
- The first stream delta must be visible immediately. Later text and reasoning deltas must retain the existing
  33 ms coalescing window to limit render work.
- Update/end events must flush or replace pending buffers without duplicate text, stale timer writes, or lost data.
- Mailbox recipient insertion and pending-message claim updates must be batched. They must retain transaction
  boundaries, recipient deduplication, pending-only compare-and-set behavior, and exact-once semantics under
  concurrent claims.
- Empty recipient and empty pending-message sets must not issue invalid set-based SQL.
- Do not change team wake behavior, delivery state names, message order, public tool output, or database schema.
- Performance evidence must state the artifact, cohort, sample count, metric definition, and comparison limit. Do
  not turn cross-run diagnostics into a causal performance claim.
- Do not mark future benchmark, SQL chunking, or error-fallback reactivity as implemented.

## Startup Design

- Export `STARTUP_THEME_WAIT_MS = 250` and `waitForStartupThemeMode()` from
  `packages/tui/src/context/theme.tsx` so the wait and fallback are testable outside `run()`.
- In `packages/tui/src/app.tsx`, prewarm the palette as before, await the helper once, stop if the renderer was
  destroyed, and pass the resolved or fallback mode into the existing render tree.
- The 250 ms theme wait aligns with the terminal query window. It removes 750 ms from the old no-response ceiling
  without intentionally rejecting a terminal response that remains valid.
- Keep current `ThemeProvider` event reconciliation. A late event updates the unlocked normal UI, and a locked user
  selection stays authoritative.
- Do not add a second query, a new timer, a startup flag, or a remount path.

## First Pixel Design

- The first rendered tree must use the terminal mode returned inside the 250 ms window, or the dark fallback after
  that window. The change reduces time before render; it does not add a separate shell or placeholder frame.
- Keep palette prewarm asynchronous. Theme discovery and later renderer events must not reset prompt state or
  override an explicit user lock.
- The current top-level error fallback receives the startup mode. The 250 ms wait protects valid in-window light
  responses. Making that fallback reactive to later mode changes is future work and is not implemented here.
- Use the existing compiled PTY benchmark for diagnostics. Its legacy `ready_ms` is the first cumulative PTY read
  that contains the TTFD diagnostic and visible prompt text. It is not proof of a committed terminal-cell frame.

## Chat Conversation Design

- In `packages/tui/src/context/sync.tsx`, inspect the current legacy part before buffering a delta. If its text is
  empty, append and flush that first delta synchronously. Otherwise, retain the 33 ms scheduled flush.
- In `packages/tui/src/context/sync-v2.tsx`, apply the same rule to current V2 text and reasoning content. The first
  stream delta is immediate, while later deltas stay at 33 ms.
- Keep the existing per-content buffer keys and shared timer. An update, end, failure, or disposal path must still
  flush or clear the correct pending content.
- Event deduplication stays outside this change. Receiving the same event through current test paths must not cause
  content duplication.

## Team Communication Design

- In `packages/opencode/src/team/team.ts`, build all deduplicated recipient rows and send one multi-row insert inside
  the existing immediate transaction. Preserve one unique row ID per logical recipient.
- Claim pending mailbox rows with one update restricted to the selected recipient-row IDs and
  `delivery_status = "pending"`. The immediate transaction remains the serialization boundary.
- Mailbox recipient insert and claim updates are batched with exact-once semantics: duplicate requested recipients
  produce one delivery row, and concurrent claims cannot return the same message twice.
- Guard zero-length arrays before multi-row insert or `IN` update generation.
- Keep SQL batching bounded only by current practical mailbox sizes in this pass. Explicit chunking for lower SQL
  variable limits or extreme queues is future work.

## Measured Baselines And Final Diagnostics

All values below are warm PTY diagnostics on one machine. The table identifies the exploratory source/dev row;
the other rows are compiled diagnostics. They are not product-wide service-level objectives.

| Cohort                                          |        Samples | First-byte median | TTFD median | Legacy ready median |         Ready p95 |
| ----------------------------------------------- | -------------: | ----------------: | ----------: | ------------------: | ----------------: |
| Historical responsive dark baseline             |             20 |         733.51 ms | 2,067.14 ms |         2,080.84 ms | Not recorded here |
| Historical no-theme-response baseline           |             10 |         784.26 ms | 3,010.42 ms |         3,023.80 ms |       5,152.40 ms |
| Exploratory source/dev responsive dark baseline |   5 valid of 5 |      1,243.406 ms | 2,508.49 ms |        2,524.199 ms |      2,633.830 ms |
| Final 250 ms responsive dark diagnostic         | 20 valid of 20 |         532.97 ms | 1,229.38 ms |         1,243.29 ms |       1,294.76 ms |
| Final 250 ms no-theme-response diagnostic       | 10 valid of 10 |         539.23 ms | 1,505.01 ms |         1,520.89 ms |       1,582.39 ms |

- The historical no-response minus dark ready-median gap was 942.95 ms.
- The historical no-response first-byte median was 50.75 ms above the historical responsive-dark median.
- The historical no-response artifact was `0.0.0-main-202607280544` for ARM64. Its binary hash, build log, and
  source tie were not preserved, so it cannot be an immutable artifact baseline.
- The final observed no-response minus dark ready-median gap was 277.60 ms, which is 665.35 ms smaller.
- Both final cohorts had zero timeouts. The built artifact was `0.0.0-main-202608011915` for
  `oc2-darwin-arm64`.
- The source/dev baseline ran at revision `865df6ebf83c0d9aed580e57c01ebf56c9007c4a` with Bun 1.3.14 and
  Python 3.9.6. Its exact command was
  `python3 perf/tui-startup/tui_benchmark.py --label source-dev-dark-baseline --samples 5 --mode warm --timeout 20 --theme-response dark -- bun run --cwd packages/opencode --conditions=browser src/index.ts --pure "$PWD"`.
- The exact exploratory source/dev values in the table came from the investigation handoff. No local JSONL or
  artifact that contains those samples was preserved, so the row is context only and is not acceptance evidence.
  It also includes development transforms, has only five samples, and is not a production or compiled baseline.
- This historical comparison is cross-run diagnostic evidence only. It is not an interleaved, immutable,
  same-artifact A/B comparison and does not establish causality.
- The harness creates one process for each sample. Warm mode reuses isolated HOME/XDG state after one seed but does
  not clear operating-system filesystem or page caches. Results depend on host load, caches, thermal state, build,
  and terminal path.
- Chat and mailbox changes have behavioral verification only. No direct performance measurement exists for them
  in this pass.

Completed candidate diagnostics before this spec was added:

- TUI startup/theme tests: 13 passed, 0 failed, 31 expectations. One known non-fatal missing user KV file message
  was emitted.
- Legacy and V2 sync tests: 26 passed, 0 failed, 62 expectations, including direct V2 reasoning first-delta and
  later-coalescing coverage.
- Team and team-message tests: 45 passed, 0 failed, 200 expectations.
- `packages/tui` and `packages/opencode` type checks exited 0.
- `bun run dev:build` exited 0, and the compiled `oc2-darwin-arm64` smoke test passed.
- `git diff --check` exited 0, and no benchmark JSONL under `tmp/tui-startup-results/` was tracked.
- Two independent read-only audits reviewed the complete implementation, tests, evidence, and specification. The
  audits found the earlier 100 ms wait, incomplete historical evidence, stale file counts, missing direct V2
  reasoning coverage, and stale final-state wording. The candidate now uses 250 ms, the evidence limits are
  explicit, direct V2 reasoning coverage passes, and the audit findings are resolved.

## Implementation Slices

Each slice must be small enough for independent review. Run commands from the repository root unless the command
uses `--cwd`.

### PR 1: Bound Startup Theme Wait

- Add the 250 ms helper in `packages/tui/src/context/theme.tsx`.
- Use it from `packages/tui/src/app.tsx` without changing palette prewarm or renderer destruction handling.
- Add direct helper tests and late-reconciliation/user-lock coverage.

Verification:

- `bun run --cwd packages/tui test --timeout 30000 test/theme.test.ts test/app-lifecycle.test.tsx`
- `bun run --cwd packages/tui typecheck`
- `bun run dev:build`

Review gate: completed.

Two independent read-only audits challenged the terminal query window, responsive light first render, no-response
fallback, late reconciliation, user-lock precedence, destroyed-renderer handling, and error fallback. The first
audit rejected the earlier 100 ms wait. The candidate changed to 250 ms, repeated the focused tests and compiled
diagnostics, and passed the final audit.

### PR 2: Show The First Chat Delta Immediately

- Flush the first legacy text delta synchronously in `packages/tui/src/context/sync.tsx`.
- Flush the first V2 text and reasoning delta synchronously in `packages/tui/src/context/sync-v2.tsx`.
- Preserve the 33 ms timer for later deltas and all current final reconciliation paths.
- Cover immediate first legacy and V2 text, immediate first V2 reasoning, later coalescing, and final reconciliation
  in the focused tests.

Verification:

- `bun run --cwd packages/tui test --timeout 30000 test/cli/cmd/tui/sync-live-hydration.test.tsx test/cli/tui/sync-v2.test.tsx`
- `bun run --cwd packages/tui typecheck`

Review gate: completed.

Two independent read-only audits challenged duplicate events, empty deltas, update/end/failure races, stale timers,
text/reasoning symmetry, lost content, and excess render work. Direct V2 reasoning coverage was added after review,
and the final focused run passed 26 tests with 62 expectations.

### PR 3: Batch Mailbox Writes And Claims

- Replace per-recipient inserts with one guarded multi-row insert in `packages/opencode/src/team/team.ts`.
- Replace per-message claim updates with one guarded pending-only `IN` update in the same service.
- Cover duplicate recipients, several pending messages, and two concurrent claimers.

Verification:

- `bun run --cwd packages/opencode test test/team/team.test.ts test/tool/team_messages.test.ts --timeout 30000`
- `bun run --cwd packages/opencode typecheck`

Review gate: completed.

Two independent read-only audits challenged transaction scope, exact-once claims, recipient deduplication, empty
sets, row identity, message ordering, rollback, SQL variable limits, and unchanged wake behavior. No material
mailbox finding remained after the focused tests and final audit.

### PR 4: Compile, Measure, And Integrate

- Build one compiled artifact and record its version and platform.
- Run the responsive-dark and no-response diagnostic commands against that same built executable.
- Keep JSONL output under `tmp/`; do not track it.
- Report sample validity, timeouts, medians, p95, metric limits, and the cross-run comparison limit.

Verification:

- `bun run dev:build`
- `OC2_BIN="$(printf '%s\n' packages/opencode/dist/oc2-*/bin/oc2)"; test -x "$OC2_BIN"`
- `python3 perf/tui-startup/tui_benchmark.py --label verifier-final250-compiled-dark --samples 20 --mode warm --theme-response dark --output tmp/tui-startup-results/verifier-final250-compiled-dark-warm-20260801.jsonl -- "$OC2_BIN" --pure "$PWD"`
- `python3 perf/tui-startup/tui_benchmark.py --label verifier-final250-compiled-none --samples 10 --mode warm --theme-response none --output tmp/tui-startup-results/verifier-final250-compiled-none-warm-20260801.jsonl -- "$OC2_BIN" --pure "$PWD"`
- `test -z "$(git ls-files -- 'tmp/tui-startup-results/*.jsonl')"`
- `git diff --check`

Review gate: completed.

Two independent read-only teammates compared the complete diff, this specification, all focused test results, both
type checks, the compiled build, and measurement output. They reported findings with file and line evidence and did
not edit. The candidate resolved all material findings. Final focused tests, type checks, build, Prettier check, and
`git diff --check` passed.

## Future Work

- Add an interleaved, immutable, same-artifact A/B benchmark so startup deltas can support causal claims.
- Add a terminal-cell screen oracle for committed first frame and prompt paint instead of relying on legacy
  cumulative PTY reads.
- Add measured chat render-latency diagnostics.
- Measure mailbox SQL statement count and end-to-end lead wake latency under realistic multi-recipient loads.
- Chunk mailbox insert and claim statements only if supported adapters or measured queue sizes can exceed safe SQL
  variable limits.
- Make the top-level error fallback react to a valid theme change after startup if product behavior requires it.

## Decisions

- Accept this narrow candidate with behavioral checks and compiled diagnostics only. Keep the cross-run limitations
  explicit and do not claim causality. Require an interleaved, immutable, same-artifact A/B benchmark before a
  stronger performance claim.
- Do not add mailbox statement chunking in this candidate. Current limits and test scope do not justify more code.
  Keep chunking as future work only if measured scale or a supported adapter limit requires it.
