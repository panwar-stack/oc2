# CLI Reference

The shipped command-line interface is `oc2`, implemented by `packages/opencode`. The separate `packages/cli` package is a preview CLI and is not described here.

Parsing is strict: unknown options and invalid arguments exit with an error. Help and parser output may be written to stderr, so scripts that capture help should capture both stdout and stderr. Use `oc2 --help` to confirm the interface provided by an older installed version.

## Syntax

- `<value>` is required; `[value]` is optional; `value...` accepts multiple words.
- Options marked repeatable may be supplied more than once.
- `--` ends option parsing. It is required before a local MCP server command and may also pass message words to `oc2 run`.
- Boolean options can be enabled with `--option`. Options documented as supporting negation can be disabled with `--no-option`.
- Short aliases are shown beside their long names, for example `-n, --max-count`.

## Usage

```text
Usage:
  oc2 [project] [options]
  oc2 <command> [options]

Commands:
  oc2 run [message...]              Run a prompt, command, or direct interactive session
  oc2 attach <url>                  Open the TUI against a running OC2 server
  oc2 serve                         Start a headless HTTP server
  oc2 web                           Start a server and open its browser UI
  oc2 models [provider]             List available models
  oc2 providers <command>           Manage provider credentials (alias: auth)
  oc2 agent <command>               Create or list agents
  oc2 session <command>             List or delete sessions
  oc2 mcp <command>                 Manage MCP servers
  oc2 plugin <module>               Install a plugin (alias: plug)
  oc2 memory <command>              Manage repository memory
  oc2 export [sessionID]            Export a session as JSON
  oc2 import <file>                 Import a session from JSON
  oc2 stats                         Show token usage and cost statistics
  oc2 completion                    Generate a shell completion script
  oc2 upgrade [target]              Upgrade OC2
  oc2 uninstall                     Remove OC2 and its files

Advanced and integration commands:
  oc2 acp                           Serve ACP over stdin/stdout
  oc2 pr <number>                   Check out a GitHub PR and start OC2
  oc2 db [query]                    Open or query the OC2 database
  oc2 db path                       Print the database path
  oc2 debug <command>               Run troubleshooting utilities
  oc2 generate                      Generate the repository OpenAPI document

Global options:
  -h, --help                        Show help
  -v, --version                     Show the version
      --print-logs                  Print logs to stderr
      --log-level <level>           DEBUG, INFO, WARN, or ERROR
      --pure                        Run without external plugins
```

Global options are accepted with every command. See the [environment reference](./reference/environment.md) for environment variables and the [configuration guide](./configuration.md) for configuration files and precedence.

## Default TUI

With no command, `oc2` starts the terminal UI.

```text
Usage:
  oc2 [project] [options]
```

`project` is the directory in which to start. It defaults to the current directory.

| Option                         | Description                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `-m, --model <provider/model>` | Select a model.                                                                                                      |
| `--agent <name>`               | Select an agent.                                                                                                     |
| `-c, --continue`               | Continue the most recent session.                                                                                    |
| `-s, --session <id>`           | Continue a specific session.                                                                                         |
| `--fork`                       | Fork the continued session. Requires `--continue` or `--session`.                                                    |
| `--prompt <text>`              | Submit an initial prompt. Piped stdin is prepended when both are present.                                            |
| `--port <number>`              | Local server port. Default: `0` (a random available port).                                                           |
| `--hostname <name>`            | Local server bind hostname. Default: `127.0.0.1`.                                                                    |
| `--mdns`                       | Enable mDNS discovery. Default: `false`; when enabled without a configured hostname, the hostname becomes `0.0.0.0`. |
| `--mdns-domain <name>`         | mDNS service domain. Default: `oc2.local`.                                                                           |
| `--cors <origin>`              | Add an allowed CORS origin. Repeatable; default: none.                                                               |

```bash
oc2 .
oc2 --continue
oc2 --session ses_abc123 --fork
printf 'Start by checking the failing tests' | oc2 --prompt 'Fix the bug'
```

See the [TUI guide](./tui.md) for interactive features and key bindings.

## Run

`oc2 run` runs non-interactively by default, streams formatted output, and exits when the session becomes idle.

```text
Usage:
  oc2 run [message...] [options]
```

| Option                           | Description                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--command <name>`               | Run a configured command, using `message...` as its arguments.                                                |
| `-c, --continue`                 | Continue the most recent session.                                                                             |
| `-s, --session <id>`             | Continue a specific session.                                                                                  |
| `--fork`                         | Fork before continuing. Requires `--continue` or `--session`.                                                 |
| `-m, --model <provider/model>`   | Select a model.                                                                                               |
| `--agent <name>`                 | Select an agent.                                                                                              |
| `--format <format>`              | Output `default` text, raw `json` events, or one automation `result-json` object. Default: `default`.         |
| `-f, --file <path>`              | Attach a file to the message. Repeatable.                                                                     |
| `--title [text]`                 | Set the session title; bare or empty uses a truncated prompt. Omission leaves title generation to the server. |
| `--attach <url>`                 | Connect to a running OC2 server instead of starting an in-process server.                                     |
| `-p, --password <value>`         | Basic-auth password. Default: `OC2_SERVER_PASSWORD`.                                                          |
| `-u, --username <value>`         | Basic-auth username. Default: `OC2_SERVER_USERNAME`, then `oc2`.                                              |
| `--dir <path>`                   | Working directory; interpreted on the remote server with `--attach`.                                          |
| `--port <number>`                | Accepted but currently unused.                                                                                |
| `--variant <name>`               | Provider-specific model variant, such as `high`, `max`, or `minimal`.                                         |
| `--thinking`                     | Show thinking blocks. Default: `false` normally and `true` in interactive mode.                               |
| `--replay`, `--no-replay`        | Enable or disable interactive history replay. Default: enabled.                                               |
| `--replay-limit <number>`        | Limit interactive replay to the newest positive number of messages.                                           |
| `-i, --interactive`              | Use the direct split-footer interface. Default: `false`.                                                      |
| `--dangerously-skip-permissions` | Auto-approve permission requests not explicitly denied. Default: `false`.                                     |
| `--automation`                   | Require an explicit identity and use fail-closed execution and output handling. Default: `false`.             |
| `--demo`                         | Enable direct-interactive demo slash commands. Default: `false`.                                              |

Piped stdin becomes the message. When message arguments are also present, their text is followed by the piped content. For local runs, relative `--file` paths are resolved after changing to `--dir`. With `--attach`, they are resolved against the original local root while `--dir` is interpreted on the remote server.

Interactive mode requires a TTY on stdout. It cannot be combined with `--command`, `--automation`, or `--format json`; `--replay-limit` and `--demo` require interactive mode. Only use `--dangerously-skip-permissions` in a trusted environment.

Automation mode requires explicit `--agent`, `--model`, and `--variant` values. It rejects `--dangerously-skip-permissions` and raw `--format json`, and suppresses `--print-logs` output. Configured-command arguments are treated literally: shell/backtick execution and implicit `@file` expansion are disabled. Repeatable `--file` options are the trusted caller's explicit attachment admission boundary and are the only files forwarded without ambient expansion; supported image and PDF types are detected from file bytes rather than trusted filename extensions.

Automation binds `spec:planner` to `issue-planner` and `spec:implement` to `issue-implementer`. The implementation command requires exactly one specification path and one positive integer slice number. Other automation commands use `issue-task`.

`--format result-json` is automation-only and writes exactly one terminal-safe JSON object. It suppresses progress, reasoning, tools, UI output, and raw provider or tool errors:

```ts
type AutomationResult =
  | { status: "ok"; sessionID: string; text: string }
  | {
      status: "error"
      sessionID: string | null
      error:
        | "invalid_input"
        | "invalid_agent"
        | "invalid_model"
        | "invalid_variant"
        | "invalid_command"
        | "permission_denied"
        | "tool_error"
        | "provider_error"
        | "session_error"
        | "cancelled"
        | "timeout"
    }
```

The process exits `0` only for `status: "ok"`, `1` for execution failures, and `2` for invalid invocation. Run automation with `--pure`, an isolated `HOME` and XDG state tree, and `OC2_DISABLE_EXTERNAL_SKILLS=1`; capture stdout and stderr, parse only the terminal result object, and remove the isolated state afterward.

```bash
oc2 run "Explain this repository"
printf 'Review this diff' | oc2 run
git diff | oc2 run "Find correctness issues"
oc2 run --format json "List the relevant files"
oc2 run -f src/index.ts -f package.json "Review these files"
oc2 run --session ses_abc123 "Continue the investigation"
oc2 run --attach http://localhost:4096 --dir /repo "Run the tests"
oc2 run --command spec:planner "Plan a retry policy for provider requests"
OC2_DISABLE_EXTERNAL_SKILLS=1 oc2 run --automation --pure --agent issue-task --model openai/gpt-5.6-sol --variant high --format result-json -- "Inspect this repository"
```

## Attach

```text
Usage:
  oc2 attach <url> [options]
```

| Option                   | Description                                                                     |
| ------------------------ | ------------------------------------------------------------------------------- |
| `--dir <path>`           | Working directory. A nonexistent local path is passed through as a remote path. |
| `-c, --continue`         | Continue the most recent session.                                               |
| `-s, --session <id>`     | Continue a specific session.                                                    |
| `--fork`                 | Fork the continued session. Requires `--continue` or `--session`.               |
| `-p, --password <value>` | Basic-auth password. Default: `OC2_SERVER_PASSWORD`.                            |
| `-u, --username <value>` | Basic-auth username. Default: `OC2_SERVER_USERNAME`, then `oc2`.                |

```bash
oc2 attach http://localhost:4096
oc2 attach https://oc2.example.com --dir /srv/project --continue
```

## Serve And Web

```text
Usage:
  oc2 serve [network options]
  oc2 web [network options]
```

`serve` starts the headless API. `web` starts the same server, prints its access URL, and attempts to open it in a browser.

| Network option         | Description                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--port <number>`      | Listen port. Default: `0` (a random available port).                                                                 |
| `--hostname <name>`    | Bind hostname. Default: `127.0.0.1`.                                                                                 |
| `--mdns`               | Enable mDNS discovery. Default: `false`; when enabled without a configured hostname, the hostname becomes `0.0.0.0`. |
| `--mdns-domain <name>` | mDNS service domain. Default: `oc2.local`.                                                                           |
| `--cors <origin>`      | Add an allowed CORS origin. Repeatable; default: none.                                                               |

Configuration may override defaults. Explicit scalar command-line values take precedence, while configured and command-line CORS origins are combined. Set `OC2_SERVER_PASSWORD` before binding outside a trusted local environment. Release binaries embed the browser assets; if unavailable, browser routes return a local `503` rather than proxying a hosted application.

```bash
oc2 serve --port 4096
oc2 web --port 4096
oc2 serve --hostname 0.0.0.0 --port 4096 --cors https://app.example.com
```

## Models And Providers

Provider setup and provider-specific behavior are covered in [Providers](./providers.md).

### Models

```text
Usage:
  oc2 models [provider] [--verbose] [--refresh]
```

| Option      | Description                                              |
| ----------- | -------------------------------------------------------- |
| `--verbose` | Include model metadata such as costs.                    |
| `--refresh` | Refresh the cache from models.dev before listing models. |

```bash
oc2 models
oc2 models anthropic
oc2 models --refresh --verbose
```

### Providers

`providers` has the top-level alias `auth`. Omitting an optional provider or method starts interactive selection.

```text
Usage:
  oc2 providers list
  oc2 providers ls
  oc2 providers login [url] [options]
  oc2 providers logout [provider]
```

`login [url]` accepts:

| Option                        | Description                                       |
| ----------------------------- | ------------------------------------------------- |
| `-p, --provider <id-or-name>` | Select a provider without prompting.              |
| `-m, --method <label>`        | Select a provider login method without prompting. |

The optional `url` is the base URL of an OC2 well-known authentication provider. It is a separate login path from `--provider`.

```bash
oc2 providers list
oc2 providers login --provider anthropic
oc2 providers logout anthropic
```

## Agents

```text
Usage:
  oc2 agent list
  oc2 agent create [options]
```

| `agent create` option                    | Description                                        |
| ---------------------------------------- | -------------------------------------------------- |
| `--path <directory>`                     | Generate under `<directory>/agents`.               |
| `--description <text>`                   | Describe what the agent should do.                 |
| `--mode <mode>`                          | `all`, `primary`, or `subagent`.                   |
| `--permissions <list>`, `--tools <list>` | Comma-separated allowed permissions. Default: all. |
| `-m, --model <provider/model>`           | Model used to generate the agent.                  |

Creation is guided unless `--path`, `--description`, `--mode`, and `--permissions` are all supplied. An explicitly empty `--permissions` value means all permissions. Available permission keys are `bash`, `read`, `edit`, `glob`, `grep`, `webfetch`, `task`, `todowrite`, `websearch`, `lsp`, `skill`. Creation fails rather than overwriting an existing agent file.

```bash
oc2 agent list
oc2 agent create
oc2 agent create --path .oc2 --description "Review database migrations" --mode subagent --permissions read,glob,grep,bash
```

See [Agents And Permissions](./agents-permissions.md) for agent files and permission policy.

## Sessions

```text
Usage:
  oc2 session list [options]
  oc2 session delete <sessionID>
```

| `session list` option      | Description                               |
| -------------------------- | ----------------------------------------- |
| `-n, --max-count <number>` | Limit output to the most recent sessions. |
| `--format <format>`        | `table` or `json`. Default: `table`.      |

Unbounded table output may open a pager when stdout is a TTY. JSON is preferable for scripts. `session delete` deletes immediately without confirmation.

```bash
oc2 session list -n 10
oc2 session list --format json
oc2 session delete ses_abc123
```

## MCP Servers

```text
Usage:
  oc2 mcp list
  oc2 mcp ls
  oc2 mcp add [name] [options] [-- command...]
  oc2 mcp auth [name]
  oc2 mcp auth list
  oc2 mcp auth ls
  oc2 mcp logout [name]
  oc2 mcp debug <name>
```

| `mcp add` option       | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `--url <url>`          | URL for a remote MCP server.                      |
| `--env <KEY=VALUE>`    | Environment entry for a local server. Repeatable. |
| `--header <KEY=VALUE>` | HTTP header for a remote server. Repeatable.      |

Running `mcp add` with no arguments starts guided setup. Non-interactive setup requires `name` and exactly one of `--url` or a command after `--`. `--env` is local-only and `--header` is remote-only. Each `KEY=VALUE` is split on its first `=`. Non-interactive setup writes the global configuration.

`mcp auth [name]` starts OAuth for a remote server; omission of `name` prompts for one. `mcp auth list` shows OAuth state, and `mcp logout [name]` removes stored OAuth credentials. `mcp debug <name>` performs verbose OAuth and connection diagnostics and may display partial credential metadata; treat its output as sensitive.

```bash
oc2 mcp add github --url https://example.com/mcp --header 'Authorization=Bearer {env:GITHUB_TOKEN}'
oc2 mcp add local --env API_KEY=secret -- npx -y @example/server
oc2 mcp list
oc2 mcp auth github
oc2 mcp auth list
oc2 mcp logout github
```

See [Extensions](./extensions.md) for MCP configuration and authentication details.

## Plugins

```text
Usage:
  oc2 plugin <module> [options]
  oc2 plug <module> [options]
```

| Option         | Description                                                      |
| -------------- | ---------------------------------------------------------------- |
| `-g, --global` | Install in global configuration. Default: `false`.               |
| `-f, --force`  | Replace an existing configured plugin version. Default: `false`. |

This command installs dependencies and edits configuration; it is not read-only.

```bash
oc2 plugin @scope/package
oc2 plug @scope/package --global
oc2 plugin @scope/package@latest --force
```

See [Extensions](./extensions.md) for plugin loading and configuration.

## Repository Memory

Index the current Git repository before searching it.

```text
Usage:
  oc2 memory index [options]
  oc2 memory status
  oc2 memory search commit <query> [--limit <number>]
  oc2 memory search summary <query> [--limit <number>]
  oc2 memory view summary <path>
  oc2 memory examine commit <hash> [--max-diff-bytes <number>]
  oc2 memory clear [--repository <identity>]
```

| Command                 | Options and behavior                                                                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory index`          | `--max-commits <number>` (default `7000`), `--since <git-date>`, `--base-commit <hash>` (exclusive), `--cutoff-time <ISO-time>` (exclusive), `--branch <revision>`, `--github`/`--no-github` (default enabled), and `--summaries <number>` (default `200`; `0` skips summaries). |
| `memory status`         | Show commit, file-activity, and summary counts for the current repository.                                                                                                                                                                                                       |
| `memory search commit`  | Search indexed commits; `--limit` defaults to `20`.                                                                                                                                                                                                                              |
| `memory search summary` | Search cached file summaries; `--limit` defaults to `5`.                                                                                                                                                                                                                         |
| `memory view summary`   | Print one cached summary and whether it is current, stale, or missing.                                                                                                                                                                                                           |
| `memory examine commit` | Print an indexed historical diff; `--max-diff-bytes` defaults to `50000`.                                                                                                                                                                                                        |
| `memory clear`          | Delete the selected repository index. `--repository` defaults to the current repository identity.                                                                                                                                                                                |

GitHub enrichment is enabled by default but indexing remains offline-safe. Use `--no-github --summaries 0` to avoid network enrichment and model-generated summaries. Historical diffs and summaries may be stale; verify them against the current working tree. `memory clear` is destructive and does not prompt.

```bash
oc2 memory index
oc2 memory index --no-github --summaries 0
oc2 memory status
oc2 memory search commit "session retry"
oc2 memory search summary "provider authentication"
oc2 memory examine commit abc123 --max-diff-bytes 20000
oc2 memory view summary packages/opencode/src/index.ts
oc2 memory clear
```

The development-only `memory eval` command is documented under [Advanced And Internal Commands](#advanced-and-internal-commands).

## Import And Export

```text
Usage:
  oc2 export [sessionID] [--sanitize]
  oc2 import <file>
```

`export` writes JSON to stdout and status or interactive selection to stderr. Without a session ID, it prompts for a session. `--sanitize` redacts sensitive transcript and file data.

`import` reads an exported JSON file, assigns the session to the current project and directory, and prints its ID. A conflicting session ID is upserted for the current location; existing message and part rows are not overwritten.

```bash
oc2 export ses_abc123 --sanitize > session.json
oc2 import session.json
```

## Statistics

```text
Usage:
  oc2 stats [options]
```

| Option              | Description                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `--days <number>`   | Last N days. Default: all time; `0` means today.                                         |
| `--tools <number>`  | Maximum tool rows. Default: all.                                                         |
| `--models [number]` | Show model statistics; an optional number limits the rows. Default: hidden.              |
| `--project <id>`    | Filter by project ID. Default: all projects; an empty value selects the current project. |

```bash
oc2 stats --days 30 --tools 10 --models 5
oc2 stats --project ''
```

## Completion

```text
Usage:
  oc2 completion
```

This yargs-provided command writes a shell completion script to stdout. Its generated interface is implementation-defined; regenerate the script after upgrading OC2.

```bash
oc2 completion > /tmp/oc2-completion
```

## Upgrade And Uninstall

### Upgrade

```text
Usage:
  oc2 upgrade [target] [-m, --method <method>]
```

`target` accepts versions with or without a leading `v`. Without it, OC2 resolves the latest version. `--method` accepts `curl`, `npm`, `pnpm`, `bun`, `brew`, `choco`, or `scoop`; otherwise OC2 detects the installation method.

```bash
oc2 upgrade
oc2 upgrade v1.2.3
oc2 upgrade --method brew
```

### Uninstall

```text
Usage:
  oc2 uninstall [options]
```

| Option              | Description                                                       |
| ------------------- | ----------------------------------------------------------------- |
| `-c, --keep-config` | Keep configuration files. Default: `false`.                       |
| `-d, --keep-data`   | Keep session data and snapshots. Default: `false`.                |
| `--dry-run`         | Show what would be removed without removing it. Default: `false`. |
| `-f, --force`       | Skip confirmation. Default: `false`.                              |

Start with a dry run. `--force` can remove the binary, state, cache, and any data or configuration not explicitly retained without confirmation.

```bash
oc2 uninstall --dry-run
oc2 uninstall --keep-config --keep-data
```

## Advanced And Internal Commands

These surfaces support integrations, diagnostics, development, or repository maintenance. They are not all intended as stable automation interfaces.

### ACP

```text
Usage:
  oc2 acp [--cwd <path>] [network options]
```

`acp` serves the Agent Client Protocol as NDJSON over stdin and stdout; it is integration plumbing rather than a human-interactive command. `--cwd` defaults to the current directory. It also accepts all [Serve And Web](#serve-and-web) network options with the same defaults.

```bash
oc2 acp --cwd /repo
```

### Pull Requests

```text
Usage:
  oc2 pr <number>
```

This command requires an authenticated GitHub CLI. It force-checks out the PR into `pr/<number>`, may add a fork remote, and then starts OC2. It mutates the current repository and can replace an existing local PR branch.

### Database

```text
Usage:
  oc2 db [query] [--format <format>]
  oc2 db path
```

`oc2 db` without a query opens the external `sqlite3` shell. With a query it executes arbitrary raw SQL; `--format` is `tsv` (default) or `json`. Raw SQL can corrupt OC2 data. Prefer `oc2 db path` for inspection and do not modify the database while OC2 is running.

```bash
oc2 db path
oc2 db "SELECT name FROM sqlite_master WHERE type = 'table'" --format json
```

### Memory Evaluation

```text
Usage:
  oc2 memory eval --issues <file> [--max-commits <number>] [--summaries <number>]
```

This development and benchmarking command evaluates repository-memory localization against historical issues. `--issues` is required; `--max-commits` defaults to `7000`, and `--summaries` defaults to `200` (`0` skips summaries).

```bash
oc2 memory eval --issues fixtures/issues.json --summaries 0
```

### Debug

`debug` exposes low-level troubleshooting utilities. Outputs and subcommands may change with internal implementation details.

```text
Usage:
  oc2 debug config
  oc2 debug scrap
  oc2 debug skill
  oc2 debug startup
  oc2 debug v2
  oc2 debug info
  oc2 debug paths
  oc2 debug wait
  oc2 debug agent <name> [--tool <id>] [--params <value>]

  oc2 debug lsp diagnostics <file>
  oc2 debug lsp symbols <query>
  oc2 debug lsp document-symbols <uri>

  oc2 debug rg tree [--limit <number>]
  oc2 debug rg files [--query <text>] [--glob <pattern>] [--limit <number>]
  oc2 debug rg search <pattern> [--glob <pattern>...] [--limit <number>]

  oc2 debug file read <path>
  oc2 debug file list <path>
  oc2 debug file search <query>
  oc2 debug file tree [dir]

  oc2 debug snapshot track
  oc2 debug snapshot patch <hash>
  oc2 debug snapshot diff <hash>
```

`debug file tree` defaults to the current directory. `debug rg files --query` is accepted but currently ignored. `debug rg search --glob` is repeatable. For `debug agent`, `--params` accepts JSON or a JavaScript object literal and `--tool` executes a tool, so only use it with trusted input. `debug wait` intentionally waits indefinitely. Snapshot, startup, scrap, and `v2` commands exist for internal troubleshooting rather than normal workflows.

```bash
oc2 debug info
oc2 debug paths
oc2 debug lsp diagnostics src/index.ts
```

### OpenAPI Generation

```text
Usage:
  oc2 generate
```

This hidden, tooling-only command writes the repository OpenAPI document to stdout. It is registered but omitted from normal help and is not a general SDK generation interface.

```bash
oc2 generate > openapi.json
```
