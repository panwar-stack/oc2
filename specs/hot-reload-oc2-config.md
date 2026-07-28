# Hot Reload `oc2.json` Configuration

## Goal

Apply supported `oc2.json` and `oc2.jsonc` changes without restarting OC2 by constructing an isolated configuration generation, validating and bootstrapping it without modifying the active generation, and atomically routing new work to it.

Invalid or failed candidates must leave the active generation unchanged. All route-active configuration readers included in scope must observe the same declared revision. Filesystem watching is the final trigger mechanism, not the lifecycle boundary.

## Current State

- `packages/opencode/src/config/paths.ts` discovers project, ancestor, global, `.oc2`, `OC2_CONFIG`, and `OC2_CONFIG_DIR` locations.
- `packages/opencode/src/config/config.ts` parses, merges, and caches legacy runtime configuration. Its global and per-directory caches are independent, and `Config.invalidate()` clears only the global cache.
- Configuration-dependent services use directory-keyed `InstanceState` caches in `packages/opencode/src/effect/instance-state.ts`.
- `InstanceStore.reload()` in `packages/opencode/src/project/instance-store.ts` disposes the active instance before bootstrapping its replacement. A failed replacement therefore loses the last-known-good instance.
- `InstanceContext`, lifecycle events, and SSE disposal matching do not carry a generation (`packages/opencode/src/project/instance-context.ts`, `packages/opencode/src/event-v2-bridge.ts`, and `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`).
- Native V2 routes use a separate read-once config and 60-minute location cache in `packages/core/src/config.ts` and `packages/core/src/location-layer.ts`. `packages/core/test/config/config.test.ts` verifies that edits currently remain stale.
- The watcher in `packages/core/src/filesystem/watcher.ts` is location-scoped, optional, affected by ignore settings, and not part of the opencode `AppRuntime`. Its native tests are skipped in CI.
- Project and global config HTTP handlers already schedule disposal after writes in `packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts` and `global.ts`, creating a duplicate-reload risk once filesystem events are enabled.
- Clients already rebootstrap after `server.instance.disposed`, but current events cannot distinguish an old generation from its replacement.
- `packages/core/src/plugin/skill/customize-opencode.md` documents config as restart-only.

## Non-Negotiables

- Instance identity must be `(canonicalDirectory, generation)`, not directory alone.
- A candidate must use a distinct scope and generation-keyed `InstanceState` namespace.
- Commit only after the complete candidate readiness barrier succeeds. Parsing alone is insufficient.
- Invalid parsing, schema validation, variable substitution, plugin loading, or bootstrap must retain the active generation and emit no disposal event for it.
- New work must not enter a draining generation. Old work must not acquire resources from or publish events as the replacement generation.
- Project changes must replace only affected instances. Shared ancestor and global changes must fan out to every indexed consumer.
- A global change must establish a coherent epoch before new work is admitted.
- Atomic saves, internal writes, and event bursts must produce zero replacements for an unchanged effective config and exactly one replacement for one changed generation.
- Diagnostics must be typed, redacted, and emitted on a process-level channel that survives instance teardown.
- Watch subscriptions, candidate scopes, queued work, and old resources must close exactly once.
- Do not enable automatic filesystem reload until generation isolation, admission fencing, and failure-atomic activation exist.
- Root `bun run test` must not be used; tests are package-specific.

## Supported Configuration Sources

The first pass must watch candidate parent directories and support add, change, delete, and atomic replacement for:

- Direct `oc2.json` and `oc2.jsonc` from the routed directory through the worktree root.
- `oc2.json` and `oc2.jsonc` inside discovered `.oc2` directories.
- Global config directory candidates.
- The explicit `OC2_CONFIG` file.
- Candidates under `OC2_CONFIG_DIR`.

The first pass must exclude:

- Agent, command, mode, skill, and plugin source files.
- `{file:...}` substitution dependencies.
- Remote well-known configuration.
- `OC2_CONFIG_CONTENT` and environment changes after process start.
- Legacy TOML and managed preferences.
- Hard-link aliases and symlink targets outside watched roots.

Creating a higher-precedence `oc2.jsonc`, deleting it to fall back to `oc2.json`, and creating a previously absent `.oc2/oc2.json` must all be detected.

## Generation Lifecycle

```ts
type InstanceGeneration = {
  directory: string
  generation: number
  globalEpoch: number
  revision: number
  state: "booting" | "active" | "draining" | "closed"
  fingerprint: string
}
```

- Build candidates under a new generation-keyed scope while the active generation remains usable.
- A candidate readiness barrier must cover config loading, variable substitution, parsing, schema and sandbox validation, merging, plugin resolution and config hooks, plus eager bootstrap services in `packages/opencode/src/project/bootstrap.ts`.
- Atomically replace the active-generation pointer only after readiness succeeds and the candidate revision is still newest.
- Close only the candidate on failure.
- Every request, background fiber, native callback, and child-process initialization must hold or inherit a generation lease.
- Draining generations must reject new admission.
- First-pass retirement may cancel existing work after cutover, matching current config PATCH behavior. Cancellation must be explicit and bounded; pending permissions and questions may be rejected.
- Events and stream termination must include and compare generation identity so late old-generation events cannot affect the replacement.

## Global Epochs And V2 Consistency

- A global config change must create one immutable global epoch and establish an admission fence before enumerating affected instances.
- Every candidate project generation must bind to that exact epoch.
- Cutover may proceed per project, but events and responses must expose revisions so mixed epochs are not reported as an atomic global commit.
- A successful synchronous config API response must guarantee that subsequently admitted requests use the committed epoch.
- Hot reload must cover every route-active config reader. Native V2 config must consume the same committed snapshot or invalidate and rebuild every exact active `Location.Ref`, including workspace variants, under the same revision.
- Do not report a successful process-wide reload while `/api/*` routes remain on a stale V2 generation.

## Dependency Index And Change Coordination

Maintain an index updated only after successful activation:

```ts
type ConfigDependencyIndex = Map<
  CanonicalConfigPath,
  Set<{ directory: string; workspaceID?: string; generation: number }>
>
```

For each logical change:

1. Canonicalize the path and assign a monotonic revision.
2. Resolve affected active generations from the committed dependency index.
3. Coalesce raw create, change, delete, and rename events by candidate set.
4. Construct and bootstrap the complete candidate generation.
5. Reject stale candidates when a newer revision exists.
6. Compare the effective merged fingerprint with the active generation.
7. Commit only a changed, newest, ready candidate.
8. Drain and close the replaced generation.

Project `Config.update()` must return whether effective content changed. API writes, tool writes, and native events must pass through one serialized coordinator using canonical path and expected-content attribution.

## Diagnostics And API Surface

Define typed, redacted process-level events:

```ts
type ConfigReloadRejected = {
  type: "config.reload.rejected"
  path: string
  revision: number
  reason: "parse" | "schema" | "bootstrap" | "unsupported"
  message: string
}

type ConfigReloadCommitted = {
  type: "config.reload.committed"
  revision: number
  generation: number
  scope: "project" | "global"
  directories: string[]
  restartRequired: string[]
}
```

- Never include config contents, substituted values, environment values, tokens, or plugin options.
- Deduplicate repeated rejection diagnostics for the same invalid fingerprint.
- Register events before OpenAPI schema snapshots and regenerate affected clients.
- Clients must ignore lifecycle events for generations other than the stream's generation.

## Restart-Required Settings

Instance replacement must not claim to apply:

- Server port, hostname, mDNS, mDNS domain, or CORS settings resolved before listener creation.
- TUI host, keybind, or theme settings loaded by `packages/opencode/src/config/tui.ts`.
- Autoupdate behavior already evaluated at startup.
- Plugin workspace-adapter removals until `packages/opencode/src/control-plane/adapters/index.ts` supports unregistering them.

Valid changes to these fields may accompany reloadable changes, but the committed event must identify the restart-required fields and the process-owned values must remain unchanged.

## Deterministic Acceptance Cases

- Valid project edit replaces exactly one affected generation.
- Higher-precedence file creation and deletion fallback apply exactly once.
- Invalid JSON, schema, substitution, or plugin bootstrap retains the identical active generation and emits no disposal event for it.
- Invalid-to-valid atomic save never exposes defaults or a lower-precedence transient generation.
- Rapid A → B → C writes commit only the newest valid revision.
- Same effective merged config and no-op API writes cause zero replacements.
- API or tool writes plus native events cause exactly one replacement.
- A shared ancestor change replaces every indexed consumer and no unrelated instance.
- A global change binds every affected instance to the declared global epoch.
- V1 and V2-backed routes report the same committed revision.
- Late old-generation events cannot terminate or mutate replacement streams.
- Candidate failure closes candidate resources exactly once; successful replacement closes old plugin, MCP, LSP, and watcher resources exactly once.
- Coordinator shutdown removes subscriptions and prevents queued events from resurrecting an instance.
- Watcher unavailability emits a diagnostic and retains restart-required behavior.
- Restart-required fields remain unchanged and are reported accurately.

Use injected event sources, deferred values, latches, and generation barriers. Do not use timing sleeps for coordinator correctness tests.

## Implementation Slices

### PR 1: Generation Lifecycle Foundation

- Add generation identity to `InstanceContext`, `InstanceStore`, and `InstanceState` cache keys.
- Add isolated candidate scopes and atomic active-pointer replacement.
- Add admission leases and `booting`, `active`, `draining`, and `closed` states.
- Make lifecycle events and SSE disposal matching generation-aware.
- Test failed candidate bootstrap, admission during cutover, late events, and exactly-once scope closure.
- Do not add filesystem watching.

Verification:

- `bun run --cwd packages/opencode test -- test/project/instance.test.ts test/project/instance-bootstrap.test.ts`
- `bun run --cwd packages/opencode typecheck`
- `bun run lint`

Review:

A fresh read-only reviewer must verify failure atomicity, generation isolation, admission fencing, event ordering, and old-generation teardown before this slice is checked off.

### PR 2: Config Evaluation, Global Epochs, And V2

- Add strict side-effect-controlled evaluation of candidate generations without startup fallbacks that convert invalid config to `{}`.
- Define the full readiness barrier and effective-config fingerprint.
- Add global epoch fencing and revisioned per-project cutover.
- Make route-active V2 locations consume or rebuild from the same committed revision.
- Add the committed dependency index for project, ancestor, workspace, and global sources.

Verification:

- `bun run --cwd packages/opencode test -- test/config/config-hot-reload.test.ts test/config/config.test.ts test/project/instance.test.ts`
- `bun run --cwd packages/core test -- test/config/config.test.ts`
- `bun run --cwd packages/opencode typecheck`
- `bun run --cwd packages/core typecheck`
- `bun run typecheck`

Review:

A fresh read-only reviewer must verify last-known-good preservation across all readiness failures, coherent global epochs, exact location invalidation, and V1/V2 revision consistency.

### PR 3: Mutation Coordinator And Typed Diagnostics

- Add monotonic per-target revisions, single-flight evaluation, and latest-wins commit behavior.
- Make project config updates report `changed`.
- Route project/global API writes and tool writes through the coordinator.
- Add canonical-path and expected-content attribution to prevent duplicate replacement.
- Add typed committed and rejected events with redaction and deduplication.
- Regenerate OpenAPI and SDK artifacts and add client reducer coverage.

Verification:

- `bun run --cwd packages/opencode test -- test/config/config-hot-reload.test.ts test/server/httpapi-config.test.ts`
- `bun run --cwd packages/app test --preload ./happydom.ts ./src/context/global-sync/event-reducer.test.ts`
- `bun run check:generated`
- `bun run typecheck`
- `bun run lint`

Review:

A fresh read-only reviewer must verify zero/one replacement guarantees, secret redaction, public event compatibility, generated artifacts, and concurrent revision handling.

### PR 4: Filesystem Observation

- Add a dedicated config watcher independent of experimental flags and user ignore patterns.
- Watch candidate parent directories so absent files, deletion, and atomic replacement are detected.
- Feed filtered events into the existing mutation coordinator.
- Provide an injected fake backend for deterministic CI coverage.
- Define watcher-unavailable fallback and diagnostic behavior.
- Add native platform smoke coverage without relying on it for coordinator correctness.

Verification:

- `bun run --cwd packages/opencode test -- test/config/config-hot-reload.test.ts`
- `bun run --cwd packages/core test -- test/filesystem/watcher.test.ts`
- `bun run --cwd packages/core typecheck`
- `bun run check:packages`
- `bun run lint`

Review:

A fresh read-only reviewer must verify source discovery parity, absent-file handling, atomic-save coalescing, platform fallback, finalizer cleanup, and that CI correctness does not depend on native watcher tests.

### PR 5: Client Behavior And Documentation

- Update TUI and app clients to handle generation-aware committed and rejected events.
- Surface restart-required fields without exposing configuration values.
- Update `packages/core/src/plugin/skill/customize-opencode.md` with watched sources, exclusions, last-known-good behavior, and restart-required settings.
- Update configuration documentation affected by the final behavior.

Verification:

- `bun run --cwd packages/opencode test`
- `bun run --cwd packages/app test --preload ./happydom.ts ./src/context/global-sync/event-reducer.test.ts`
- `bun run docs:check`
- `bun run check:generated`
- `bun run typecheck`
- `bun run lint`

Review:

A fresh read-only reviewer must verify client recovery, stale-generation filtering, diagnostics, documentation accuracy, and all acceptance cases before this slice is checked off.

## Future Work

- Hot reload agent, command, mode, skill, and plugin source files.
- Track `{file:...}` substitution dependencies.
- Refresh remote well-known and managed configuration.
- Gracefully wait for active turns rather than bounded cancellation.
- Reconnect direct `oc2 run` streams without surfacing disposal.
- Watch external symlink targets.
- Unregister plugin-provided workspace adapters.

## Open Questions

- **Must global cutover be all-or-nothing?** Default to revisioned per-project cutover behind an admission fence; expose the epoch so mixed transitions are explicit rather than falsely atomic.
- **How long may a replaced generation drain?** Default to immediate rejection of new admission and bounded cancellation matching current PATCH behavior. Graceful idle draining remains future work.
- **What happens when native watching is unavailable?** Default to retain the active config, emit one redacted diagnostic, and require restart rather than polling silently.
