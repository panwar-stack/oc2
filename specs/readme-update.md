# OC2 Minimal Coding Agent Positioning

## Goal

Position OC2 as a full, locally runnable coding-agent harness based on and inspired by [opencode](https://github.com/anomalyco/opencode), not as a "Local Template." Lead with the working agent loop, provider integration, persistence, permission-gated tools, agents, and CLI/TUI/server/browser interfaces. Treat cloning and forking as development workflows, not the product's primary value.

Keep `OC2` as the product name. Use "minimal coding-agent harness" as its category: minimal in distribution and owner-service assumptions, while retaining the execution capabilities required for a usable coding agent.

## Current State

- `README.md:1-5` calls the project "OC2 Local Template" and an "AI coding agent template"; `README.md:12-57` already documents interactive, one-shot, server, and browser startup.
- `packages/opencode/package.json:19-20` exposes the `oc2` executable. `packages/opencode/src/index.ts` provides the default TUI plus `run`, `serve`, `web`, provider, MCP, ACP, and agent commands.
- `packages/opencode/src/provider/provider.ts`, `packages/opencode/src/agent/agent.ts`, and `packages/opencode/src/tool/registry.ts` implement configurable providers, built-in/configured agents, permissions, and tools.
- `packages/opencode/test/cli/run/run-process.test.ts` and `packages/opencode/test/cli/serve/serve-process.test.ts` exercise the real CLI as subprocesses.
- Template positioning remains in `CONTRIBUTING.md:3`, `README.md:102`, `packages/app/README.md:1-3`, and `packages/onboarding.md:3,99`.
- `packages/core/src/naming.ts` centralizes the stable `oc2` slug, `OC2` display name, config names, environment prefix, schema URL, and domain.
- `README.md:5` claims there is no hosted app fallback, but `packages/opencode/src/server/shared/ui.ts` proxies `app.oc2.ai` when embedded browser assets are unavailable. Model prompts also reference hosted docs, while browser and TUI onboarding claim OC2 includes free models.
- `script/check-brand.ts` does not currently reject the stale positioning or provider claims. `script/legacy-brand-allowlist.jsonc` tracks compatibility-sensitive legacy names separately.
- `specs/minimal-coding-agent-harness-prune.md` owns hosted-service and package-pruning decisions. This spec owns product positioning and copy only.

## Non-Negotiables

- Keep `OC2` as the product name and use "minimal coding-agent harness based on and inspired by opencode" as the default descriptor. Do not imply this is an official opencode distribution.
- Define "runs locally" precisely: the OC2 process, session orchestration, filesystem/tool execution, and persistence run on the user's machine. Model-provider calls remain external unless the user configures a local provider. Do not claim offline operation.
- Do not reduce the project to a starter skeleton. The positioning must retain the full execution loop, providers, persistence, permission-gated tools, CLI/TUI/server/browser interfaces, and experimental team orchestration.
- Preserve the `oc2` binary, `@oc2-ai/*` package scope, `oc2.json`/`oc2.jsonc`, `.oc2`, `OC2_*`, HTTP routes and headers, deep links, storage keys, API symbols, hosted schema/OAuth identifiers, artifact names, and legacy aliases. Renaming them requires a separate migration spec.
- Preserve the short `OC2` UI label and existing OC2 visual assets. Do not perform a global replacement of `OC2`, `OpenCode`, or `opencode`.
- Preserve the no-sandbox and unauthenticated-server warnings in `SECURITY.md` and the attribution in `LICENSE`.
- Do not promise free models, a bundled provider, offline operation, or freedom from hosted fallbacks while runtime behavior contradicts those claims.
- Keep runtime removal of `app.oc2.ai` and other hosted services in `specs/minimal-coding-agent-harness-prune.md`; this positioning change must document current behavior honestly without changing it.

## Positioning And Copy Contract

- The README opening must answer, in order: what OC2 does, what runs locally, its opencode lineage, and how to run it.
- Product usage must lead with installed or built `oc2` commands. Put repository cloning, Bun setup, and fork customization under a secondary "Develop From Source" section.
- The capability summary must name only implemented surfaces: interactive TUI (`oc2 .`), one-shot execution (`oc2 run`), headless server (`oc2 serve`), browser client (`oc2 web`), configurable providers and agents, persistence, and permissioned tools.
- The browser documentation must state that embedded assets are served locally when present and that the current fallback proxies `app.oc2.ai`. Distinguish `oc2 web` from the fully local Vite development flow.
- Provider onboarding must say that users configure credentials or a local provider. It must not claim that OC2 bundles free models.
- "Minimal" must describe the reduced distribution and hosted-service boundary, not a lack of agent functionality.
- "Clone," "fork," "template," and "starting point" may appear in source-development or contribution instructions, but not in the title, elevator pitch, or capability summary.
- Model-facing help must use built-in help/action discovery, `oc2 --help`, and the stable issue tracker. It must not assume OC2's repository README exists in the user's working directory or direct WebFetch to nonexistent hosted documentation.
- References to opencode must be classified as upstream lineage, external compatibility, inherited identifiers, or third-party attribution. Only stale current-product prose should change.

## Deterministic Copy Checks

Add `script/check-product-copy.ts` and a root `check:product-copy` script. The checker must:

- Scan an explicit list of public and maintainer documentation for prohibited product phrases such as `OC2 Local Template`, `AI coding agent template`, and `local-first template`.
- Scan the specific browser/TUI onboarding messages for free-model or bundled-provider claims.
- Scan the default and Anthropic prompt files for hosted OC2 documentation instructions.
- Exclude historical specs, compatibility identifiers, schema URLs, OAuth metadata, runtime endpoints, fixtures, and third-party attribution.
- Print every path and matched phrase, then exit nonzero when any prohibited phrase is present.

Do not extend the check to every occurrence of `OC2`, `OpenCode`, `opencode`, or `oc2.ai`; the repository contains legitimate compatibility and runtime uses.

## Implementation Slices

### PR 1: Establish Public Positioning

- Rewrite `README.md` around the copy contract. Add an upstream-lineage section and state that OC2 is an independent project based on opencode.
- Move clone-first instructions into "Develop From Source" and lead with the supported `oc2` product commands.
- Update `Why.md` and `packages/app/README.md` to describe the full harness and the narrow meaning of "minimal."
- Update descriptions in the root and app `package.json` files without changing package names, repository coordinates, binaries, or publishing automation.
- Add `script/check-product-copy.ts` and the root `check:product-copy` command with assertions for this slice.

Verification:

- `bun run check:product-copy`
- `bun run check:packages`
- `bun run lint`

Review:

A fresh read-only reviewer must compare the diff with this slice, confirm clone/fork language is secondary, map every capability claim to the cited implementation, and confirm naming and compatibility identifiers are untouched before the slice is checked off.

### PR 2: Align Repository Guidance

- Update `CONTRIBUTING.md` and `packages/onboarding.md` to call OC2 a coding-agent harness or codebase rather than a template.
- Update `SECURITY.md` only where OpenCode incorrectly names the current product; preserve its no-sandbox and server-authentication warnings verbatim in meaning.
- Document the current embedded-browser-assets and hosted-fallback behavior in `README.md` and `packages/onboarding.md` without changing `packages/opencode/src/server/shared/ui.ts`.
- Extend `check:product-copy` with the maintainer-doc paths and prohibited phrases covered by this slice.

Verification:

- `bun run check:product-copy`
- `bun run lint`

Review:

A fresh read-only reviewer must verify that current runtime behavior is described accurately, security warnings remain intact, opencode lineage is preserved, and source-development guidance does not become the product pitch before the slice is checked off.

### PR 3: Correct Provider Onboarding

- Replace the free-model/bundled-provider claim in `packages/app/src/i18n/en.ts` with user-configured credential or local-provider guidance.
- Apply the same correction to `packages/tui/src/feature-plugins/sidebar/footer.tsx`.
- Audit changed onboarding flows for claims about provider availability; do not rename providers or change authentication behavior.
- Extend `check:product-copy` with path-specific assertions for the corrected messages.

Verification:

- `bun run check:product-copy`
- `bun run --cwd packages/app typecheck`
- `bun run --cwd packages/tui typecheck`

Review:

A fresh read-only reviewer must confirm the copy matches provider behavior, does not imply offline or bundled inference, and leaves provider/authentication logic unchanged before the slice is checked off.

### PR 4: Align Model-Facing Identity And Help

- Replace stale current-product identity in the provider prompt files under `packages/opencode/src/session/prompt/` while retaining provider-specific instructions.
- Replace hosted documentation instructions in `packages/opencode/src/session/prompt/default.txt` and `anthropic.txt` with built-in help/action discovery, `oc2 --help`, and the stable issue tracker.
- Update stale current-product prose in `packages/core/src/plugin/command/initialize.txt`, `packages/opencode/src/command/template/initialize.txt`, and built-in skill display guidance.
- Preserve the `customize-opencode` skill ID, ACP names, client aliases, Effect tags, and other compatibility identifiers.
- Extend `check:product-copy` with path-specific prompt and guidance assertions.

Verification:

- `bun run check:product-copy`
- `bun run --cwd packages/opencode typecheck`
- `bun run --cwd packages/core typecheck`

Review:

A fresh read-only reviewer must inspect only changed prose and the curated compatibility inventory, confirm provider-specific prompt behavior remains intact, and reject blind identifier replacement before the slice is checked off.

## Future Work

- Execute the hosted-service removal plan in `specs/minimal-coding-agent-harness-prune.md`, including removal of the `app.oc2.ai` fallback and fully local browser behavior.
- Design a versioned migration if package scope, executable, config namespace, domains, persisted state, or release artifacts are renamed.
- Add offline bootstrap and local-model-provider documentation. "Runs locally" does not mean offline in this pass.
- Commission new visual assets only if `OC2` itself is renamed later.

## Open Questions

- Should the README call the category "minimal coding agent" or "minimal coding-agent harness"? Default: use "minimal coding-agent harness" because it communicates a runnable system rather than a single model or starter repository.
- Should product docs mention experimental team orchestration in the primary capability list? Default: mention it after the core agent loop, not in the elevator pitch.