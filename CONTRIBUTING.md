# Contributing To OC2

This repository is a local-first template. Contributions should preserve the local CLI, TUI, browser app, server, SDK, plugin, and LLM workflows without introducing a dependency on an OC2-hosted service.

Good contribution targets include bug fixes, provider support, LSP and formatter support, terminal or app usability, model/runtime correctness, platform-specific fixes, tests, and documentation.

## Development Setup

Use the Bun version declared by the root `packageManager` field.

```bash
bun install --frozen-lockfile
bun dev .
```

`bun dev` runs the primary CLI from `packages/opencode`. Pass another directory to open the TUI for that project:

```bash
bun dev /path/to/project
```

Useful local commands:

```bash
bun dev --help
bun dev serve --port 4096
bun dev web --port 4096
bun dev run "Summarize the current changes"
```

Set `OC2_SERVER_PASSWORD` when the local server is reachable by anything you do not trust.

## Browser App Development

Run the backend and Vite app in separate terminals so app changes reload directly:

```bash
# Terminal 1, from the repository root
bun dev serve --port 4096

# Terminal 2, from the repository root
bun run --cwd packages/app dev -- --port 4444
```

Open `http://localhost:4444`. The app uses `http://localhost:4096` as its default local backend.

For UI changes, verify both desktop and narrow/mobile layouts. Include before-and-after screenshots or a short recording in the pull request when the behavior is visual.

## Workspace Guide

Read [packages/onboarding.md](./packages/onboarding.md) before choosing a package. Then inspect the nearest `AGENTS.md`, `package.json`, source, and tests. Important boundaries include:

- `packages/opencode` owns the primary product runtime and CLI entrypoint.
- `packages/core` owns reusable domain and runtime services.
- `packages/cli` and `packages/tui` own the Effect CLI and terminal presentation layers.
- `packages/server` owns the typed local HTTP API.
- `packages/app` and `packages/ui` own browser and shared presentation code.
- `packages/llm` owns provider-neutral model protocols and streaming.
- `packages/sdk/js` and `packages/plugin` expose client and extension surfaces.

Keep changes in the narrowest package that owns the behavior. Do not duplicate core rules in a presentation package or add product-specific behavior to the generic Effect/SQLite helpers.

## Verification

Run tests from the package directory, not from the repository root. Run `bun typecheck` in the package you changed, and do not invoke `tsc` directly.

Examples:

```bash
bun run --cwd packages/opencode typecheck
bun run --cwd packages/opencode test
bun run --cwd packages/opencode test:httpapi

bun run --cwd packages/core typecheck
bun run --cwd packages/core test

bun run --cwd packages/llm typecheck
bun run --cwd packages/llm test

bun run --cwd packages/tui typecheck
bun run --cwd packages/tui test

bun run --cwd packages/app typecheck
bun run --cwd packages/app test:ci
bun run --cwd packages/app build
```

Before submitting a repository-wide change, run the applicable root checks:

```bash
bun run lint
bun run check:packages
bun run check:generated
bun run typecheck
```

The root `test` script intentionally fails because package test environments differ.

### Generated API Files

Changes to server routes or schemas may require OpenAPI and JavaScript SDK regeneration:

```bash
./packages/sdk/js/script/build.ts
bun run check:generated
bun run --cwd packages/sdk/js typecheck
```

Review generated diffs together with the server change. Do not manually patch generated clients.

### Standalone Build

Build and smoke-test the current platform executable with:

```bash
bun run dev:build
```

The result is under `packages/opencode/dist/oc2-<platform>/bin/oc2`.

## Debugging

Run Bun with an inspector URL and attach your debugger:

```bash
bun run --inspect=ws://localhost:6499/ dev .
```

If TUI worker boundaries prevent a breakpoint from firing, debug the server separately and attach a client:

```bash
bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts serve --port 4096
bun dev attach http://localhost:4096
```

Use `--inspect-wait` or `--inspect-brk` when execution must pause before startup.

## Pull Request Expectations

- Keep each pull request small and focused.
- Explain the problem, the reason for the chosen fix, and any tradeoffs.
- State exactly what you ran to verify the change.
- Add or update tests for behavior changes where practical.
- Call out generated files, migrations, compatibility effects, or follow-up work.
- Avoid unrelated cleanup and generated walls of text.

Use `type(scope): words` for titles. Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`.

Examples:

- `fix(tui): preserve prompt focus`
- `feat(llm): add provider protocol`
- `docs(core): explain local storage`
- `test(server): cover permission denial`

## Code Style

Follow [AGENTS.md](./AGENTS.md) and any package-specific instructions. In particular:

- Prefer the smallest safe change.
- Keep logic in one function unless reuse or clarity justifies extraction.
- Use precise types and avoid `any`.
- Prefer immutable values, early returns, and Bun APIs where they fit.
- Avoid unnecessary destructuring, compatibility layers, and comments.
- Keep provider-specific behavior behind shared provider-neutral interfaces.

New product features should begin with a focused design discussion or spec so ownership, behavior, and verification are clear before implementation.
