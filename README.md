# OC2 Local Template

OC2 is an AI coding agent template designed to run from a local clone. The repository keeps the core runtime, command-line interface, terminal UI, browser app, local HTTP server, SDK, plugin API, and provider-neutral LLM packages.

The template does not depend on an OC2-hosted account, sharing service, managed model provider, documentation site, or hosted app fallback. Model calls still use the providers you configure with your own credentials.

## Requirements

- [Bun](https://bun.sh) 1.3.14, matching the root `packageManager` field
- Git

## Start From A Clone

```bash
git clone <repository-url> oc2-local
cd oc2-local
bun install --frozen-lockfile
```

Launch the terminal UI for a project directory:

```bash
bun dev /path/to/project
```

Use `bun dev .` to work on this repository itself. Run `bun dev --help` to inspect the complete CLI surface.

Configure a model provider with your own credentials before starting a model-backed session:

```bash
bun dev providers login
```

## Local Interfaces

The development entrypoint and a built `oc2` binary expose the same primary commands:

```bash
bun dev <directory>            # Terminal UI
bun dev run "Explain this repo" # Non-interactive prompt
bun dev serve --port 4096      # Headless local API server
bun dev web --port 4096        # Local server and embedded browser app
```

For browser UI development, run the backend and Vite app separately:

```bash
# Terminal 1
bun dev serve --port 4096

# Terminal 2
bun run --cwd packages/app dev -- --port 4444
```

Open `http://localhost:4444`. The app targets the local backend at `http://localhost:4096` by default.

Set `OC2_SERVER_PASSWORD` before exposing the server beyond a trusted local machine.

## Build And Verify

Build a standalone executable for the current platform:

```bash
bun run dev:build
```

The binary is written under `packages/opencode/dist/oc2-<platform>/bin/oc2`.

Repository-wide checks:

```bash
bun run lint
bun run check:packages
bun run check:generated
bun run typecheck
```

Tests must run from the package that owns them, not from the repository root. For example:

```bash
bun run --cwd packages/opencode test
bun run --cwd packages/llm test
bun run --cwd packages/tui test
bun run --cwd packages/app test:unit
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and [packages/onboarding.md](./packages/onboarding.md) for the workspace map.

## Retained Workspace

- `packages/opencode`: primary product package and `oc2` CLI entrypoint
- `packages/core`: shared local runtime and domain services
- `packages/cli`: Effect-based CLI package
- `packages/tui`: Solid/OpenTUI terminal interface
- `packages/app`: Solid/Vite local browser interface
- `packages/server`: typed local HTTP API
- `packages/sdk/js`: generated JavaScript API client
- `packages/plugin`: plugin authoring API
- `packages/llm`: provider-neutral model protocol and streaming runtime
- `packages/ui`: shared UI components and TUI assets

The repository is intentionally a starting point. Fork owners should replace package names, metadata, and release automation to match their own distribution plans.

## License

MIT
