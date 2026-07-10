# OC2

OC2 is a minimal coding-agent harness that runs a complete agent loop with configurable model providers and agents, persistent sessions, and permission-gated tools.

For a local workspace, the OC2 process, session orchestration, filesystem and tool execution, and persistence run on your machine by default. Attach, remote, and provider tools can connect to other systems. Model calls go to the configured provider endpoint, which may be local; running OC2 locally does not imply offline operation.

OC2 is an independent project based on and inspired by [opencode](https://github.com/anomalyco/opencode). It is not an official opencode distribution.

After installing or building the `oc2` binary, start the interactive terminal UI in the current directory:

```bash
oc2 .
```

## Run OC2

The primary interfaces are available from the same executable:

```bash
oc2 .                              # Interactive terminal UI
oc2 run "Explain this repository" # One-shot execution
oc2 serve --port 4096              # Headless HTTP server
oc2 web --port 4096                # Server and browser client
```

Configure credentials for a model provider before starting a model-backed session:

```bash
oc2 providers login
```

You can instead configure a local model provider. OC2 does not bundle free model access.

Set `OC2_SERVER_PASSWORD` before exposing `oc2 serve` or `oc2 web` beyond a trusted local machine.

## Capabilities

- Interactive TUI with `oc2 .`
- One-shot execution with `oc2 run`
- Headless server with `oc2 serve`
- Browser client with `oc2 web`
- Configurable model providers and agents
- Persistent sessions
- Permission-gated filesystem, shell, and supporting tools
- Experimental agent-team coordination for parallel, inspectable work

"Minimal" describes OC2's distribution and owner-service assumptions, not a reduced agent loop or a starter skeleton.

## Browser Behavior

Production builds embed the browser assets in the `oc2` binary. `oc2 web` starts the local OC2 server and serves those assets without contacting a hosted UI. If the embedded bundle is unavailable, the server returns a local error instead of proxying browser requests elsewhere.

For browser-interface development, run the backend and Vite app separately so the UI assets are served locally:

```bash
# Terminal 1
bun dev serve --port 4096

# Terminal 2
bun run --cwd packages/app dev -- --port 4444
```

Open `http://localhost:4444`. The app targets the local backend at `http://localhost:4096` by default. Model calls still use the provider you configure.

## Upstream Lineage

OC2 retains substantial architecture and compatibility identifiers from opencode while developing its own product direction. References to opencode in APIs, configuration compatibility, or third-party attribution do not make OC2 an official upstream release.

## Develop From Source

Source development requires [Bun](https://bun.sh) 1.3.14, matching the root `packageManager` field, and Git.

```bash
git clone https://github.com/panwar-stack/oc2.git
cd oc2
bun install --frozen-lockfile
```

Clone and fork workflows belong to source development and distribution customization; they are not OC2's primary product value.

Use the development entrypoint for the same core interfaces:

```bash
bun dev .
bun dev run "Explain this repository"
bun dev serve --port 4096
bun dev web --port 4096
```

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

## Workspace

- `packages/opencode`: primary product package and `oc2` CLI entrypoint
- `packages/core`: shared runtime and domain services
- `packages/cli`: Effect-based CLI package
- `packages/tui`: Solid/OpenTUI terminal interface
- `packages/app`: Solid/Vite browser interface
- `packages/server`: typed HTTP API
- `packages/sdk/js`: generated JavaScript API client
- `packages/plugin`: plugin authoring API
- `packages/llm`: provider-neutral model protocol and streaming runtime
- `packages/ui`: shared UI components and TUI assets

## License

MIT
