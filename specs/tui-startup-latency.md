# TUI Startup Latency Implementation Spec

Status: proposed
Source audit: `spikes/tui-startup-performance/README.md`
Tooling: `perf/tui-startup/`

## Goal

Reduce startup latency for the compiled, local, pure-mode TUI home route without changing command semantics, plugin ordering, configuration precedence, terminal cleanup, or prompt behavior.

The TUI must paint a truthful shell quickly, show the real home prompt without waiting for terminal-theme negotiation, and accept a first safe interaction after its declared critical bootstrap and theme prerequisites are current.

This is not a general CLI rewrite. Source/dev, installed-launcher, external-server, continuation, prompt auto-submit, non-pure external-plugin, and other host/terminal paths retain correctness coverage but need separate baselines before becoming latency gates.

## Current State

- July 2026 compiled warm responsive-dark measurements were 733.51 ms median legacy `first_byte_ms`, 2067.14 ms median app-reported `ttfd_ms`, and 2080.84 ms median legacy `ready_ms` prompt-bearing cumulative PTY read (n=20).
- Legacy `ready_ms` means the first cumulative PTY read containing both the TTFD diagnostic and `Ask anything...`; it is not terminal-cell-proven paint.
- Fresh per-sample state raised the legacy `ready_ms` prompt-bearing cumulative PTY-read median to 2354.61 ms and p95 to 3888.43 ms (n=15).
- No OSC 10/11 response produced a 3023.80 ms median legacy `ready_ms` prompt-bearing cumulative PTY read, 942.95 ms slower than responsive dark, while first byte moved only 50.75 ms.
- These numbers describe one machine/artifact, not product-wide SLAs. The audit supplies no screen-oracle `prompt_ms`.
- Source/dev warm median legacy `ready_ms` prompt-bearing cumulative PTY read was 3128.10 ms; native/dev transform and loader work make it diagnostic only.
- `packages/opencode/src/index.ts` selects the CLI command behind a dynamic import.
- `packages/opencode/src/cli/cmd/tui.ts` resolves the project, spawns `cli/tui/worker.ts`, creates `util/rpc.ts`, prepares transport/config/session input, imports the runtime, and owns launch/cleanup.
- `packages/tui/src/app.tsx` currently waits up to one second for renderer theme mode before render, then gates the route on sequential plugin-host activation.
- `packages/tui/src/context/theme.tsx` already owns fallback theme state, late renderer events, palette refresh, custom themes, and cleanup.
- `packages/tui/src/context/sync.tsx` blocks on config/providers, full provider list, agents, config, project sync, and continuation sessions; other data starts later.
- `packages/opencode/src/plugin/tui/runtime.ts` activates plugins sequentially to preserve command, keybind, route, and hook precedence.
- `perf/tui-startup/tui_benchmark.py` reports legacy `first_byte_ms`, app `ttfd_ms`, and legacy `ready_ms`; it does not prove committed paint, accepted input, phase cost, or exact artifact identity.

## Non-Negotiables

1. No blank frame, early diagnostic, raw-byte match, TTFD-only result, or `OC2_FAST_BOOT` shortcut may count as a speedup.
2. OSC response, timeout, malformed data, rejection, or a late valid result must never block first render or reset focus/input/remount the prompt.
3. Explicit locks and saved theme/config precedence win. Initial fallback is built-in and never waits for custom-theme discovery.
4. External/unknown plugins stay deterministic and sequential; no blanket parallel activation or post-prompt deferral.
5. Critical bootstrap has one owner/application point and preserves scope, continuation, labeled failures, generations, and live-event race protection for every snapshot field.
6. Internal worker-fetch and external HTTP transports use one equivalent bootstrap contract; no default internal-only fast path.
7. Editing may precede critical readiness; submit preserves text, explains startup, and requires retry rather than failing, disappearing, or silently queueing.
8. Invalid input, renderer failure, worker loss, blocked quit, and unrecoverable critical failure remain visible and nonzero; one parent-owned post-spawn `finally` cleans all resources.
9. Telemetry is opt-in, monotonic, bounded, versioned, and excludes prompts, credentials, environment dumps, paths, file/session/event content, stacks, and arbitrary errors.
10. Accepted claims require clean, immutable baseline/candidate artifacts in balanced same-machine A/B runs. Dirty sanitized diagnostics cannot pass.

## Metrics And Provisional Exit Targets

All milestones use the harness monotonic clock from immediately before process creation. Application elapsed values and worker durations are diagnostic only.

| Metric | Binding definition |
| --- | --- |
| First valid frame | First committed terminal-emulator frame that is nonblank, covers confirmed 100x30 cells, and contains no plain fatal diagnostic. |
| Time to shell | Later harness observation of out-of-band `shell.drawn` and a committed 100x30 frame matching the built-in truthful startup-shell oracle. Unavailable before the shell slice; never alias first frame. |
| Time to prompt | Later harness observation of `prompt.mounted` and a committed frame containing the actual home textarea placeholder at its expected cells. Query/erased/raw bytes do not count. |
| Critical ready | Receipt of `bootstrap.critical.ready` for the active workspace and attempt generation. |
| Theme settled | Receipt of `theme.settled` (`locked`, `resolved`, or bounded `fallback-final`); later valid `theme.reconciled` restarts persistence checks. |
| Time to interactive | First post-prerequisite committed frame containing the complete probe token after current critical-ready and theme-settled/reconciled observations. It does not promise provider/model/network readiness outside the critical contract. |

| Warm cohort | Shell median / p95 | Prompt median / p95 | Interactive median / p95 |
| --- | ---: | ---: | ---: |
| Responsive dark/light | <=1000 / <=1500 ms | <=1600 / <=2200 ms | <=1800 / <=2500 ms |
| No response | <=1000 / <=1500 ms | <=1700 / <=2300 ms | <=1900 / <=2600 ms |

- Candidate no-response median prompt and interactive may be at most 100 ms slower than matched responsive dark.
- Candidate prompt/interactive p95 in every matched cohort, including cold-like, must be <=105% of the preserved baseline; shell has only its absolute target.
- `pre-shell-v1`: both artifacts may declare only shell unavailable. `shell-v1`: only baseline shell may be unavailable and candidate must reach frame/shell. `full-v1`: only baseline shell may be unavailable; candidate must reach every milestone.
- Pre-shell/full policies require correct immediate light/dark, none, malformed, and late-valid theme outcomes plus probe persistence/removal. `shell-v1` claims only frame/shell correctness.
- Any other missing milestone, invalid sample, timeout, artifact/state mismatch, or cohort/lifecycle failure fails closed.
- Targets are provisional engineering gates for the controlled host until repeated cross-host data exists.

## Design Contracts

### Trace And PTY Oracle

- Add an opt-in inherited trace pipe to one main-process collector initialized in `packages/opencode/src/index.ts` before parsing/dynamic TUI import; emit `cli.entry` after unavoidable static ESM evaluation.
- After worker spawn, `cli/cmd/tui.ts` adopts the same collector as its first owned resource without resetting origin or dropping records. A core exit fallback covers non-TUI and pre-spawn failures.
- Only the parent serializes versioned allowlisted JSONL. Worker clocks emit durations; the harness timestamps pipe receipt and correlates run/request IDs. Sink failure atomically disables tracing and never affects startup or PTY cells.
- Record bounded phases/outcomes, role, generation, stable request name, actual encoded UTF-8 byte counts, dispatch-only timing, and only schema-proven duplicate bytes. Never emit payload content/hashes or combine process clocks.
- Configure the PTY slave to 100x30 before `exec`: require successful `TIOCSWINSZ`, child ready byte, close-on-exec EOF, and an entry fixture confirming `TIOCGWINSZ`. Otherwise invalidate the sample.
- `terminal_screen.py` must model only renderer-used control sequences, Unicode cell width, cursor/erase/resize, alternate screen, and synchronized commits. Unknown state mutation/desynchronization invalidates; raw bytes never substitute.
- Parse arbitrarily fragmented OSC queries and trace lines independently. `shell_ms`/`prompt_ms` are the later of marker receipt and committed matching frame.
- Probe body is lowercase ASCII `oc2latency` + hex nonce, followed only after prerequisites by guard `z`; it contains no Enter/control/keymap sigil. Observe the full token in textarea cells, never terminal echo.
- Recheck after every in-window reconciliation; bounded windows end 100 ms after expected resolved/fallback/reconciled state. Backspace exactly once per ASCII code point and prove token absence plus original-content restoration.
- JSONL metadata records argv, controlled environment, mode/scenario/theme fixture, timeout, PTY size, state policy, seeded balanced schedule, cwd, revision/clean state, binary path/hash/size/build command, runtimes/OS/arch, and harness identity. Review local paths before sharing.
- Preserve legacy fields only as diagnostics; add `first_frame_ms`, `shell_ms`, `prompt_ms`, `critical_ready_ms`, `theme_settled_ms`, and `interactive_ms` with named failures and nonzero invalid-run exit.

### Launcher And Import Boundaries

- Direct compiled `os.execvpe` is authoritative. Measure `packages/opencode/bin/oc2` with `OC2_BIN_PATH` in a separate launcher cohort. Source/dev remains functional/import diagnostic only.
- Slice 1B owns repairing `packages/opencode/bin/oc2` so its shebang execution works inside the package's `"type": "module"` scope, plus a smoke test that invokes the executable directly with `OC2_BIN_PATH` set to a harmless fake target and proves argument/exit propagation. The launcher diagnostic is forbidden until that test passes; never invoke this CommonJS-form launcher as `node packages/opencode/bin/oc2`.
- Do not pull memoized shell discovery onto startup. Preserve dynamic/delayed import boundaries unless a focused measured slice proves a narrower change.
- Process creation to `cli.entry` is unattributed runtime/eager-static-import time, not CLI middleware. Do not add barrels; split only measured heavy conditional registrations/routes.

### Theme, Shell, And Prompt

- Remove pre-render `waitForThemeMode(1000)`. Use valid synchronous renderer state or built-in dark fallback; negotiate mode/palette concurrently after first render.
- `theme.tsx` owns lifecycle and preference generations. Persisted theme+lock is one atomic delayed read and applies only if no newer user action/write; locks beat terminal results, unlocked `system` follows the latest valid result.
- Missing/malformed/rejected/timed-out queries settle `fallback-final`; a valid late result may reconcile atomically once per generation. Unmounted/destroyed providers ignore all completions.
- Saved custom themes retain fallback until KV/custom discovery resolves. Reconciliation must preserve focus, selection, prompt text, and probe.
- In one renderer tree, paint a dimension-filling built-in honest shell independent of SDK, bootstrap, custom themes, sessions, and plugins; atomically replace it when deterministic plugin gating allows the real route.
- Mount the home prompt for editing while bootstrap loads, but disable submit with one deterministic message. Slice 1B first emits content-free `prompt.mounted`, `bootstrap.critical.ready`, `theme.settled`/`theme.reconciled`, and `input.accepted` markers with explicit `workspaceGeneration: 0` and `attemptGeneration: 0` at the unchanged current boundaries. Slice 6B relocates them to the new real component/application boundaries, retags them with the active generations, and removes the generation-0 emission sites so one transition emits one marker.

### RPC And Parent Lifecycle

```ts
type RpcErrorCode = "invalid_request" | "unknown_method" | "handler_failed" |
  "serialize_failed" | "transport_closed" | "aborted" | "deadline_exceeded"
type RpcCallOptions = { signal?: AbortSignal; timeoutMs?: number; deadlineMs?: number }
type RpcHandlerContext = { signal: AbortSignal }
```

- Keep JSON-string result/event encoding. Version request/result/error/cancel envelopes; validate JSON, shape, known method, and safe-integer ID before dispatch.
- Every parseable request with trusted ID gets exactly one terminal result/error. Bound sanitized messages to 256 UTF-8 bytes; never serialize stacks, inputs, thrown objects, or remote names.
- Server tracks an `AbortController` per handler; cancel wins settlement and suppresses late output. Client pending entries own resolve/reject/cleanup; every first settlement removes listeners/timers and ignores duplicates.
- Export typed remote/protocol/serialize/aborted/deadline/transport-closed errors. Malformed terminal data with a pending ID rejects that request; uncorrelatable protocol failure disposes the client and rejects all pending calls.
- Idempotent disposal detaches listeners, rejects pending calls, prevents new calls, and cancels active requests while writable. Pre-aborted/expired calls never post.
- No blanket timeout: critical bootstrap/retry uses a named 30-second product deadline; worker shutdown retains five seconds; benchmark timeout remains 12 seconds.
- One parent liveness adapter maps worker error, deserialization failure, and every available close/exit signal to RPC disposal/controller notification exactly once.
- Immediately after `new Worker`, one outer `try/finally` owns trace, timers, listeners, terminal guard, RPC, renderer/runtime/plugin host, graceful shutdown, and termination across every return/throw. Cleanup errors do not replace the primary outcome.
- Return tagged `TuiRunOutcome`: completed=0; invalid arguments/chdir/session, input/config/transport/renderer failure, blocked quit, and worker loss=1. Set `process.exitCode` only after cleanup; preserve existing signal convention.

### Bootstrap Authority, Catalog, And Resilience

- Critical: configured providers/default-model resolution (`config.providers`, not full catalog), agents, resolved config, project sync, and continuation-only session data. Apply validated results in one Solid batch.
- Optional: full `provider.list`/`provider_next`, commands, LSP/MCP/resources/formatters, session status, provider auth, VCS/workspace, and ordinary sessions. Settle independently, expose loading/degraded state, and never leak unhandled rejections.
- Provider catalog is provider-dialog/on-demand work. If measured first-submit evidence proves catalog necessity, document the exact invariant and add only a normalized minimal subset, never duplicate the full catalog.
- `workspaceGeneration` increments before workspace/instance changes; `attemptGeneration` increments before initial/retry/refresh. Tag requests, buffers, markers, and responses; abort/discard stale work on retry, switch, repeated disposal, unmount, or transport loss.
- Subscribe once before hydration. Before a sequenced endpoint exists, buffer all owned-field events and replay in arrival order through existing reducers/tombstones after one snapshot apply.
- Consolidation is conditional on the durable, SHA-256-verified and provenance-validated `core-bootstrap-v1` decision preserved from the post-Slice-6B candidate that passed `full-v1`: implement only if median removable dispatch beyond one retained envelope is >=50 ms or the candidate-arm median across valid per-sample integer `removable_duplicate_bytes` is >=64 KiB (65,536 bytes). For this byte threshold, sort the per-sample values and use `2 * middle` for odd counts or `lower_middle + upper_middle` for even counts; `implement` requires that exact twice-median to be >=131,072. Missing, invalid, or non-integer sample values fail closed. Otherwise persist the reviewed `skip` artifact and omit Slices 7A-8. Temporary result paths never unlock those slices.
- If implemented, server captures an ordered per-workspace/instance watermark before concurrent field reads and returns versioned per-field success/error envelopes plus attempt identity. Fields without a covering ordered sequence cannot join.
- Client replays only matching events with sequence greater than watermark; at/below are represented by reads. Normal home gets exactly one core request per attempt, with at most one continuation request; internal and external transports remain equivalent.
- Adoption must strictly lower both core request count and the exact median per-sample encoded UTF-8 response-byte total against the hash-linked post-Slice-6B candidate, keep every sample valid, and pass the current `full-v1` gate. For each valid normal-home candidate-arm sample, sum the actual encoded response-envelope byte lengths of the fixed core-request allowlist. Sort those integer totals; represent the median as `2 * middle` for odd counts and `lower_middle + upper_middle` for even counts, with no rounding, and require the Slice 8 value to be strictly smaller. Missing/non-integer/negative bytes, invalid or duplicate samples, unequal positive sample counts, or scenario/mode/theme/state/schedule/allowlist mismatch fails closed.
- Bootstrap failure with live transport keeps prompt text, blocks submit, and offers Retry/new attempt plus Quit. Worker loss offers only Quit and relaunch, because parent restart is not implemented. Blocked/worker-lost quit is nonzero; successful retry may later exit zero.
- Invalid `--fork`, project `chdir`, and requested-session failures remain pre-render nonzero errors. Known nonfatal plugin failure is reported once and degrades startup without changing deterministic activation order.

### Safe Deferral

- Defer one measured dependency edge per PR only after the full gate. Candidates: auto-update after interactive/idle, disabled internal built-ins, heavy UI behind lightweight registration, or session route behind navigation while retaining required parser registration.
- A deferred internal plugin requires proof it cannot affect initial render, route, commands/keybind precedence, hooks, theme/config, first submit, or cleanup. Preserve relative order and loading/degraded state.
- Never blanket-parallelize plugins or defer external/unknown plugins, event/notification subscription, KV locks, continuation data, or submit prerequisites. Source profile/import size alone is not evidence.

## Implementation Slices

Each slice is independently revertible and reviewed. Do not start behavior changes until 1A-2F finish and the clean immutable pre-behavior baseline is preserved. Run from repository root; root `bun run test` is disabled.

### Mandatory Fresh Review Gate

After every slice, a fresh read-only reviewer that neither implemented nor advised on it receives the slice plan, changed paths, results, prompt below, and full clean-branch diff. Run exactly:

```sh
git status --short
BASE="$(git merge-base HEAD origin/main)"
git diff --check "$BASE"...HEAD
git diff --stat "$BASE"...HEAD
test -z "$(git status --short)"
git diff --no-ext-diff --unified=80 "$BASE"...HEAD
```

Fix findings and rerun checks; a different fresh reviewer reviews the update. Self-review never passes. Every prompt ends: "Report findings with file/line evidence; do not edit."

- **1A:** Read only; falsify early collector initialization, adoption/origin/order, exactly-once fallback cleanup, opt-in privacy/schema, fail-closed sink, PTY isolation, disabled cost, import cycles, and negative tests.
- **1B:** Read only; falsify every boundary, generation-0 prompt/critical/theme/input marker, local clocks, exact UTF-8 count, dispatch-only exclusion, allowlisted exact duplicate proof, bounded cleared state, privacy, cardinality, disabled cost, launcher shebang smoke test, and RPC drift.
- **2A:** Read only; falsify pre-exec 100x30 and handshake truth, committed-cell visibility, fragmented escapes, erase/overwrite, alternate screen, wide cells, resize, unsupported sequences, EOF, and cleanup.
- **2B:** Read only; falsify fragmented markers, reversed marker/frame order, paint-erase, each early exit/timeout, descendant leaks, receipt-clock correlation, raw-byte rejection, compatibility, and the no-OSC/probe boundary.
- **2C:** Read only; falsify fragmented OSC, malformed/none/immediate/late modes, generation races, echo lookalikes, rejected/erased input, reconciliation, exact removal, bounded windows, privacy, cleanup, and no artifact/A-B scope.
- **2D:** Read only; falsify clean/dirty identity, redaction, immutable hashes, overwrite refusal, capabilities, schedule balance, labels, state isolation, warm seeds, compatibility, exclusive output, and absence of gate policy.
- **2E:** Read only; falsify every policy/cohort/identity/state/lifecycle/percentile/gap boundary and nonzero exit; attack delta allowlist, hashes, baseline/base chain, candidate selection, strict decrease/post-interactive proof, and overwrite refusal.
- **2F:** Read only; falsify full-gate and candidate provenance, retained-envelope math, both thresholds, exclusion of totals/unique data/stringify time, deterministic skip/implement, privacy, adoption count/byte strictness, invalid inputs, and rejection exits.
- **3A:** Read only; falsify malformed data/IDs/methods, handler/serialization failures, concurrency, abort/deadline/cancel races, late duplicates, disposal, post-disposal calls, event isolation, exact settlement, cleanup, typed errors, and unchanged JSON encoding.
- **3B:** Read only; enumerate every post-spawn return/throw and falsify the one `finally`; race liveness, pending RPC, quit/signals/cleanup, terminal restoration, primary outcomes, and absence of recovery UI or fake restart.
- **4A:** Read only; falsify critical/optional classification, configured-provider/default-model option behavior, optional settlement, labeled errors, catalog UI, route gates, blocked-state retention, readiness compatibility, unhandled rejection, and absence of controller/prompt/recovery/exit work.
- **4B:** Read only; race every owned field with retry/workspace/disposal/events/deadline/loss/unmount; falsify both generations, subscription count, cleanup, replay idempotence, and any false watermark claim.
- **5:** Read only; falsify immediate/late/none/malformed/rejected theme, destruction/cleanup, atomic delayed preference+lock, user/disk/write races, system/custom/repeated events, generations, focus/text/selection/probe, terminal cleanup, and any hidden render wait.
- **6A:** Read only; falsify screen-visible/responsive shell independence and same-tree atomic replacement under slow/failing dependencies, resize/signals/renderer failure; seek blanks, focus loss, duplicate activation, leaks, or fast-boot shortcuts.
- **6B:** Read only; race typing/Enter, readiness/generations/reconciliation/plugins/workspace/shell replacement; falsify honest submit blocking, focus/text/selection, no queue, relocation and active-generation retagging of every prompt/critical/theme/input marker, removal of generation-0 emitters, screen agreement, and exclusion of recovery/liveness/exit work.
- **6C:** Read only; race failure/deadline/retry/stale attempt/workspace/worker/quit/signals/renderer/cleanup; falsify actions, edit preservation, exact subscription/plugin/cleanup counts, typed exits, no fake restart, and unchanged prompt/metrics.
- **7A:** Read only; race publication/watermark/workspace recreation/subscribers for every field; falsify strict per-workspace ordering, instance authority, additive compatibility, cleanup, and unchanged client readiness.
- **7B:** Read only; falsify field envelopes/scope/continuation/auth/partial failure/concurrency/pre-read watermark, catalog exclusion, default normalization, unchanged TUI/RPC/readiness, and stable generated output.
- **8:** Read only; falsify old/new equivalence, every field around watermark/retry/workspace/disposal/unmount, generations/instance/order/cleanup, continuation, duplicate calls, optional catalog, transport parity, UTF-8 accounting, hidden failures, and scope.
- **9:** Read only; falsify the single measured deferral by tracing every moved registration/side effect/route/command/keybind/hook/parser/theme/cleanup/submit dependency; test rapid navigation, failure/retry, order, flags, shutdown, and compiled A/B evidence.

### Slices And Package Verification

- **1A — Trace schema, pipe, collector, privacy:** add the core reporter, flag, early collector/adoption, allowlist, fail-closed sink, and disabled tests. Verify: `bun run --cwd packages/core test -- test/util/tui-startup-profile.test.ts && bun run --cwd packages/core typecheck && bun run --cwd packages/opencode test -- test/cli/tui/startup-trace.test.ts && bun run --cwd packages/opencode test -- test/index/startup-trace.test.ts && bun run --cwd packages/opencode typecheck && bun run lint && bun run check:packages`.
- **1B — Phase emissions, launcher, and bytes:** instrument worker/RPC, TUI, sync, plugins, local clocks, actual UTF-8, dispatch-only work, and exact duplicates; emit the prompt/critical/theme/input markers at their unchanged current boundaries with both generations set to zero; repair the ESM-scope launcher and add direct-executable fake-target coverage. Verify: `bun run --cwd packages/core test -- test/util/tui-startup-profile.test.ts && bun run --cwd packages/opencode test -- test/cli/tui/startup-trace.test.ts test/cli/tui/thread.test.ts test/cli/launcher.test.ts && bun run --cwd packages/tui test -- test/app-lifecycle.test.tsx && bun run --cwd packages/core typecheck && bun run --cwd packages/opencode typecheck && bun run --cwd packages/tui typecheck && bun run lint && bun run check:packages`.
- **2A — PTY/screen:** add `terminal_screen.py`, pre-exec 100x30 handshake, fixtures, and oracle tests only. Verify: `mkdir -p tmp/pycache && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m py_compile perf/tui-startup/terminal_screen.py perf/tui-startup/tui_benchmark.py perf/tui-startup/tui_probe.py && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m unittest discover -s perf/tui-startup -p 'test_terminal_screen.py'`.
- **2B — Milestones/failures:** add fragmented trace parsing, screen oracles, named failures, and fake-child tests; no OSC/probe. Verify: `mkdir -p tmp/pycache && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m py_compile perf/tui-startup/fake_tui.py perf/tui-startup/tui_benchmark.py && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m unittest discover -s perf/tui-startup -p 'test_tui_benchmark_milestones.py'`.
- **2C — OSC/probe:** add all response fixtures, explicit probe flag, current-generation persistence/removal, and cleanup. Verify: `mkdir -p tmp/pycache && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m py_compile perf/tui-startup/fake_tui.py perf/tui-startup/tui_benchmark.py && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m unittest discover -s perf/tui-startup -p 'test_tui_benchmark_probe.py'`.
- **2D — Artifacts/A-B:** add `preserve`/`compare`, identity/privacy, balanced schedule, isolated state, and compatibility; no policy. Verify: `mkdir -p tmp/pycache && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m py_compile perf/tui-startup/tui_benchmark.py perf/tui-startup/tui_probe.py && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m unittest discover -s perf/tui-startup -p 'test_tui_benchmark_artifacts.py' && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m unittest discover -s perf/tui-startup -p 'test_tui_benchmark_compare.py' && bun run dev:build`.
- **2E — Aggregate/delta gates:** implement fail-closed `pre-shell-v1`, `shell-v1`, `full-v1`, and `single-deferral-v1`. Verify: `mkdir -p tmp/pycache && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m py_compile perf/tui-startup/benchmark_gate.py perf/tui-startup/tui_benchmark.py && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m unittest discover -s perf/tui-startup -p 'test_tui_benchmark_gate.py' && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m unittest discover -s perf/tui-startup -p 'test_tui_phase_delta_gate.py'`.
- **2F — Bootstrap decisions:** implement deterministic `core-bootstrap-v1`, `core-bootstrap-adoption-v1`, and the fail-closed privacy/provenance-preservation subcommand used below; only removable dispatch/duplicates unlock consolidation, and adoption uses the exact integer median representation defined above. Verify: `mkdir -p tmp/pycache && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m py_compile perf/tui-startup/bootstrap_decision.py perf/tui-startup/tui_benchmark.py && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m unittest discover -s perf/tui-startup -p 'test_tui_bootstrap_decision.py' && PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -m unittest discover -s perf/tui-startup -p 'test_tui_bootstrap_adoption_gate.py'`; then run **Baseline Preservation** exactly once.
- **3A — RPC settlement:** change only `util/rpc.ts`; add typed exact-once/cancel/deadline/serialization/event/disposal tests. Verify: `bun run --cwd packages/opencode test -- test/util/rpc.test.ts && bun run --cwd packages/opencode typecheck && bun run lint`.
- **3B — Parent lifecycle/exit:** refactor only parent ownership/liveness/outcomes with injectable failures; no recovery UI. Verify: `bun run --cwd packages/opencode test -- test/util/rpc.test.ts test/cli/tui/thread.test.ts && bun run --cwd packages/opencode typecheck && bun run lint`.
- **4A — Bootstrap state:** split critical/optional, move catalog optional, settle background work, preserve configured-provider/default-model options, route gates, and typed blocked state; add focused cases to `packages/tui/test/cli/cmd/tui/provider-options.test.ts`; no controller/actions/exits. Verify: `bun run --cwd packages/tui test -- test/context/aggregate-failures.test.ts test/cli/cmd/tui/provider-options.test.ts test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/sync-undefined-messages.test.tsx test/cli/tui/sync-v2.test.tsx && bun run --cwd packages/tui typecheck && bun run lint`.
- **4B — Bootstrap authority:** add workspace/attempt generations, subscribe-once full buffering, abort/stale rejection, and cleanup; do not claim watermarks. Verify: `bun run --cwd packages/tui test -- test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/sync-live-hydration.test.tsx test/cli/cmd/tui/sync-generations.test.tsx && bun run --cwd packages/tui typecheck && bun run lint`.
- **5 — Async theme:** remove only the render wait; add lifecycle/preference authority, atomic persistence, bounded reconciliation, and focus/input tests. Verify: `bun run --cwd packages/tui test -- test/app-lifecycle.test.tsx test/theme.test.ts test/theme-startup.test.tsx && bun run --cwd packages/tui typecheck && bun run lint && bun run dev:build`; then run **Post-Slice-5 Pre-Shell Candidate And Aggregate Gate** only.
- **6A — Honest shell:** add the reactive controller and independent same-tree shell; preserve plugin gate; no prompt/recovery changes. Verify: `bun run --cwd packages/tui test -- test/app-lifecycle.test.tsx test/startup-state.test.tsx test/plugin/runtime.test.ts && bun run --cwd packages/tui typecheck && bun run lint && bun run dev:build`; then run **Post-Slice-6A Shell Candidate And Aggregate Gate** only.
- **6B — Prompt/markers:** allow editing, block/describe submit, relocate the Slice 1B prompt/critical/theme/input markers to their real new boundaries, retag them with active workspace/attempt generations, remove their generation-0 emitters, and prove probe/focus/text lifecycle without duplicates; no recovery/exits. Verify: `bun run --cwd packages/tui test -- test/startup-state.test.tsx test/cli/tui/prompt-submit-race.test.ts test/app-lifecycle.test.tsx && bun run --cwd packages/tui typecheck && bun run lint && bun run dev:build`; then run **Full Candidate Comparisons And Aggregate Gate** and the one-time **Post-Slice-6B Bootstrap Decision**.
- **6C — Recovery/liveness/exits:** connect controller, bootstrap/liveness, Retry/Quit, generations, edits, outcomes, and cleanup. Verify: `bun run --cwd packages/tui test -- test/startup-state.test.tsx test/cli/cmd/tui/sync.test.tsx test/app-lifecycle.test.tsx && bun run --cwd packages/opencode test -- test/cli/tui/thread.test.ts && bun run --cwd packages/tui typecheck && bun run --cwd packages/opencode typecheck && bun run lint && bun run dev:build`; then run the full candidate gate, not baseline/decision.
- **7A — Ordered watermarks (`implement` only):** first verify the exact durable decision and sidecar installed by **Post-Slice-6B Bootstrap Decision**; sequence every proposed field without client changes. Verify: `shasum -a 256 -c spikes/tui-startup-performance/bootstrap-consolidation-implement-decision.json.sha256 && bun run --cwd packages/opencode test -- test/event/event-sequence.test.ts && bun run --cwd packages/opencode typecheck && bun run lint`.
- **7B — Server contract (`implement` only):** first repeat the durable decision/sidecar verification from 7A; add endpoint/envelopes/pre-read watermark/concurrent reads/generated SDK; no adoption. Verify: `shasum -a 256 -c spikes/tui-startup-performance/bootstrap-consolidation-implement-decision.json.sha256 && bun run --cwd packages/opencode test -- test/event/event-sequence.test.ts test/server/httpapi-sync.test.ts && bun run --cwd packages/opencode typecheck && bun run check:generated && bun run check:packages && bun run lint`.
- **8 — Adopt contract (`implement` only):** first repeat the durable decision/sidecar verification from 7A; prove equivalence, switch critical calls, batch/replay by watermark/generations, retain catalog/transport parity. Verify: `shasum -a 256 -c spikes/tui-startup-performance/bootstrap-consolidation-implement-decision.json.sha256 && bun run --cwd packages/opencode test -- test/server/httpapi-sync.test.ts && bun run --cwd packages/opencode typecheck && bun run --cwd packages/tui test -- test/cli/cmd/tui/sync.test.tsx test/cli/cmd/tui/sync-live-hydration.test.tsx test/cli/cmd/tui/sync-undefined-messages.test.tsx && bun run --cwd packages/tui typecheck && bun run check:generated && bun run check:packages && bun run lint && bun run dev:build`; then run the full gate and **Slice 8 Adoption Gate**.
- **9 — One measured deferral per PR:** choose the highest remaining pre-prompt phase and name one removed edge plus unchanged contract. For plugin/import deferral verify: `bun run --cwd packages/opencode test -- test/cli/tui/thread.test.ts test/cli/tui/plugin-loader.test.ts test/cli/tui/plugin-loader-pure.test.ts test/cli/tui/plugin-lifecycle.test.ts test/cli/tui/plugin-toggle.test.ts && bun run --cwd packages/opencode typecheck && bun run --cwd packages/tui test -- test/plugin/runtime.test.ts test/app-lifecycle.test.tsx && bun run --cwd packages/tui typecheck && bun run lint && bun run dev:build`. Auto-update-only substitutes its focused new test for the plugin-loader set but retains both typechecks, lint, build, full gate, and **Slice 9 Delta Gate**.

## Performance Gate Commands

All blocks run on the same otherwise idle machine, fail closed, use exclusive outputs, immutable hash-checked artifacts, isolated equivalent states, and balanced seed `20260728`. Dirty sanitized diagnostics never pass. Run blocks exactly from repository root; launcher timing stays separate and diagnostic.

- `preserve` refuses dirty gate builds, existing outputs, non-unique/non-executable binaries, or identity changes; `compare` requires positive equal arm counts, stores its balanced order before launch, and never shares writable state.
- `pre-shell-v1`, `shell-v1`, and `full-v1` enforce the capabilities, cohorts, lifecycle checks, absolute targets, relative p95 limits, and no-response gaps in **Metrics And Provisional Exit Targets**; missing/extra/duplicate cohorts, mismatched identity/state/schedule, invalid samples, and unavailable required fields exit nonzero.
- `single-deferral-v1` requires matching candidate scenario/state, passed before/after full gates with matching input hashes and immutable baseline, and the predecessor candidate at the after artifact's preserved PR base; the named allowlisted phase must strictly lower its median or move after `interactive_ms` in every after sample when it did not before.
- `core-bootstrap-v1` retains the largest allowlisted dispatch duration per sample and returns `implement` only at median removable dispatch >=50 ms or when the exact median across candidate-arm per-sample schema-proven `removable_duplicate_bytes` is >=64 KiB (65,536 bytes), using a twice-median threshold of 131,072 without rounding; total bytes and stringify/parse time never qualify. Adoption requires that decision's provenance, one strictly fewer core request ending at exactly one, a strictly smaller exact twice-median of per-sample allowlisted encoded response-envelope byte totals, valid equal positive sample counts, matching scenario/mode/theme/state/schedule/allowlist, and a passed matching full gate; any missing or malformed comparison evidence exits nonzero.

### Baseline Preservation

Run once on the clean reviewed Slice 2F commit before behavior changes:

```sh
set -eu
git diff --quiet
git diff --cached --quiet
test -z "$(git ls-files --others --exclude-standard)"
bun run dev:build
set -- packages/opencode/dist/oc2-*/bin/oc2
test "$#" -eq 1
test -x "$1"
mkdir -p tmp/tui-startup-artifacts tmp/pycache
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py preserve \
  --name baseline-pre-behavior --binary "$1" --build-command 'bun run dev:build' \
  --shell-capability unavailable --output tmp/tui-startup-artifacts/baseline
```

### Post-Slice-5 Pre-Shell Candidate And Aggregate Gate

```sh
set -eu
git diff --quiet
git diff --cached --quiet
test -z "$(git ls-files --others --exclude-standard)"
bun run dev:build
set -- packages/opencode/dist/oc2-*/bin/oc2
test "$#" -eq 1
test -x "$1"
mkdir -p tmp/tui-startup-artifacts tmp/tui-startup-results tmp/pycache
STAGE_ID="pre-shell-$(git rev-parse --short=12 HEAD)"
CANDIDATE_ARTIFACT="tmp/tui-startup-artifacts/$STAGE_ID"
RESULT_DIR="tmp/tui-startup-results/$STAGE_ID"
mkdir -p "$RESULT_DIR"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py preserve \
  --name "$STAGE_ID" --binary "$1" --build-command 'bun run dev:build' \
  --shell-capability unavailable --output "$CANDIDATE_ARTIFACT"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label pre-shell-dark --samples-per-arm 20 --mode warm --theme-response dark --metric-set pre-shell --schedule-seed 20260728 --interaction-probe \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/dark.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label pre-shell-light --samples-per-arm 20 --mode warm --theme-response light --metric-set pre-shell --schedule-seed 20260728 --interaction-probe \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/light.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label pre-shell-none --samples-per-arm 20 --mode warm --theme-response none --metric-set pre-shell --schedule-seed 20260728 --interaction-probe \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/none.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label pre-shell-malformed --samples-per-arm 3 --mode cold-like --theme-response malformed --metric-set pre-shell --schedule-seed 20260728 --interaction-probe \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/malformed.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label pre-shell-late --samples-per-arm 3 --mode cold-like --theme-response late:1250 --metric-set pre-shell --schedule-seed 20260728 --interaction-probe \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/late.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py gate \
  --policy pre-shell-v1 --dark "$RESULT_DIR/dark.jsonl" --light "$RESULT_DIR/light.jsonl" --none "$RESULT_DIR/none.jsonl" \
  --malformed "$RESULT_DIR/malformed.jsonl" --late "$RESULT_DIR/late.jsonl" --output "$RESULT_DIR/gate.json"
```

### Post-Slice-6A Shell Candidate And Aggregate Gate

```sh
set -eu
git diff --quiet
git diff --cached --quiet
test -z "$(git ls-files --others --exclude-standard)"
bun run dev:build
set -- packages/opencode/dist/oc2-*/bin/oc2
test "$#" -eq 1
test -x "$1"
mkdir -p tmp/tui-startup-artifacts tmp/tui-startup-results tmp/pycache
STAGE_ID="shell-$(git rev-parse --short=12 HEAD)"
CANDIDATE_ARTIFACT="tmp/tui-startup-artifacts/$STAGE_ID"
RESULT_DIR="tmp/tui-startup-results/$STAGE_ID"
mkdir -p "$RESULT_DIR"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py preserve \
  --name "$STAGE_ID" --binary "$1" --build-command 'bun run dev:build' --shell-capability required --output "$CANDIDATE_ARTIFACT"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label shell-dark --samples-per-arm 20 --mode warm --theme-response dark --metric-set shell --schedule-seed 20260728 \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/dark.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label shell-light --samples-per-arm 20 --mode warm --theme-response light --metric-set shell --schedule-seed 20260728 \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/light.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label shell-none --samples-per-arm 20 --mode warm --theme-response none --metric-set shell --schedule-seed 20260728 \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/none.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py gate \
  --policy shell-v1 --dark "$RESULT_DIR/dark.jsonl" --light "$RESULT_DIR/light.jsonl" --none "$RESULT_DIR/none.jsonl" --output "$RESULT_DIR/gate.json"
```

### Full Candidate Comparisons And Aggregate Gate

Run after 6B, 6C, 8, and each Slice 9 candidate; it preserves only the current clean candidate and reuses the immutable baseline.

```sh
set -eu
git diff --quiet
git diff --cached --quiet
test -z "$(git ls-files --others --exclude-standard)"
bun run dev:build
set -- packages/opencode/dist/oc2-*/bin/oc2
test "$#" -eq 1
test -x "$1"
mkdir -p tmp/tui-startup-artifacts tmp/tui-startup-results tmp/pycache
CANDIDATE_ID="$(git rev-parse --short=12 HEAD)"
CANDIDATE_ARTIFACT="tmp/tui-startup-artifacts/candidate-$CANDIDATE_ID"
RESULT_DIR="tmp/tui-startup-results/$CANDIDATE_ID"
mkdir -p "$RESULT_DIR"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py preserve \
  --name "candidate-$CANDIDATE_ID" --binary "$1" --build-command 'bun run dev:build' --shell-capability required --output "$CANDIDATE_ARTIFACT"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label compiled-dark-warm --samples-per-arm 20 --mode warm --theme-response dark --metric-set full --schedule-seed 20260728 --interaction-probe \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/compiled-dark-warm-ab.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label compiled-light-warm --samples-per-arm 20 --mode warm --theme-response light --metric-set full --schedule-seed 20260728 --interaction-probe \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/compiled-light-warm-ab.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label compiled-no-theme-warm --samples-per-arm 20 --mode warm --theme-response none --metric-set full --schedule-seed 20260728 --interaction-probe \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/compiled-no-theme-warm-ab.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label compiled-dark-cold-like --samples-per-arm 15 --mode cold-like --theme-response dark --metric-set full --schedule-seed 20260728 --interaction-probe \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/compiled-dark-cold-like-ab.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label compiled-malformed-correctness --samples-per-arm 3 --mode cold-like --theme-response malformed --metric-set full --schedule-seed 20260728 --interaction-probe \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/compiled-malformed-ab.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py compare \
  --label compiled-late-valid-correctness --samples-per-arm 3 --mode cold-like --theme-response late:1250 --metric-set full --schedule-seed 20260728 --interaction-probe \
  --baseline-artifact tmp/tui-startup-artifacts/baseline --candidate-artifact "$CANDIDATE_ARTIFACT" --output "$RESULT_DIR/compiled-late-valid-ab.jsonl" -- --pure "$PWD"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py gate \
  --policy full-v1 --dark "$RESULT_DIR/compiled-dark-warm-ab.jsonl" --light "$RESULT_DIR/compiled-light-warm-ab.jsonl" \
  --none "$RESULT_DIR/compiled-no-theme-warm-ab.jsonl" --cold "$RESULT_DIR/compiled-dark-cold-like-ab.jsonl" \
  --malformed "$RESULT_DIR/compiled-malformed-ab.jsonl" --late "$RESULT_DIR/compiled-late-valid-ab.jsonl" --output "$RESULT_DIR/gate.json"
```

The three warm and cold-like comparisons are merge gates; malformed/late are correctness cohorts. `full-v1` requires every target, <=5% matched p95 regression, <=100 ms no-response gaps, lifecycle/oracle checks, hashes/schedule/state, and zero invalid samples. Only baseline `shell_ms` declared unavailable is exempt.

### Post-Slice-6B Bootstrap Decision

Run once immediately after the 6B full gate in the same shell:

```sh
set -eu
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py decide-bootstrap \
  --policy core-bootstrap-v1 --candidate-artifact "$CANDIDATE_ARTIFACT" --gate-report "$RESULT_DIR/gate.json" \
  --input "$RESULT_DIR/compiled-dark-warm-ab.jsonl" --output "$RESULT_DIR/bootstrap-consolidation-decision.json"
DECISION="$(PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 -c \
  'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["decision"])' \
  "$RESULT_DIR/bootstrap-consolidation-decision.json")"
test "$DECISION" = implement || test "$DECISION" = skip
```

For `implement`, a fresh read-only reviewer must first approve the decision's versioned privacy allowlist. Then preserve the exact bytes and revalidate every candidate/artifact/gate/input hash link with the Slice 2F subcommand below. The subcommand refuses collisions, non-`implement` or non-allowlisted content, failed/mismatched provenance, and non-exclusive sidecars; the committed relative-path SHA-256 sidecar, embedded input hashes, and validation provenance are authoritative rather than filesystem write permissions.

```sh
set -eu
test "$DECISION" = implement
: "${PRIVACY_REVIEW_APPROVED:?set to yes only after fresh read-only privacy approval}"
test "$PRIVACY_REVIEW_APPROVED" = yes
IMPLEMENT_DECISION="spikes/tui-startup-performance/bootstrap-consolidation-implement-decision.json"
IMPLEMENT_SHA256="$IMPLEMENT_DECISION.sha256"
test ! -e "$IMPLEMENT_DECISION"
test ! -e "$IMPLEMENT_SHA256"
mkdir -p spikes/tui-startup-performance
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py preserve-bootstrap-decision \
  --policy core-bootstrap-v1 --expect implement --privacy-review-approved \
  --source "$RESULT_DIR/bootstrap-consolidation-decision.json" \
  --candidate-artifact "$CANDIDATE_ARTIFACT" --gate-report "$RESULT_DIR/gate.json" \
  --input "$RESULT_DIR/compiled-dark-warm-ab.jsonl" \
  --output "$IMPLEMENT_DECISION" --sha256-output "$IMPLEMENT_SHA256"
cmp "$RESULT_DIR/bootstrap-consolidation-decision.json" "$IMPLEMENT_DECISION"
shasum -a 256 -c "$IMPLEMENT_SHA256"
BOOTSTRAP_DECISION="$IMPLEMENT_DECISION"
```

Only that preserved `BOOTSTRAP_DECISION`, committed with its sidecar, unlocks 7A-8; each slice rechecks it. For `skip`, privacy-review and install the no-op artifact exactly:

```sh
set -eu
test "$DECISION" = skip
NOOP_ARTIFACT="spikes/tui-startup-performance/bootstrap-consolidation-decision.json"
test ! -e "$NOOP_ARTIFACT"
mkdir -p spikes/tui-startup-performance
cp "$RESULT_DIR/bootstrap-consolidation-decision.json" "$NOOP_ARTIFACT"
cmp "$RESULT_DIR/bootstrap-consolidation-decision.json" "$NOOP_ARTIFACT"
```

### Slice 8 Adoption Gate

Run after the Slice 8 full gate in the same shell; reuse the baseline and preserved 6B `implement` decision:

```sh
set -eu
BOOTSTRAP_DECISION="spikes/tui-startup-performance/bootstrap-consolidation-implement-decision.json"
shasum -a 256 -c "$BOOTSTRAP_DECISION.sha256"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py gate-bootstrap-adoption \
  --policy core-bootstrap-adoption-v1 --decision-artifact "$BOOTSTRAP_DECISION" \
  --after "$RESULT_DIR/compiled-dark-warm-ab.jsonl" --full-gate "$RESULT_DIR/gate.json" \
  --output "$RESULT_DIR/bootstrap-adoption-gate.json"
```

### Slice 9 Delta Gate

Run after every Slice 9 full gate against the immediately preceding accepted candidate:

```sh
set -eu
: "${DEFERRAL_BEFORE:?set to the immediately preceding accepted dark-warm A/B JSONL}"
: "${DEFERRAL_BEFORE_GATE:?set to the predecessor passed full-v1 report}"
: "${DEFERRAL_PHASE:?set to the single allowlisted phase named by this slice}"
PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" python3 perf/tui-startup/tui_benchmark.py gate-phase-delta \
  --policy single-deferral-v1 --phase "$DEFERRAL_PHASE" --before "$DEFERRAL_BEFORE" \
  --before-full-gate "$DEFERRAL_BEFORE_GATE" --after "$RESULT_DIR/compiled-dark-warm-ab.jsonl" \
  --full-gate "$RESULT_DIR/gate.json" --output "$RESULT_DIR/phase-delta-gate.json"
```

### Launcher Diagnostic And Final Checks

After the direct gate, launcher-inclusive timing is diagnostic only:

```sh
set -eu
RESULT_DIR="tmp/tui-startup-results/$(git rev-parse --short=12 HEAD)"
test -d "$RESULT_DIR"
set -- packages/opencode/dist/oc2-*/bin/oc2
test "$#" -eq 1
test -x "$1"
test -x packages/opencode/bin/oc2
OC2_BIN_PATH="$1" PYTHONPYCACHEPREFIX="$PWD/tmp/pycache" \
  python3 perf/tui-startup/tui_benchmark.py \
  --label node-launcher-dark-terminal --samples 20 --mode warm --theme-response dark \
  --output "$RESULT_DIR/node-launcher-dark-warm.jsonl" -- packages/opencode/bin/oc2 --pure "$PWD"
```

Before merge run exactly:

```sh
bun run --cwd packages/core test
bun run --cwd packages/core typecheck
bun run --cwd packages/tui test
bun run --cwd packages/tui typecheck
bun run --cwd packages/opencode test
bun run --cwd packages/opencode typecheck
bun run lint
bun run check:generated
bun run check:packages
bun run dev:build
```

## Future Work

- Establish independent baselines/targets for continuation/session/prompt paths, external attach, non-pure plugins, large repositories, and custom themes.
- Cover real terminals across macOS/Linux/Windows, tmux/screen, SSH, architectures, and responsive light/dark behavior.
- Add load/thermal/power metadata and predeclared confidence/statistical reporting after the harness stabilizes.
- Obtain compiled-symbol/source-map CPU profiles before optimizing JavaScript frames; keep source/dev profiles out of production claims.
- Investigate structured-clone/binary worker RPC only if post-consolidation telemetry proves JSON material.
- Consider cached terminal mode only with correctness/invalidation/cross-terminal design, not merely to hit shell targets.

## Open Questions

1. **Edit before critical ready?** Default **yes**: preserve edits, disable submit with an explicit message, and use post-critical/post-theme token observation/removal for interactive readiness.
2. **Internal-only bootstrap RPC?** Default **no**: use one HTTP/SDK contract for transport parity; optimize worker encoding separately only if measured.
3. **Plugins after interactive?** Default **none** except one separately audited/allowlisted internal plugin per PR; external/unknown remain sequential and pre-ready.
4. **Late terminal result overrides fallback?** Default **yes when valid and unlocked**, atomically without remount; explicit locks win, malformed/missing results retain fallback.
