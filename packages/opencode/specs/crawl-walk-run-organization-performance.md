# Crawl Walk Run Organization And Performance

## Goal

Organize and performance-optimize the repo in three reviewable phases: crawl, walk, and run. The first pass should remove obvious ambiguity and low-risk overhead, the second pass should extract and cache the highest-friction paths, and the final pass should add guardrails that keep the repo from regressing as it grows.

The strategy is intentionally incremental. Each phase must produce useful improvements on its own, avoid broad rewrites, and keep behavior stable unless a PR explicitly documents a user-visible change.

## Current State

- HTTP API code exists in both `packages/server/src/groups`, `packages/server/src/handlers`, `packages/opencode/src/server/routes/instance/httpapi/groups`, and `packages/opencode/src/server/routes/instance/httpapi/handlers` with repeated domains such as `session`, `provider`, `permission`, `question`, and `config`.
- `packages/opencode/src/server/routes/instance/httpapi/server.ts` imports both local instance HTTP API handlers and `@oc2-ai/server` API/handlers, so endpoint ownership is not obvious from paths alone.
- `packages/desktop/src/renderer/i18n/index.ts` imports app dictionaries through `../../../../app/src/i18n/*`.
- `packages/desktop/src/main/windows.ts` imports `../../../ui/src/theme/themes/oc-2.json` while also using `@opencode-ai/ui` package exports.
- Several implementation-heavy files are named `index.ts`, including `packages/opencode/src/mcp/index.ts`, `packages/opencode/src/snapshot/index.ts`, `packages/opencode/src/patch/index.ts`, and `packages/opencode/src/worktree/index.ts`.
- Large hand-written production files include `packages/tui/src/routes/session/index.tsx`, `packages/app/src/pages/layout.tsx`, `packages/ui/src/components/message-part.tsx`, `packages/app/src/components/prompt-input.tsx`, `packages/opencode/src/lsp/server.ts`, `packages/opencode/src/provider/provider.ts`, and `packages/opencode/src/session/prompt.ts`.
- Core config and plugin domains are spread across `packages/core/src/v1/config`, `packages/core/src/config`, `packages/core/src/config/plugin`, `packages/core/src/plugin`, and `packages/core/src/public`.
- TUI CLI tests in `packages/opencode/test/cli/cmd/tui/*.test.tsx` import deep internals and fixtures from `packages/tui/src` and `packages/tui/test`.
- `packages/opencode/src/tool/read.ts` resolves directory entries and symlink stats with unbounded concurrency.
- `packages/opencode/src/session/prompt.ts` resolves prompt `@file` references with unbounded filesystem/service fan-out.
- `packages/core/src/filesystem/search.ts` can stat glob fallback results to sort by mtime.
- `packages/opencode/src/session/processor.ts` and `packages/opencode/src/cli/cmd/run/prompt.shared.ts` use `JSON.stringify` equality checks in paths that can handle large tool input or prompt data.
- `packages/opencode/src/session/compaction.ts` repeatedly lowers messages, serializes slices, and estimates tokens during compaction selection.
- `packages/opencode/src/snapshot/index.ts` can run several git commands and filesystem checks per assistant step through track/patch flows.
- `packages/opencode/src/mcp/index.ts` initializes configured MCP servers and collects server tools/prompts/resources with unbounded fan-out.
- `packages/opencode/src/provider/provider.ts` serializes public provider info through `JSON.stringify`/`JSON.parse` with a replacer.
- `packages/opencode/src/cli/cmd/run/subagent-data.ts` updates frame details with repeated linear lookups.
- `packages/opencode/src/session/session.ts` emits `PartUpdated` events by cloning entire parts.
- `packages/opencode/src/cli/cmd/stats.ts` hydrates every message for every selected session to aggregate usage and tool stats.
- `packages/opencode/src/session/llm/fugu.ts` runs resolved branches with unbounded concurrency.
- Root `package.json` runs `bun turbo typecheck`, but `turbo.json` has a bare `typecheck` task and `.github/workflows/typecheck.yml` does not use the same cache setup as test CI.
- `.github/workflows/test.yml` reports `packages/*/.artifacts/unit/junit.xml`, which misses nested workspaces such as `packages/console/*` and `packages/stats/*`.
- `packages/opencode/script/trace-imports.ts` contains a contributor-local absolute path.
- `packages/opencode/script/build.ts` and `packages/cli/script/build.ts` duplicate multi-platform Bun compile target logic.
- SDK generated files live under `packages/sdk/js/src/gen` and `packages/sdk/js/src/v2/gen`; UI generator scripts live under `packages/ui/script`.

## Non-Negotiables

- Keep each phase independently reviewable. Do not bundle crawl, walk, and run changes into one large PR.
- Preserve existing public API, CLI, TUI, SDK, config, and file format behavior unless a slice explicitly declares otherwise.
- Prefer bounded concurrency defaults that are conservative and configurable only when there is a known operator need.
- Do not split large files only to reduce line count. Extract cohesive leaf modules with tests or typecheck coverage.
- Do not add backward-compatibility shims for internal imports unless persisted data, external consumers, or published packages require them.
- Run package-level checks from the relevant package directory. Do not run tests from repo root unless a root script is the behavior under test.
- Generated SDK changes must use the repo command from `AGENTS.md`: `./packages/sdk/js/script/build.ts` from the repo root.
- CI guardrails should first warn or fail on newly introduced violations. Existing violations should be listed explicitly before enforcing full cleanup.

## Crawl Phase

The crawl phase removes low-risk ambiguity and caps obvious local overhead. It should not change architecture.

### Scope

- Document endpoint ownership between `packages/server` and `packages/opencode/src/server/routes/instance/httpapi`.
- Replace or plan the two known cross-package source-relative desktop imports.
- Cap unbounded filesystem and prompt-resolution concurrency.
- Avoid unnecessary metadata stats in glob fallback unless recency ordering is required.
- Replace hot `JSON.stringify` equality checks where a cheaper stable key is available.
- Fix CI/tooling correctness issues that do not require architectural changes.

### Expected Behavior

- New HTTP endpoints must have a documented default location and naming convention.
- Desktop must consume app/UI shared assets through a package export or explicitly documented shared asset module.
- Directory reads, prompt reference resolution, and MCP-compatible list operations must not spawn unbounded local filesystem or service work by default.
- Glob fallback must not pay mtime stat cost unless the caller requests recency sorting or the behavior is explicitly required by existing tests.
- Typecheck CI must use the same style of cache wiring as test CI.
- Test report collection must include nested package workspaces.

### PR 1: Ownership Notes And Import Cleanup

- Add a short ownership note near the HTTP API implementation, preferably in the smallest existing docs location reviewers prefer.
- Define when new endpoints belong in `packages/server/src/{groups,handlers}` versus `packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}`.
- Export the desktop i18n dictionaries through an app package surface or move them to a small shared module.
- Export `oc-2.json` through `@opencode-ai/ui` or a shared package surface consumed by desktop.
- Do not rename API files or move endpoint implementations in this slice.

Verification:

- `cd packages/desktop && bun typecheck`
- `cd packages/app && bun typecheck`
- `cd packages/opencode && bun typecheck`

Review:

A read-only reviewer checks that package boundaries are improved without creating new barrels that force broad module evaluation.

### PR 2: Bounded Local Fan-Out

- Update `packages/opencode/src/tool/read.ts` so symlink stat resolution uses a bounded concurrency limit such as `16` or `32`.
- Update `packages/opencode/src/session/prompt.ts` so prompt `@file` reference resolution dedupes references before filesystem/service checks and uses bounded concurrency.
- Audit `packages/opencode/src/mcp/index.ts` list operations and cap collection fan-out where it can burst across many servers.
- Keep limits local constants unless existing config already has an appropriate place for them.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/tool/read.test.ts` if present, otherwise add a focused read-directory test.
- `cd packages/opencode && bun test --timeout 30000 test/session/prompt.test.ts` if present, otherwise add a focused prompt reference test.
- `cd packages/opencode && bun typecheck`

Review:

A read-only reviewer confirms all previously unbounded fan-out in the touched paths is bounded and that order-sensitive outputs remain deterministic.

### PR 3: Tooling Correctness And Cheap Comparisons

- Add explicit `inputs` and safe `outputs` for `typecheck` in `turbo.json`.
- Add Turbo cache setup to `.github/workflows/typecheck.yml`, mirroring the relevant parts of test CI.
- Change `.github/workflows/test.yml` report collection from `packages/*/.artifacts/unit/junit.xml` to `packages/**/.artifacts/unit/junit.xml`.
- Replace the hardcoded path in `packages/opencode/script/trace-imports.ts` with a path derived from `import.meta.dir`.
- Replace `JSON.stringify` equality in `packages/opencode/src/session/processor.ts` and `packages/opencode/src/cli/cmd/run/prompt.shared.ts` only where a stable key or shallow comparison preserves behavior.

Verification:

- `bun turbo typecheck --dry-run` from the repo root if supported by the installed Turbo version.
- `cd packages/opencode && bun typecheck`
- Run or dry-run `packages/opencode/script/trace-imports.ts` from a non-root working directory if the script has an existing command entry.

Review:

A read-only reviewer compares before/after equality semantics and confirms CI globs still collect existing package reports.

## Walk Phase

The walk phase targets high-friction code organization and repeated CPU/process work. It should produce measurable maintainability or latency wins without changing product behavior.

### Scope

- Extract cohesive modules from the largest hand-written files as they are touched.
- Normalize implementation-heavy `index.ts` files by moving implementation into named sibling modules.
- Cache repeated compaction token estimates inside one compaction run.
- Short-circuit snapshot git work when no relevant file changes occurred.
- Cache sanitized public provider info until provider state changes.
- Consolidate duplicated binary build target logic.
- Define stable testing surfaces for TUI fixtures consumed from opencode tests.

### Expected Behavior

- File splits must preserve imports, behavior, and test coverage.
- Compaction must select the same messages before and after caching for the same inputs.
- Snapshot tracking must not miss user-visible file changes.
- Provider public output must remain structurally identical.
- Build scripts must keep the same supported OS/arch/libc target matrix.

### PR 4: Compaction And Snapshot Hot Paths

- Add per-run token estimate caching in `packages/opencode/src/session/compaction.ts` keyed by message IDs, part IDs, model, and relevant options.
- Avoid repeated lowering/serialization when the same message slice is evaluated multiple times during one compaction.
- Avoid `structuredClone` in compaction unless plugin transforms or mutation boundaries require it.
- Update `packages/opencode/src/session/processor.ts` and `packages/opencode/src/snapshot/index.ts` so track/patch can reuse a dirty/candidate state inside one assistant step.
- Skip the second snapshot add/patch preparation when no tool touched files and no dirty candidates exist.

Verification:

- `cd packages/opencode && bun test --timeout 30000 test/session/compaction.test.ts` if present, otherwise add focused compaction selection tests.
- `cd packages/opencode && bun test --timeout 30000 test/snapshot.test.ts` if present, otherwise add focused snapshot dirty/no-op tests.
- `cd packages/opencode && bun typecheck`

Review:

A read-only reviewer confirms cache keys cannot cross models/options and snapshot no-op detection cannot hide real file changes.

### PR 5: Provider, MCP, And Stats Read-Side Caches

- Materialize sanitized public provider data in `packages/opencode/src/provider/provider.ts` when provider/config state changes instead of serializing the full provider catalog on every read.
- Cap MCP initialization/listing in `packages/opencode/src/mcp/index.ts` with a default that still allows common multi-server setups to initialize quickly.
- Add aggregate query support for `packages/opencode/src/cli/cmd/stats.ts` so totals/model/tool counts do not hydrate every message for every session.
- Keep detailed message hydration only for drill-down behavior that truly needs individual message parts.

Verification:

- `cd packages/opencode && bun typecheck`
- Add a provider serialization test proving public output omits the same private fields as before.
- Add a stats aggregation test with multiple sessions, models, tools, and empty sessions.

Review:

A read-only reviewer confirms cached provider output invalidates on config/provider changes and stats totals match the pre-change implementation on fixtures.

### PR 6: Cohesive Module Extraction

- Extract leaf modules from `packages/tui/src/routes/session/index.tsx` around keybindings, dialogs, or status rendering.
- Extract leaf modules from `packages/app/src/pages/layout.tsx` around workspace/sidebar/deep-link state.
- Extract subcomponents from `packages/ui/src/components/message-part.tsx` only where props are clear and reusable.
- Split `packages/opencode/src/lsp/server.ts` into lifecycle/process management and protocol wiring if the boundaries are already visible.
- Split `packages/opencode/src/provider/provider.ts` into registry, auth, and public serialization only after PR 5 clarifies the serialization boundary.
- Rename or split implementation-heavy `index.ts` files when touching `mcp`, `snapshot`, `patch`, or `worktree`.

Verification:

- `cd packages/tui && bun typecheck`
- `cd packages/app && bun typecheck`
- `cd packages/ui && bun typecheck`
- `cd packages/opencode && bun typecheck`

Review:

A read-only reviewer checks that extracted modules are cohesive, no new broad barrels were added, and import paths remain package-local or public-package imports.

### PR 7: Build Matrix And Test Fixture Surfaces

- Move shared Bun compile target definitions from `packages/opencode/script/build.ts` and `packages/cli/script/build.ts` into a shared script module under `packages/script` or another existing tooling package.
- Preserve the existing target matrix exactly before adding or removing targets.
- Add a stable TUI testing export such as `@oc2-ai/tui/testing` if package exports support it, or a package-local testing utility consumed by `packages/opencode/test/cli/cmd/tui/*.test.tsx`.
- Replace deep test imports from `packages/tui/src` and `packages/tui/test` with the stable testing surface.

Verification:

- `cd packages/opencode && bun typecheck`
- `cd packages/cli && bun typecheck`
- `cd packages/tui && bun typecheck`
- `cd packages/opencode && bun test --timeout 30000 test/cli/cmd/tui`

Review:

A read-only reviewer confirms build outputs target the same platforms and TUI tests no longer depend on movable internals.

## Run Phase

The run phase adds durable guardrails, deeper performance changes, and repo-wide hygiene. These changes should happen after the crawl and walk phases reduce known noise.

### Scope

- Add package-boundary checks for new cross-package source-relative imports.
- Track dependency graph health and intentional high-layer edges.
- Add package-scoped CI filtering and consider remote Turbo cache.
- Add generated-artifact drift checks.
- Add higher-scale runtime improvements for session events, subagent frame indexing, Fugu concurrency, and large asset handling.

### Expected Behavior

- CI should prevent new package-boundary regressions without forcing all historical cleanup into the first enforcement PR.
- Dependency graph reports should distinguish warnings from hard failures.
- Generated-artifact checks must be deterministic and must document the regeneration command.
- Runtime concurrency limits must have defaults that protect local machines while preserving current small-config behavior.

### PR 8: Boundary And Graph Guardrails

- Add a lint or script check that flags imports crossing package roots through deep relative paths such as `../../../../other-package/src`.
- Allow explicit temporary exceptions for existing violations, with comments linking to cleanup tasks.
- Add a dependency graph report that tracks circulars, high fan-in implementation files, and intentional high-layer edges such as `@oc2-ai/core` to `@oc2-ai/llm`.
- Run the guardrail in CI as warning-only first if existing violations are not fully cleaned up.

Verification:

- Run the new boundary script from the repo root.
- `bun turbo typecheck` from the repo root.

Review:

A read-only reviewer confirms the check catches a synthetic bad import and does not flag valid package entrypoint imports.

### PR 9: Generated Artifacts And CI Scaling

- Add a `check:generated` flow that regenerates SDK/OpenAPI and UI generated assets, then fails on diff.
- Use `./packages/sdk/js/script/build.ts` for JS SDK regeneration from the repo root.
- Add changed-package filters for common PR CI paths while keeping scheduled or default-branch full runs.
- Evaluate remote Turbo cache only after local cache inputs/outputs are correct.
- Document how large tracked assets such as console lander videos and large fixtures should be stored if clone size becomes a bottleneck.

Verification:

- Run the new generated-artifact check locally.
- `./packages/sdk/js/script/build.ts` from the repo root when OpenAPI/SDK output changes.
- Validate CI path filters against sample changes touching `packages/opencode`, nested packages, docs-only files, and generated files.

Review:

A read-only reviewer confirms generated checks are deterministic and path filters do not skip required typecheck/test jobs for shared package changes.

### PR 10: High-Scale Runtime Optimizations

- Add a `frameKey -> index` map beside frame details in `packages/opencode/src/cli/cmd/run/subagent-data.ts` to avoid repeated `findIndex` work during event bursts.
- Change frequent session update paths in `packages/opencode/src/session/session.ts` to emit immutable delta events for large/frequent updates, while preserving full part updates at lifecycle boundaries.
- Add a default max concurrency for `packages/opencode/src/session/llm/fugu.ts` branch execution and expose configuration only if needed.
- Stream branch completion into judge/synthesizer only if it can be done without changing judging semantics.

Verification:

- `cd packages/opencode && bun typecheck`
- Add focused tests for subagent frame update ordering and compaction/limit behavior.
- Add session event tests proving consumers still receive enough data for existing UI/tool behavior.
- Add Fugu tests proving concurrency caps preserve successful output and failure aggregation.

Review:

A read-only reviewer checks event compatibility, branch failure behavior, and whether any SDK/event schema updates require regeneration.

## Risks

- File splits can create churn without improving readability. Mitigate by extracting only cohesive leaf behavior and keeping each PR small.
- Concurrency caps can change timing. Mitigate with deterministic tests and conservative defaults.
- Snapshot short-circuiting can miss file changes if the dirty signal is too narrow. Mitigate with tests covering tool writes, external writes, ignored files, and no-op steps.
- CI filtering can skip required checks when shared packages change. Mitigate with explicit shared-dependency path rules and scheduled full runs.
- Generated checks can become flaky if generators include timestamps or nondeterministic ordering. Mitigate by removing nondeterminism before enforcing CI failures.

## Future Work

- Create a shared API contract package if endpoint churn stabilizes and duplication between `packages/server` and opencode instance HTTP API continues to cause drift.
- Move large binary assets to Git LFS, CDN, or release artifacts if clone and checkout time become a measured problem.
- Add deeper module-load profiling before enforcing aggressive barrel/index restrictions across all packages.
- Add benchmark fixtures for compaction, snapshot, stats, provider serialization, and MCP initialization once the first optimizations land.
- Consider config-exposed concurrency limits for MCP and Fugu only after defaults prove insufficient for real users.

## Open Questions

- Should the HTTP API ownership map live in a spec, source-adjacent README, or package docs? Default: source-adjacent note plus this spec as implementation plan.
- Should package-boundary checks fail immediately or start warning-only? Default: fail on new violations and allow existing violations through an explicit baseline.
- Should provider public serialization cache be per process or per workspace/instance? Default: per provider state/config lifecycle, not global across unrelated instances.
- Should stats aggregation require schema changes? Default: first try read-side aggregate queries; add maintained stats tables only if query cost remains high.
- Should Fugu concurrency be user-configurable in the first run-phase PR? Default: no, add a conservative default cap first and expose config later if needed.
