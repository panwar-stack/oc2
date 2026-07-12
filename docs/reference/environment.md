# Environment Variables And Control Flags

This is the curated user-facing inventory for environment controls read by the
shipped `oc2` runtime. Provider credentials are provider-specific and belong in
[Providers](../providers.md). Test-only overrides and internal process-routing
variables are intentionally excluded.

Boolean controls are off unless noted. Values `true` and `1` enable them,
case-insensitively; use `false` or `0` for Effect-backed controls that explicitly
override an umbrella flag. Positive-integer controls ignore zero, negative,
fractional, and nonnumeric values.

## Configuration And Permissions

Configuration precedence is documented only in
[Configuration](../configuration.md).

| Variable                     | Effect                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `OC2_CONFIG`                 | Load an explicit `oc2.json` or `oc2.jsonc` file.                                                           |
| `OC2_TUI_CONFIG`             | Load an explicit `tui.json` or `tui.jsonc` file.                                                           |
| `OC2_CONFIG_CONTENT`         | Load V1 configuration directly from JSON or JSONC text.                                                    |
| `OC2_CONFIG_DIR`             | Add an explicit configuration directory and use it as the global config root for core paths.               |
| `OC2_DISABLE_PROJECT_CONFIG` | Skip project configuration and project instruction discovery.                                              |
| `OC2_PERMISSION`             | Merge a JSON permission object into the resolved V1 configuration; invalid JSON is ignored with a warning. |

## Server And Browser

| Variable                      | Effect                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `OC2_SERVER_USERNAME`         | Set the HTTP Basic authentication username. Defaults to `opencode`.                                             |
| `OC2_SERVER_PASSWORD`         | Set the HTTP Basic authentication password. Required before exposing `serve` or `web` beyond a trusted machine. |
| `OC2_DISABLE_EMBEDDED_WEB_UI` | Disable embedded browser assets; browser UI requests return a local `503`.                                      |

## TUI And Shell

| Variable                                   | Effect                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `OC2_GIT_BASH_PATH`                        | Use a specific Git Bash executable on Windows.                                                     |
| `OC2_DISABLE_TERMINAL_TITLE`               | Do not update the terminal title.                                                                  |
| `OC2_DISABLE_MOUSE`                        | Disable TUI mouse handling even when enabled in TUI configuration.                                 |
| `OC2_EXPERIMENTAL_DISABLE_COPY_ON_SELECT`  | Disable automatic copying of selected text. Defaults to enabled on Windows and disabled elsewhere. |
| `OC2_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` | Set the shell tool's default timeout in milliseconds. Defaults to `120000`.                        |

## Sessions, Models, And Updates

| Variable                            | Effect                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `OC2_DISABLE_AUTOCOMPACT`           | Disable automatic session compaction.                                     |
| `OC2_DISABLE_PRUNE`                 | Disable pruning during compaction.                                        |
| `OC2_DISABLE_AUTOUPDATE`            | Disable automatic update checks.                                          |
| `OC2_ALWAYS_NOTIFY_UPDATE`          | Notify about an available update even when automatic updating is enabled. |
| `OC2_DISABLE_MODELS_FETCH`          | Do not fetch the models.dev catalog.                                      |
| `OC2_MODELS_URL`                    | Replace the models.dev catalog base URL.                                  |
| `OC2_MODELS_PATH`                   | Read the model catalog from a local JSON file.                            |
| `OC2_EXPERIMENTAL_OUTPUT_TOKEN_MAX` | Cap model output tokens with a positive integer.                          |

## Extensions And Tools

| Variable                         | Effect                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `OC2_PURE`                       | Skip configured and discovered external server and TUI plugins. Built-in plugins still load. |
| `OC2_DISABLE_DEFAULT_PLUGINS`    | Skip built-in server plugins.                                                                |
| `OC2_DISABLE_EXTERNAL_SKILLS`    | Skip both Claude and Agents skills found outside OC2 configuration directories.              |
| `OC2_DISABLE_CLAUDE_CODE`        | Disable both Claude Code prompt-file and skill compatibility.                                |
| `OC2_DISABLE_CLAUDE_CODE_PROMPT` | Skip global and project `CLAUDE.md` instruction files.                                       |
| `OC2_DISABLE_CLAUDE_CODE_SKILLS` | Skip `.claude/skills` while retaining `.agents/skills`.                                      |
| `OC2_DISABLE_LSP_DOWNLOAD`       | Prevent automatic language-server downloads.                                                 |
| `OC2_ENABLE_QUESTION_TOOL`       | Enable the question tool for clients where it is not enabled by default.                     |
| `OC2_WEBSEARCH_PROVIDER`         | Select `exa` or `parallel` as the web-search provider independently of their enable flags.   |
| `OC2_ENABLE_EXA`                 | Select Exa for web search. Also enabled by `OC2_EXPERIMENTAL`.                               |
| `OC2_ENABLE_PARALLEL`            | Select Parallel for web search.                                                              |
| `OC2_EXPERIMENTAL_EXA`           | Legacy alias that enables Exa web search.                                                    |
| `OC2_EXPERIMENTAL_PARALLEL`      | Legacy alias that enables Parallel web search.                                               |

Extension configuration and behavior are documented in
[Extensions](../extensions.md).

## Experimental Controls

`OC2_EXPERIMENTAL` is an umbrella for Exa and the controls marked "inherits the
umbrella" below. Setting one of those individual flags to `false` or `0`
disables that feature even when the umbrella is enabled. Dedicated controls not
marked that way do not inherit it.

| Variable                                | Effect                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `OC2_EXPERIMENTAL_REFERENCES`           | Enable reference indexing and lookup. Inherits the umbrella.              |
| `OC2_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | Allow background task subagents. Inherits the umbrella.                   |
| `OC2_EXPERIMENTAL_LSP_TOOL`             | Expose the experimental LSP tool. Inherits the umbrella.                  |
| `OC2_EXPERIMENTAL_OXFMT`                | Allow the experimental Oxfmt formatter. Inherits the umbrella.            |
| `OC2_EXPERIMENTAL_PLAN_MODE`            | Enable plan mode and its CLI tool. Inherits the umbrella.                 |
| `OC2_EXPERIMENTAL_EVENT_SYSTEM`         | Enable the experimental event-backed session path. Inherits the umbrella. |
| `OC2_EXPERIMENTAL_WORKSPACES`           | Enable experimental workspace behavior. Inherits the umbrella.            |
| `OC2_EXPERIMENTAL_SESSION_SWITCHER`     | Enable the experimental TUI session switcher. Inherits the umbrella.      |
| `OC2_EXPERIMENTAL_ICON_DISCOVERY`       | Discover project icons. Inherits the umbrella.                            |
| `OC2_ENABLE_EXPERIMENTAL_MODELS`        | Include alpha models in model discovery and suggestions.                  |
| `OC2_EXPERIMENTAL_LSP_TY`               | Use the experimental Python `ty` language server path.                    |
| `OC2_EXPERIMENTAL_NATIVE_LLM`           | Use the experimental native LLM execution path when supported.            |
| `OC2_EXPERIMENTAL_WEBSOCKETS`           | Opt into experimental provider WebSocket transport on release builds.     |
| `OC2_EXPERIMENTAL_FILEWATCHER`          | Watch the full active location in addition to required VCS files.         |
| `OC2_EXPERIMENTAL_DISABLE_FILEWATCHER`  | Disable filesystem watcher subscriptions.                                 |

## Diagnostics And Storage

| Variable                      | Effect                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `OC2_SHOW_TTFD`               | Show time-to-first-display timing in the TUI or interactive run UI.                                                          |
| `OC2_AUTO_HEAP_SNAPSHOT`      | Write heap snapshots automatically when the runtime's heap monitor triggers.                                                 |
| `OC2_DB`                      | Override the SQLite database path. Relative paths resolve under OC2's data directory; `:memory:` uses an in-memory database. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Export logs and traces over OTLP HTTP to this base endpoint.                                                                 |
| `OTEL_EXPORTER_OTLP_HEADERS`  | Add comma-separated `key=value` headers to OTLP requests.                                                                    |
