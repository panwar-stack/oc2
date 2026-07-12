# CLI Reference

The shipped command-line interface is `oc2`, implemented by `packages/opencode`. The separate `packages/cli` package is a preview CLI and is not the primary product described here.

Use `oc2 --help` or `oc2 <command> --help` for the exact options supported by your installed version. Parsing is strict: unknown options and invalid arguments exit with an error. Help and parser output may be written to stderr, so scripts that capture help should capture both stdout and stderr.

## Global Options

| Option                | Purpose                                  |
| --------------------- | ---------------------------------------- |
| `-h`, `--help`        | Show help.                               |
| `-v`, `--version`     | Show the version.                        |
| `--print-logs`        | Print logs to stderr.                    |
| `--log-level <level>` | Set `DEBUG`, `INFO`, `WARN`, or `ERROR`. |
| `--pure`              | Run without external plugins.            |

`oc2 completion` generates a shell completion script.

See the [environment reference](./reference/environment.md) for supported environment variables. Configuration files and their precedence are documented in the [configuration guide](./configuration.md).

## Start The TUI

With no command, `oc2` starts the terminal UI:

```bash
oc2 [project]
```

`project` selects the starting directory. The default invocation accepts:

| Option                                                      | Purpose                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `-m`, `--model <provider/model>`                            | Select a model.                                                          |
| `--agent <name>`                                            | Select an agent.                                                         |
| `-c`, `--continue`                                          | Continue the most recent session.                                        |
| `-s`, `--session <id>`                                      | Continue a specific session.                                             |
| `--fork`                                                    | Fork while continuing. Requires `--continue` or `--session`.             |
| `--prompt <text>`                                           | Submit an initial prompt. Piped stdin is appended when both are present. |
| `--port`, `--hostname`, `--mdns`, `--mdns-domain`, `--cors` | Configure the TUI's local server transport.                              |

For interactive workflows, see the [TUI guide](./tui.md).

## Run A Prompt

`oc2 run` runs non-interactively by default, streams formatted output, and exits when the session becomes idle.

```bash
oc2 run "Explain this repository"
printf 'Review this diff' | oc2 run
git diff | oc2 run "Find correctness issues"
oc2 run --format json "List the relevant files"
```

When stdin is piped, its contents become the message. If message arguments are also supplied, the argument text is followed by the piped content. Other useful options include `--file`, `--model`, `--agent`, `--variant`, `--title`, `--dir`, and `--attach`.

Resume with `--continue` or `--session <id>`. `--fork` creates a fork before continuing and is rejected unless one of those resume options is present.

`--command <name>` executes a configured command and uses the message as its arguments. `--interactive` starts the direct split-footer interface; its compatible options are shown by `oc2 run --help`. `--dangerously-skip-permissions` auto-approves requests that are not explicitly denied and should only be used in a trusted environment.

## Common Commands

| Command                  | Purpose                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `oc2 attach <url>`       | Open the TUI against a running OC2 server.                       |
| `oc2 completion`         | Generate a shell completion script.                              |
| `oc2 run [message...]`   | Run a prompt, configured command, or direct interactive session. |
| `oc2 serve`              | Start a headless HTTP server.                                    |
| `oc2 web`                | Start a server and open its browser UI.                          |
| `oc2 models [provider]`  | List available models, optionally for one provider.              |
| `oc2 providers`          | List, log in to, or log out of providers. Alias: `oc2 auth`.     |
| `oc2 agent`              | Create or list agents.                                           |
| `oc2 session`            | List or delete sessions.                                         |
| `oc2 mcp`                | Add, list, authenticate, log out, or debug MCP servers.          |
| `oc2 plugin <module>`    | Install a plugin and update configuration. Alias: `oc2 plug`.    |
| `oc2 memory`             | Index, inspect, search, or clear repository memory.              |
| `oc2 export [sessionID]` | Write a session export as JSON.                                  |
| `oc2 import <file>`      | Import a session JSON file.                                      |
| `oc2 stats`              | Show token usage and cost statistics.                            |
| `oc2 upgrade [target]`   | Upgrade to the latest or a specified version.                    |
| `oc2 uninstall`          | Remove OC2, with options to retain configuration or data.        |

Provider setup is covered in [Providers](./providers.md). For agents and permission policy, see [Agents And Permissions](./agents-permissions.md). MCP and plugin configuration belongs to [Extensions](./extensions.md).

Repository memory must be indexed before it can return repository-specific results. Start with `oc2 memory index`, inspect it with `oc2 memory status`, and use `oc2 memory --help` for the available search and inspection groups. Memory evaluation commands are intended for development and benchmarking rather than ordinary use.

## Command Details

### Attach

`oc2 attach <url>` opens the TUI against an existing server. Use `--dir <path>` for its working directory, `--continue` or `--session <id>` to resume, and `--fork` only with one of those resume options. Basic authentication accepts `--username` and `--password`; their defaults come from `OC2_SERVER_USERNAME` and `OC2_SERVER_PASSWORD`.

### Agents And Sessions

`oc2 agent create` interactively creates an agent definition, while `oc2 agent list` lists agents resolved for the current project. Agent fields, Markdown files, and permission policy are owned by [Agents And Permissions](./agents-permissions.md).

`oc2 session list` lists stored sessions and `oc2 session delete <sessionID>` deletes one. Use command-specific help for list filters and output details.

### Import And Export

`oc2 export [sessionID]` writes the export JSON to stdout and status messages to stderr, so stdout can be redirected safely. Without an ID it offers session selection. Add `--sanitize` to redact sensitive transcript and file data. `oc2 import <file>` imports a session JSON file and prints the imported session ID.

### Statistics And Maintenance

`oc2 stats` reports token usage and cost. `--days <n>` limits the time range, `--tools <n>` limits tool rows, `--models [n]` includes model statistics, and `--project <id>` selects a project; an empty project value selects the current project.

`oc2 upgrade [target]` upgrades to the latest release or a version such as `1.2.3` or `v1.2.3`. `--method` can select `curl`, `npm`, `pnpm`, `bun`, `brew`, `choco`, or `scoop` when that installation method is available.

`oc2 uninstall` removes OC2 after confirmation. Use `--dry-run` to inspect the removal, `--keep-config` or `--keep-data` to retain those files, and `--force` to skip confirmation.

### Repository Memory

The memory command groups are `index`, `status`, `search`, `view`, `examine`, `clear`, and `eval`. Index first, use `status` to inspect coverage, and use command-specific help for query and filtering options. `eval` is a development and benchmarking workflow rather than ordinary repository search.

## Server And Browser Workflows

`oc2 serve` starts the API without opening a browser. `oc2 web` starts the same local server, prints an access URL, and attempts to open it. Both accept the network options `--port`, `--hostname`, `--mdns`, `--mdns-domain`, and repeatable `--cors` values. Set server authentication before exposing either command outside a trusted local environment; see the [environment reference](./reference/environment.md).

Release binaries embed browser assets. If those assets are disabled or unavailable, browser routes return a local `503` response; OC2 does not proxy them to a hosted application.

Source development uses the backend and Vite app as separate processes:

```bash
# Terminal 1, from the repository root
bun dev serve --port 4096

# Terminal 2, from the repository root
bun run --cwd packages/app dev -- --port 4444
```

Open `http://localhost:4444`; the development app targets the backend at `http://localhost:4096` by default. `bun dev web` starts the source backend but does not turn it into a release build with embedded assets.

## Advanced Commands

These commands are for integrations, repository maintenance, diagnostics, or code generation. Their output and behavior are less suitable for stable automation than the normal workflows above. Confirm availability and syntax with `oc2 --help` and command-specific help; hidden or feature-gated commands may not appear or operate in every build or configuration.

| Command           | Purpose                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `oc2 acp`         | Serve the Agent Client Protocol over stdin and stdout.                                                             |
| `oc2 pr <number>` | Use the GitHub CLI to check out a PR branch, then start OC2.                                                       |
| `oc2 db`          | Open the OC2 SQLite database or execute a query.                                                                   |
| `oc2 debug`       | Run troubleshooting utilities for configuration, files, LSP, snapshots, startup, and related internals.            |
| `oc2 generate`    | Generate the OpenAPI document used by repository tooling. This command is registered but omitted from normal help. |

Use `oc2 db path` before database inspection, and avoid modifying the database while OC2 is running.
