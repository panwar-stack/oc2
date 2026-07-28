# TUI startup audit tools

These scripts preserve the PTY benchmark, raw-output probe, and CPU-profile analysis used for the July 2026 startup audit. Run commands from the repository root.

## Prerequisites

- macOS or Linux: the PTY tools require `pty`, `fcntl`, and `termios`.
- Python 3.9 or newer, with only the standard library.
- Bun 1.3.14 and installed repository dependencies.
- A platform build from `bun run dev:build`. The examples below auto-select the single generated `oc2` executable; if more than one exists, set `OC2_BIN` explicitly.

```sh
bun run dev:build
OC2_BIN="${OC2_BIN:-$(printf '%s\n' packages/opencode/dist/oc2-*/bin/oc2)}"
test -x "$OC2_BIN"
mkdir -p tmp/tui-startup-results
```

`tmp/` is gitignored. No captured output, state directory, log, cast, or CPU profile belongs in this tooling folder.

## Benchmark scenarios

`tui_benchmark.py` creates a unique directory below `--state-root`, points `HOME` and all XDG roots at it, uses a 100x30 PTY, and disables model fetching, updates, mouse handling, terminal-title changes, and project config. State is removed after the run unless `--keep-state` is passed. Output files are created exclusively; pass `--force` to replace one.

The final audit used these exact scenarios (the warm seed is reported but excluded from the sample count):

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

Run scenarios serially, on an otherwise idle machine. `warm` reuses isolated app state after one unmeasured seed; `cold-like` creates fresh app state but cannot flush OS filesystem caches. Responsive `dark` and `light` emulate replies to OSC 10/11 foreground/background queries. `none` measures the unsupported/non-responsive terminal path.

### Readiness and output

A sample is ready only after cumulative PTY output contains both:

1. the internal `Time to first draw: <milliseconds>ms` diagnostic enabled by `OC2_SHOW_TTFD=1`; and
2. the visible prompt text `Ask anything...` (override with `--ready-text`).

Each JSONL sample contains process-to-first-byte wall time, process-to-readiness wall time, the app-reported TTFD, bytes read, and timeout state. The last line contains min/median/mean/p90/p95/max/stdev summaries over valid samples. A readiness timeout is retained in the file and makes the script exit nonzero. PTY chunking means `ready_ms` is the time of the read that first contained both markers, not a renderer-internal timestamp.

## Raw startup probe

Use the probe to inspect control sequences or output chunk timing without responding to terminal queries:

```sh
python3 perf/tui-startup/tui_probe.py \
  --raw tmp/tui-startup-results/probe.raw \
  -- "$OC2_BIN" --pure "$PWD" \
  > tmp/tui-startup-results/probe.txt

xxd -g 1 -l 320 tmp/tui-startup-results/probe.raw
```

The raw file may contain terminal output or debug text; review it before sharing. The probe also uses isolated HOME/XDG state and removes it by default. It refuses to overwrite `--raw` unless `--force` is passed.

## CPU profiling and analysis

Bun profiling works on the source command; the compiled executable ignored `BUN_OPTIONS=--cpu-prof` during the audit. Write profiles only under gitignored `tmp/`:

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

Stop the TUI with Ctrl-C after it reaches the prompt. The analyzer reports leaf sample counts, dependency/product buckets, and inclusive product frames. Counts are the default because Bun Markdown can attribute a long async `timeDelta` to one leaf and overstate its self-time; optionally exclude such samples with `--max-delta-ms`. Source profiles include development-only Babel/Solid transforms and are not a direct production hotspot profile. macOS `/usr/bin/sample` can characterize native waits and subprocesses in the compiled binary, but stripped Bun/JavaScript frames generally cannot identify source hotspots.

## Caveats

- Results are machine-, build-, load-, filesystem-cache-, and terminal-path-specific; compare interleaved repeated runs on the same system.
- The harness inherits non-overridden environment variables. Its network-prone OC2 features are disabled, but use a sanitized shell for shareable measurements.
- `--keep-state` deliberately preserves application databases and logs under `--state-root`; inspect them for sensitive content and remove them manually.
- TTFD may appear before the prompt. Do not treat TTFD alone as readiness.
