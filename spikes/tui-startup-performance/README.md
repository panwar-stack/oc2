# TUI Startup Performance Audit

Status: completed  
Audit date: 2026-07-27 (-0700; final measurements ended 2026-07-27 23:06)  
Scope: process launch through the first drawn, visible home prompt in pure mode  
Baseline commit: `19b23ef636535ecf2c0b572ad2539e166dcfc72d`

## Executive Summary

The authoritative compiled, warm, responsive-dark-terminal baseline reached the prompt in a median **2080.84 ms**
(n=20). Its median first byte arrived at **733.51 ms**, leaving about **1347.33 ms** between first output and the ready
read. A nonresponsive terminal increased median readiness to **3023.80 ms**, a derived **+942.95 ms (+45.3%)** while
adding only **50.75 ms** at first byte. That localization and the code's blocking 1000 ms terminal-theme wait make the
theme wait the strongest measured optimization target, although the benchmark does not by itself prove causation.

Fresh per-sample application state ("cold-like") raised median compiled readiness by **273.77 ms (+13.2%)**, with a
much larger tail. Running the source/dev command raised median readiness by **1047.26 ms (+50.3%)** and median first
byte by **1226.30 ms (+167.2%)**. Source CPU profiles were dominated by native and development transform/loader
samples, so they are useful evidence that source mode differs from the compiled path, not a production hotspot map.

The audit changed no product behavior. The next safe steps are to add startup phase telemetry, make terminal-theme
detection nonblocking or shorter with a visually safe fallback, and obtain compiled-symbol/source-map-capable
profiles before micro-optimizing source frames.

## Scope And Questions

The audit asked:

1. What is process-to-useful-prompt startup time for a compiled binary in controlled warm and cold-like state?
2. Does terminal color-query behavior materially affect readiness?
3. How different is the source/dev path from the compiled path?
4. Which synchronous or awaited phases lie on the code path before the home prompt?
5. What can the available CPU and native profiles establish, and what remains a hypothesis?

The primary metric is `ready_ms`: monotonic wall time from process creation until one cumulative PTY read has seen
both the internal TTFD diagnostic and `Ask anything...`. Secondary metrics are `first_byte_ms`, application-reported
`ttfd_ms`, spread, timeout state, and bytes observed by readiness. This definition tests a painted prompt; it does not
prove backend sync/model readiness or measure the first accepted keystroke.

## Audit Metadata

| Item                         | Observed value                                              | Evidence status                                                                   |
| ---------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Source checkout              | `main` at `19b23ef636535ecf2c0b572ad2539e166dcfc72d`        | Observed during audit; commit subject `test(provider): isolate instance disposal` |
| Compiled executable          | ARM64 `oc2-darwin-arm64`, version `0.0.0-main-202607280544` | Recovered from a debug cast only                                                  |
| Binary hash, size, build log | Not preserved                                               | Gap: the binary can no longer be tied cryptographically to the source commit      |
| OS                           | macOS 26.5.2, build 25F84, arm64                            | Observed host environment                                                         |
| Runtime                      | Bun 1.3.14                                                  | Observed and repository-pinned                                                    |
| Harness runtime              | Python 3.9.6                                                | Observed                                                                          |
| Terminal                     | Harness-controlled `xterm-256color`, truecolor, 100x30 PTY  | Established by harness code and run method                                        |
| Machine load                 | Scenarios run serially on an otherwise idle machine         | Execution note; no load trace retained                                            |
| Hardware/power/thermal state | Not embedded in result artifacts                            | Current-host observations are intentionally not presented as proven run metadata  |

The benchmark records themselves omit argv, theme response, timeout, PTY size, environment, revision, binary hash,
and host metadata. The table and method below come from the audit execution notes and preserved tooling, rather than
from self-describing result records. Future harness output should begin with a metadata record.

## Methodology

The final scenarios used the repository's [TUI startup audit tools](../../perf/tui-startup/README.md). They ran
serially on an otherwise idle machine.

- The harness forks each command under a 100-column by 30-row pseudo-terminal and uses a monotonic process wall
  clock.
- Every scenario receives isolated `HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `XDG_CONFIG_HOME` roots.
- `warm` reuses one isolated application-state tree after a recorded but unmeasured seed. `cold-like` creates fresh
  application state for every sample but does not flush OS filesystem/page caches.
- The controlled environment sets `TERM=xterm-256color`, `COLORTERM=truecolor`, `OC2_PURE=1`,
  `OC2_SHOW_TTFD=1`, and disables model fetches, auto-update, mouse handling, terminal-title changes, and project
  config. Other environment variables are inherited.
- A `dark` response emulates replies to OSC 10/11 foreground/background queries. `none` deliberately sends no
  response.
- Readiness requires both `Time to first draw: <milliseconds>ms` and visible text `Ask anything...`. `ready_ms` is
  the time of the PTY read chunk that first contains both markers, not an internal renderer timestamp.
- Each sample records time to first byte, time to readiness, app TTFD, bytes read, and timeout state. Summary records
  contain min, median, mean, p90, p95, max, and sample standard deviation over valid samples.
- All 55 measured samples were valid, none timed out, and all measured and seed records reached 6559 bytes at
  readiness. Warm seeds are preserved in evidence but excluded from n and summary statistics.

These four result streams are the authoritative wall-readiness evidence. Comparisons calculated from their summary
medians are explicitly labeled derived. Source reading, profiles, probes, and casts support localization and
hypotheses but are not substitutes for the repeated benchmark.

## Results

### Scenario Summary

| Scenario                           | Build/path | State             | Terminal response |   n | Median first byte (ms) | Median TTFD (ms) | Median ready (ms) | Ready p95 (ms) |
| ---------------------------------- | ---------- | ----------------- | ----------------- | --: | ---------------------: | ---------------: | ----------------: | -------------: |
| `compiled-dark-terminal` warm      | Compiled   | Reused after seed | Dark OSC 10/11    |  20 |                 733.51 |          2067.14 |           2080.84 |        2396.65 |
| `compiled-dark-terminal` cold-like | Compiled   | Fresh per sample  | Dark OSC 10/11    |  15 |                 807.32 |          2341.58 |           2354.61 |        3888.43 |
| `compiled-no-theme-response` warm  | Compiled   | Reused after seed | No reply          |  10 |                 784.26 |          3010.42 |           3023.80 |        5152.40 |
| `source-dev-dark-terminal` warm    | Source/dev | Reused after seed | Dark OSC 10/11    |  10 |                1959.81 |          3113.18 |           3128.10 |        5562.90 |

### Authoritative Ready Statistics

| Scenario                           | Min (ms) | Median (ms) | Mean (ms) | p90 (ms) | p95 (ms) | Max (ms) | Stdev (ms) |
| ---------------------------------- | -------: | ----------: | --------: | -------: | -------: | -------: | ---------: |
| `compiled-dark-terminal` warm      |  1667.76 |     2080.84 |   2092.97 |  2379.34 |  2396.65 |  2488.51 |     238.10 |
| `compiled-dark-terminal` cold-like |  2000.98 |     2354.61 |   2637.66 |  3862.23 |  3888.43 |  3935.96 |     663.90 |
| `compiled-no-theme-response` warm  |  2821.22 |     3023.80 |   3443.10 |  4638.36 |  5152.40 |  5666.44 |     940.12 |
| `source-dev-dark-terminal` warm    |  2876.39 |     3128.10 |   3777.17 |  5561.94 |  5562.90 |  5563.85 |    1207.86 |

### Authoritative TTFD Statistics

| Scenario                           | Min (ms) | Median (ms) | Mean (ms) | p90 (ms) | p95 (ms) | Max (ms) | Stdev (ms) |
| ---------------------------------- | -------: | ----------: | --------: | -------: | -------: | -------: | ---------: |
| `compiled-dark-terminal` warm      |  1655.90 |     2067.14 |   2077.99 |  2365.89 |  2382.52 |  2474.76 |     237.48 |
| `compiled-dark-terminal` cold-like |  1982.44 |     2341.58 |   2611.56 |  3781.55 |  3864.68 |  3923.16 |     644.86 |
| `compiled-no-theme-response` warm  |  2809.03 |     3010.42 |   3426.73 |  4618.30 |  5124.17 |  5630.03 |     933.23 |
| `source-dev-dark-terminal` warm    |  2860.88 |     3113.18 |   3757.47 |  5514.32 |  5524.42 |  5534.52 |    1199.95 |

### Authoritative First-Byte Statistics

| Scenario                           | Min (ms) | Median (ms) | Mean (ms) | p90 (ms) | p95 (ms) | Max (ms) | Stdev (ms) |
| ---------------------------------- | -------: | ----------: | --------: | -------: | -------: | -------: | ---------: |
| `compiled-dark-terminal` warm      |   633.56 |      733.51 |    745.33 |   839.56 |   884.74 |  1032.14 |      92.40 |
| `compiled-dark-terminal` cold-like |   699.39 |      807.32 |    939.46 |  1262.58 |  1569.15 |  2124.60 |     370.00 |
| `compiled-no-theme-response` warm  |   717.53 |      784.26 |    865.76 |  1028.81 |  1184.95 |  1341.09 |     190.70 |
| `source-dev-dark-terminal` warm    |  1809.23 |     1959.81 |   2501.50 |  4194.96 |  4198.64 |  4202.33 |     988.96 |

### Warm Seeds

| Scenario                          | First byte (ms) | TTFD (ms) | Ready (ms) | Included in n? |
| --------------------------------- | --------------: | --------: | ---------: | -------------- |
| `compiled-dark-terminal` warm     |          700.64 |   1970.86 |    1983.48 | No             |
| `compiled-no-theme-response` warm |         1266.58 |   3824.00 |    3970.91 | No             |
| `source-dev-dark-terminal` warm   |         3160.96 |   7056.62 |    7071.20 | No             |

### Derived Comparisons

These values are arithmetic comparisons of authoritative medians, not separately measured paired effects.

| Comparison                           | Ready delta | Ready relative delta |      First-byte delta | Interpretation                                                                                            |
| ------------------------------------ | ----------: | -------------------: | --------------------: | --------------------------------------------------------------------------------------------------------- |
| Compiled cold-like vs compiled warm  |  +273.77 ms |               +13.2% |             +73.81 ms | Fresh application state has a modest median penalty but a much larger tail; OS caches remain warm/unknown |
| No theme response vs responsive dark |  +942.95 ms |               +45.3% |             +50.75 ms | Most of the measured penalty occurs after first output and is close to the fixed theme wait               |
| Source/dev vs compiled warm          | +1047.26 ms |               +50.3% | +1226.30 ms (+167.2%) | Development transforms/loading make this unsuitable as a compiled-performance proxy                       |

Across scenarios, median `ready_ms - ttfd_ms` is about 13-15 ms. That shows TTFD was close to the prompt-bearing PTY
read in these runs; it does not establish that TTFD alone is a useful-readiness marker in other routes or terminal
conditions.

## Startup Timeline

The following is code-path analysis at the baseline commit, not measured phase timing. Line ranges are anchors for
the audited revision and may move.

1. **CLI entry and command selection.** `packages/opencode/src/index.ts:20-43,74-87,121-200` initializes the CLI and
   lazily selects the default TUI command.
2. **TUI handler setup.** `packages/opencode/src/cli/cmd/tui.ts:114-184` imports TUI config, resolves/chdirs into the
   project, starts the worker, creates RPC, reads piped input, and awaits config. `:186-205` chooses internal RPC or
   external HTTP transport; `:207-253` validates session state, dynamically imports Effect/the TUI layer/plugin
   runtime, and awaits render lifecycle completion.
3. **Pre-render config.** `packages/opencode/src/config/tui.ts:90-276` discovers and loads TUI configuration;
   `:278-325` supplies the runtime/get path.
4. **Worker and RPC.** `packages/opencode/src/cli/tui/worker.ts:14-25,39-106` lazily creates the server and implements
   worker RPC. Serialization crosses `packages/opencode/src/util/rpc.ts:5-63`.
5. **Renderer and terminal theme.** `packages/tui/src/app.tsx:161-215` creates the renderer. Palette prewarming and
   blocking `(await renderer.waitForThemeMode(1000)) ?? "dark"` occur at `:209-213`, before render at `:215`.
6. **Provider tree and initial sync.** `packages/tui/src/app.tsx:216-305` builds providers.
   `packages/tui/src/context/sdk.tsx:11-156` establishes SDK access. `packages/tui/src/context/sync.tsx:779-882`
   performs the parallel but blocking config/providers/agents/project bootstrap RPC group; readiness is exposed at
   `:895-898`.
7. **Plugin prompt gate.** `packages/tui/src/app.tsx:374-387` sets plugin-ready only after `pluginHost.start()`
   settles. Host initialization and load are in `packages/opencode/src/plugin/tui/runtime.ts:1025-1047,1092-1165`;
   `:1124-1160` resolves flags/internal/external plugins and activates enabled plugins sequentially for deterministic
   ordering. Blanket parallel activation is therefore unsafe.
8. **Visible home prompt.** The TTFD/visual gate is `packages/tui/src/app.tsx:1085-1110`, and the home route is
   `packages/tui/src/routes/home.tsx:70-94`. `FAST_BOOT` changes a skip flag at `app.tsx:233-237` and hides the
   loading component at `:1108-1110`; loading timers are in `packages/tui/src/component/startup-loading.tsx:5-63`.
9. **Adjacent asynchronous work.** Theme discovery/background palette work is in
   `packages/tui/src/context/theme.tsx:37-60,102-189`; KV state read is in
   `packages/tui/src/context/kv.tsx:10-64`.

Because the benchmark has only first-byte, TTFD, and ready markers, it cannot assign wall time to the intermediate
steps above. The timeline identifies where to instrument; it is not a flame chart.

## CPU Profile Evidence

The share-safe [CPU profile summary](./evidence/cpu-profile-summary.txt) was regenerated with
`perf/tui-startup/analyze_cpu_profile.py` from two preserved raw source/dev profiles. The raw profiles and their Bun
Markdown reports are not committed because they are multi-megabyte, contain absolute private paths, and cover source
transforms plus Ctrl-C shutdown.

| Source profile | Duration | Interval | Samples | Native leaf | Five Babel leaf buckets | `product:tui` leaf |
| -------------- | -------: | -------: | ------: | ----------: | ----------------------: | -----------------: |
| Controlled     |  5265 ms |     1 ms |    2233 |      53.20% |                  32.33% |              2.42% |
| Pure           | 27290 ms |   500 us |    6339 |      52.85% |                  31.71% |              0.84% |

Filtering samples with async deltas above 100 ms omitted only 3/2233 controlled and 10/6339 pure samples and did not
materially change leading hit-count buckets. However, Bun's generated Markdown attributed 1.08 s and 10.84 s of
self-time to individual leaves; those values align with long async deltas rather than reliable CPU residency. The
audit therefore uses analyzer hit counts and makes no causal self-time claim.

The compiled executable ignored `BUN_OPTIONS=--cpu-prof`, so no compiled JavaScript/source profile exists. Two
exploratory macOS 1 ms native samples were preserved outside Git, but the compiled sample was mostly stripped
`???`/native waits. They reported 541.2 MiB compiled and 264.7 MiB source footprint; the exact sample launch command
was not preserved, so even those footprint values are exploratory rather than headline measurements.

## Findings

### 1. High Confidence: A Nonresponsive Terminal Adds About One Second After First Output

**Observation:** The no-response warm median was 942.95 ms slower than responsive dark, while its first byte was only
50.75 ms slower. `packages/tui/src/app.tsx:209-213` awaits terminal theme mode for up to 1000 ms before render.

**Evidence class:** repeated authoritative measurements plus source-path correlation.  
**Caveat:** scenarios were separate serial batches rather than randomized/interleaved A/B trials, so exact causal
effect and visual behavior still need a targeted experiment.

### 2. High Confidence: Most Compiled Warm Time Is Not Explained by Process-to-First-Byte Alone

**Observation:** The compiled warm median is 733.51 ms to first byte and 2080.84 ms to ready, leaving a derived
1347.33 ms post-first-byte interval. Several awaited stages occur before the prompt, but the audit lacks per-stage
markers.

**Evidence class:** repeated authoritative measurements and source-path inventory.  
**Gap:** no phase can be assigned a duration other than the strongly localized terminal no-response comparison.

### 3. High Confidence: Source Profiles Are Not Production Hotspot Evidence

**Observation:** Native leaf samples account for about 53%, while the five reported Babel buckets account for 32.33%
and 31.71%. Source/dev first-byte median is 167.2% slower than compiled.

**Evidence class:** source benchmark plus source/dev CPU sample counts.  
**Impact:** optimizing individual source frames from these profiles risks targeting development-only transform/load
cost instead of compiled startup.

### 4. Medium Confidence: Internal Plugin Activation Is On The Prompt Gate

**Observation:** The home prompt waits for `pluginHost.start()`, and an exploratory debug cast logged 12 internal
plugin activations before TTFD/prompt. Enabled activation is intentionally sequential to preserve deterministic
ordering.

**Evidence class:** code-path analysis plus one exploratory cast.  
**Caveat:** the audit did not repeatedly benchmark lazy or post-prompt activation, and changing order may alter
semantics.

### 5. Medium Confidence: Fresh Application State Increases Tail Risk More Than Median

**Observation:** Cold-like median readiness is 273.77 ms slower, but its p95 is 1491.78 ms above the warm p95 and its
standard deviation is 663.90 ms versus 238.10 ms.

**Evidence class:** repeated authoritative measurements.  
**Caveat:** cold-like does not clear OS caches, batches were not interleaved, and two slow first-byte samples drive
part of the tail.

### 6. Low Confidence: External Transport And `FAST_BOOT` May Change Startup

Single casts showed TTFD values of 3406.18 ms for `--port 40991` and 770.06 ms for a `FAST_BOOT` debug path. Casts
are cumulative terminal captures rather than statistical wall-readiness samples. `FAST_BOOT` can advance a blank or
early draw and hide loading UI, so it is not evidence of a threefold useful-startup win.

## Recommendations

1. **Instrument the critical path before broad changes.** Emit monotonic markers for entry, command import, config,
   worker-ready, transport-ready, renderer creation, theme wait, first render, plugin-ready, sync-ready, and prompt
   mount. Include worker-side spans and a metadata record in benchmark output.
2. **Test a nonblocking theme fallback.** Render immediately with a safe default, then reconcile a late response; or
   shorten/cache the timeout. Repeatedly test responsive dark/light, system-theme transitions, and wrong-color/flash
   risks. This recommendation has the strongest direct measurement support.
3. **Obtain compiled-symbol/source-map-capable profiling.** Do this before source-frame micro-optimization. Retain
   command, binary hash, build log, revision, profile interval, and sanitized analyzer output.
4. **Investigate plugin deferral narrowly.** Identify internal plugins whose activation can safely occur after prompt
   mount, preserve deterministic ordering and error behavior, and benchmark each change. Do not parallelize all
   activation by default.
5. **Use interleaved A/B batches for cold-state and future changes.** Randomize scenario order, record machine load
   and power/thermal state, preserve all samples, and report confidence intervals or another predeclared comparison.
6. **Expand scenario coverage only after improving metadata.** Add real terminals and multiplexers, responsive light,
   Linux/Intel/Windows/SSH, larger repositories/configs, external plugins, session continuation, and external
   transport.

Recommendations 1-3 follow measured gaps or observed differences. Recommendation 4 is a code-path hypothesis.
Recommendations 5-6 improve inference and coverage rather than asserting a current product bottleneck.

## Reproduction

Run from the repository root. These are the exact final benchmark command shapes preserved in the tooling README.
The historical compiled binary is no longer available, so rebuilding reproduces the method against a new artifact,
not the exact audited binary.

### Build And Prepare

```sh
bun run dev:build
OC2_BIN="${OC2_BIN:-$(printf '%s\n' packages/opencode/dist/oc2-*/bin/oc2)}"
test -x "$OC2_BIN"
mkdir -p tmp/tui-startup-results
```

Run scenarios serially on an otherwise idle machine:

```sh
# Compiled, warm state, responsive dark terminal: one seed plus n=20.
python3 perf/tui-startup/tui_benchmark.py \
  --label compiled-dark-terminal --samples 20 --mode warm --theme-response dark \
  --output tmp/tui-startup-results/compiled-dark-warm.jsonl \
  -- "$OC2_BIN" --pure "$PWD"

# Compiled, fresh HOME/XDG state for every sample, responsive dark terminal: n=15.
python3 perf/tui-startup/tui_benchmark.py \
  --label compiled-dark-terminal --samples 15 --mode cold-like --theme-response dark \
  --output tmp/tui-startup-results/compiled-dark-cold-like.jsonl \
  -- "$OC2_BIN" --pure "$PWD"

# Compiled, warm state, no response to terminal color queries: one seed plus n=10.
python3 perf/tui-startup/tui_benchmark.py \
  --label compiled-no-theme-response --samples 10 --mode warm --theme-response none \
  --output tmp/tui-startup-results/compiled-no-theme-warm.jsonl \
  -- "$OC2_BIN" --pure "$PWD"

# Source/dev command body, warm state, responsive dark terminal: one seed plus n=10.
python3 perf/tui-startup/tui_benchmark.py \
  --label source-dev-dark-terminal --samples 10 --mode warm --timeout 20 --theme-response dark \
  --output tmp/tui-startup-results/source-dev-dark-warm.jsonl \
  -- bun run --cwd packages/opencode --conditions=browser src/index.ts --pure "$PWD"
```

### Raw Probe

The probe is diagnostic and not a replacement for repeated readiness measurements. Captures can contain terminal
output or debug text; review them before sharing.

```sh
python3 perf/tui-startup/tui_probe.py \
  --raw tmp/tui-startup-results/probe.raw \
  -- "$OC2_BIN" --pure "$PWD" \
  > tmp/tui-startup-results/probe.txt

xxd -g 1 -l 320 tmp/tui-startup-results/probe.raw
```

The preserved no-response probe was 7544 bytes with SHA-256
`e64b205db606c5a1d3491db74ac01619e6dc9064035a7c47da5bd3add42aae21`. It contained one OSC 10 query, one OSC
11 query, TTFD 3291.13 ms, and the prompt. It sent no query reply and is one exploratory capture, not a distribution.
The raw bytes are intentionally not tracked here.

### CPU Profile

Bun profiling worked on the source command. Stop the TUI with Ctrl-C after it reaches the prompt.

```sh
mkdir -p tmp/tui-startup-results/cpu
bun --cpu-prof --cpu-prof-md --cpu-prof-interval=1000 \
  --cpu-prof-dir="$PWD/tmp/tui-startup-results/cpu" \
  --cpu-prof-name=tui-source.cpuprofile \
  run --cwd packages/opencode --conditions=browser src/index.ts --pure "$PWD"

python3 perf/tui-startup/analyze_cpu_profile.py \
  tmp/tui-startup-results/cpu/tui-source.cpuprofile.cpuprofile \
  --match 'parse|spawn'
```

Use `--max-delta-ms 100` as a sensitivity check, not silently as the primary result. Write profiles only under
gitignored `tmp/`; do not commit raw profiles or generated Markdown without sanitization and size review.

## Exploratory And Discarded Evidence

The following evidence informed hypotheses but is excluded from authoritative result tables:

- Single casts: `compiled-tui.cast` (TTFD 4878.77 ms), `compiled-controlled-debug.cast` (2126.36 ms),
  `compiled-fast-debug.cast` (770.06 ms), `compiled-http-debug.cast` (3406.18 ms with `--port 40991`), and
  `compiled-debug.cast` (interrupted before TTFD/prompt). They embed environment/argv and may contain private data,
  so they are not tracked.
- Raw CPU profiles and Markdown reports: controlled profile SHA-256
  `8f33d4c1053cc0123ed5f530fe27afd775f394611a5d943825a13833737fed45`; pure profile SHA-256
  `d14a909013144ac53e6d67e4b6b279c20298220b018bd7520386d797fa8b231d`. Raw files remain outside Git.
- Native samples: compiled SHA-256 `5fdfe5e1bce49ec68d8b0e04a57ff8532c4308fdd34c63f238c8de800d9b9815` and
  source SHA-256 `24130590572241fe350dc7046b92ac1d6d2c10e6da69fa67ef122c89f82c15f7`. Exact launch command was not
  preserved and compiled symbols were mostly stripped.
- Superseded streams: `compiled-warm.jsonl` stopped after eight samples without a summary;
  `compiled-warm-v2.jsonl` and `compiled-cold-like-v2.jsonl` came from earlier uncontrolled/superseded runs;
  `dev-dark-warm.jsonl` was empty. None contributes to headline numbers.
- Retained HOME/XDG trees, databases, logs, PTY captures, raw profiles, and debug output were reviewed only as needed
  and are deliberately excluded because they can contain private paths, run IDs, state, or secrets.

## Limitations

- Results are machine-, binary-, build-, load-, filesystem-cache-, and terminal-path-specific. The audited binary
  hash/size/build log were not preserved, so exact binary identity and derivation from baseline HEAD are unproven.
- The audit has no responsive-light scenario; real Terminal/iTerm/Kitty/WezTerm, tmux/screen, Linux, Intel, Windows,
  SSH/high-latency terminal, and alternate PTY sizes were not tested.
- Cold-like means fresh HOME/XDG application state, not a reboot or flushed page cache. Runs were serial batches, not
  randomized/interleaved, and no confidence interval or significance threshold was predeclared.
- Host load, power, and thermal state were not recorded. The harness inherits environment variables it does not
  override.
- Pure mode excludes external plugins and typical user/project config. Large/deep repositories, custom themes,
  dependency installs, database migration, and model/network/update paths were not covered.
- `--continue`, `--session`, `--prompt`, external server/attach paths, and input-to-first-accepted-keystroke were not
  authoritatively benchmarked.
- A ready sample proves the TTFD diagnostic and painted prompt were observed in a PTY read. It does not prove model,
  provider, agent, project sync, or other backend work is complete. PTY chunk timing adds observation granularity.
- Source profiles include development-only Babel/Solid transforms and shutdown. Bun Markdown self-time is distorted
  by long async deltas. Native samples lack useful compiled JavaScript/source symbols.
- Raw/cast/profile and `--keep-state` artifacts may expose databases, logs, debug text, paths, or run IDs and must be
  reviewed before sharing.

## Evidence Index

### Tracked Evidence

The four streams were copied from approved temporary artifacts and normalized from concatenated JSON into strict
one-object-per-line JSONL. Decoding before and after produced equal ordered records; normalization changed bytes and
therefore hashes but did not change record values.

| Evidence                                                             | Records | Original bytes | Original SHA-256                                                   | Tracked bytes | Tracked SHA-256                                                    |
| -------------------------------------------------------------------- | ------: | -------------: | ------------------------------------------------------------------ | ------------: | ------------------------------------------------------------------ |
| [Compiled dark warm](./evidence/compiled-dark-warm.jsonl)            |      22 |           4688 | `909f36ebe641a3b14df321bb4af3399d563a6779d07300371a8d3614e4370ebc` |          4141 | `0f6ba854105e8024e2b9cea8db6e3e8545d061470083a234f73442b1b96621d8` |
| [Compiled dark cold-like](./evidence/compiled-dark-cold-like.jsonl)  |      16 |           3636 | `b17f3cf587d6330feef9f351e0d7aa545741679d8718598276ea3ae167553f77` |          3178 | `4a9988cf214558c692fe93059a3d2e59db495444533fb54746e8b8efd6954d86` |
| [Compiled no-theme warm](./evidence/compiled-no-theme-warm.jsonl)    |      12 |           2879 | `43802fb970c030413f03a7fff8a12fcfa87a18ca0cb0c5d9d4db4efea637dfd2` |          2482 | `d16bbfe7378f73943ed3e90f0dc88239974dfdfe95035be11d7fb4aa083a2cf2` |
| [Source/dev dark warm](./evidence/source-dev-dark-warm.jsonl)        |      12 |           2867 | `66b0e637d7a53cb6776f66442f110146643873dbdf27340c5b1fbb350b6abeb1` |          2470 | `fa85d2f86daa3b36f2d014ffa851e932da73835b9b83af1d1f2a5e0798b1b7e7` |
| [Share-safe CPU profile summary](./evidence/cpu-profile-summary.txt) |     n/a |            n/a | Derived from identified raw profiles                               |          4698 | `25070b4289541e9b6498c231cef2f76ded8621025eed00fbd4185798bc5a2fb5` |

Record counts include one summary object per stream and one seed object in each warm stream. The cold-like stream has
no seed record.

### Tooling Identity

The audit tooling was preserved separately and is linked rather than copied into this spike.

| Tool                                      | SHA-256 at audit completion                                        |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `perf/tui-startup/README.md`              | `eb2417b2c338fef474c79b1fb314f60519d313948cfcb927bd42f0b4836135e0` |
| `perf/tui-startup/tui_benchmark.py`       | `49c14cec496e15ff75ab86efd70ecd316dabb2c3c5637ef320d697f81f5524d4` |
| `perf/tui-startup/tui_probe.py`           | `46776d7a323f1e10a4aabb53f9e0414b67ae7a3cf93fc3bbf24825b3f28752b1` |
| `perf/tui-startup/analyze_cpu_profile.py` | `9c9c6a705012d13cf20be5d849812ff81bc58d579750deacc2a58f5cb6995a83` |

Raw profiles, casts, PTY captures, logs, databases, and HOME/XDG state are intentionally absent from this index and
folder. Their relevant identities and dispositions are recorded above without recording private absolute paths.
