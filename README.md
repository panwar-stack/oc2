<div align="center">

# OC2

A focused coding-agent harness with persistent sessions, provider choice, and permission-gated tools.

![OC2 coding agent interface](./packages/app/public/social-share.png)

</div>

OC2 is an independent project based on and inspired by [opencode](https://github.com/anomalyco/opencode). It is not an official opencode distribution. The agent runtime, session orchestration, tools, and persistence run locally by default; model requests go to your configured provider and may leave your machine.

## Install

The verified installation path is to build from source. It requires [Git](https://git-scm.com/) and Bun 1.3.14.

```bash
git clone https://github.com/panwar-stack/oc2.git
cd oc2
bun install --frozen-lockfile
bun run dev:build
```

The executable is written to `packages/opencode/dist/oc2-<platform>/bin/oc2`. Configure a [model provider](./docs/providers.md), then start the terminal UI in a workspace:

```bash
packages/opencode/dist/oc2-*/bin/oc2 providers login
packages/opencode/dist/oc2-*/bin/oc2 .
```

OC2 does not bundle model access.

## Highlights

Recent additions in this [fork](https://github.com/panwar-stack/oc2) include:

- **Agent teams:** experimental persistent shared tasks, dependency-aware workers, plan approval, daemon teammates, and `/use-team` or `/spawn` workflows.
- **Multi-model orchestration:** Local Fusion plus the optional Fugu virtual model for combining model work.
- **Repository memory:** opt-in commit and file-summary indexing with CLI and tool access.
- **Multi-root sessions:** additional repository roots with file-tool boundaries preserved.
- **Structural search:** OpenGrep-compatible search when available, with ordinary grep as a fallback.
- **Scalable TUI:** deferred startup and virtualized session, diff, and selection views.

## Common Workflows

Use the built executable as `oc2` below, or replace it with its full path:

```bash
oc2 .                              # Open the interactive TUI
oc2 run "Explain this repository" # Run a one-shot prompt
oc2 attach http://localhost:4096   # Attach to an OC2 server
oc2 serve --port 4096              # Start the headless HTTP server
oc2 web --port 4096                # Start the server and browser client
```

Set `OC2_SERVER_PASSWORD` before exposing `serve` or `web` beyond a trusted local machine.

## Documentation

- [CLI reference](./docs/cli.md)
- [TUI guide](./docs/tui.md)
- [Configuration](./docs/configuration.md)
- [Providers](./docs/providers.md)
- [Agents and permissions](./docs/agents-permissions.md)
- [Extensions: MCP, plugins, and skills](./docs/extensions.md)
- [Environment variables](./docs/reference/environment.md)
- [Keybindings](./docs/reference/keybindings.md)

## Browser And Source Development

Release binaries embed the browser assets used by `oc2 web`. If those assets are missing or disabled, OC2 returns a local `503`; it does not proxy to a hosted application.

For browser-interface development, run the backend and Vite app as separate processes:

```bash
# Terminal 1
bun dev serve --port 4096

# Terminal 2
bun run --cwd packages/app dev -- --port 4444
```

Open `http://localhost:4444`; by default, the app targets the backend at `http://localhost:4096`. Other source commands use `bun dev`, such as `bun dev .` and `bun dev run "Explain this repository"`.

## Contributing And License

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development workflow and [packages/onboarding.md](./packages/onboarding.md) for the workspace map. OC2 is available under the [MIT License](./LICENSE).
