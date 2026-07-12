# Terminal UI Guide

Start the TUI in the current directory with `oc2 .`, or pass another project path. Resume with `oc2 --continue` or `oc2 --session <id>`. See the [CLI reference](./cli.md) for invocation, resume and fork rules, and server options.

## Start A Session

The home screen uses the selected agent and model. If no model is available, connect a provider from `/connect` or the command palette, then select a model with `/models`. Enter a prompt to create a session and submit the first turn.

Use the command palette, `ctrl+p` by default, to discover commands available in the current screen. Commands can also expose slash names and configurable keybindings. Some entries, including experimental workspace or team workflows, appear only when their feature or configuration is enabled; the palette is authoritative for the running build.

## Prompt Workflows

The prompt supports four related workflows:

- **Prompt:** Type normal text and press Return. Use Shift+Return, Ctrl+Return, Alt+Return, or Ctrl+J for a newline with the default bindings. References and available slash entries appear through autocomplete.
- **Shell:** Type `!` at the start of an empty normal prompt, enter a shell command, and press Return. Escape leaves shell mode; Backspace also leaves it when the cursor is at the start. Shell commands run through the session and remain part of its history.
- **Configured command:** Enter `/<command> [arguments]` for a command defined by OC2 configuration. The TUI expands its configured template and sends it through the session. Arguments may continue on following lines.
- **TUI slash command:** Enter a slash action exposed by the current UI, such as `/sessions`, `/new`, `/models`, `/agents`, `/roots`, `/status`, `/themes`, `/help`, or `/exit`. These operate the interface rather than sending a model prompt.

Autocomplete and the command palette reflect the commands actually available. Configured commands are documented with other agent behavior in [Agents And Permissions](./agents-permissions.md); do not assume an optional or experimental slash command exists until it appears in the current TUI.

## Permissions

When a tool needs approval, the prompt shows the requested operation and relevant paths, patterns, command, or other details. Move between the offered choices with Left/Right or `h`/`l`, then press Return.

The choices can include allowing this request, allowing matching requests until OC2 restarts, or rejecting it. Persistent policy comes from configuration; the TUI's "always" response is session-runtime approval, not a configuration edit. Escape rejects when rejection is offered. Some detailed requests can be expanded with the configured permission-fullscreen binding.

Review the operation before approval, especially shell commands, edits, external directories, and network access. See [Agents And Permissions](./agents-permissions.md) for policy configuration.

## Questions

Agents can pause to ask one or more questions. Use Up/Down or `j`/`k` to choose an answer, number keys for the visible choices, and Return to select. Questions may allow multiple choices or a custom response. Use Left/Right, `h`/`l`, or Tab to move between multiple questions and the confirmation tab. Escape rejects the question request.

While a permission or question is pending, normal prompt submission is disabled so the outstanding interaction can be resolved first.

## Sessions And Navigation

- Open `/sessions` to switch or resume, and `/new` to return home for a new session.
- Use the sidebar and timeline commands to inspect session structure and navigate parent or child sessions.
- Interrupt an active response with Escape under the default bindings.
- Open `/roots` to manage the directories attached to the current session.

The roots dialog can add an absolute directory, rename a root, make a root primary, or remove it from the session. The primary root supplies the default base for relative paths. Removing a root unregisters it from the session and does not delete files. Added roots extend session access only through the normal filesystem and permission boundaries.

Experimental workspaces are separate from multi-root sessions. If enabled, `/workspaces` and workspace actions can create or select isolated workspace locations; their availability depends on the running configuration.

## Configure The TUI

Put new TUI settings in `tui.jsonc` or `tui.json`, not under the deprecated TUI keys in `oc2.jsonc` or `oc2.json`. Legacy values remain compatible, but dedicated TUI files are the current surface. For example:

```jsonc
{
  "$schema": "https://oc2.ai/tui.json",
  "theme": "oc2",
  "mouse": true,
  "keybinds": {
    "leader": "ctrl+x",
    "app_debug": "none",
  },
}
```

Set a binding to `"none"` to disable it. The complete binding names and defaults are maintained in the [keybinding reference](./reference/keybindings.md); this page intentionally lists only the keys needed to explain a workflow.

### Loading Order And Legacy Settings

TUI contributions load from lowest to highest priority:

1. Global legacy settings from `oc2.json[c]`, then global `tui.json[c]`.
2. Legacy settings in the file named by `OC2_CONFIG`.
3. The dedicated file named by `OC2_TUI_CONFIG`.
4. Direct project files from the worktree boundary toward the current project directory, with each directory's legacy `oc2.json[c]` followed by dedicated `tui.json[c]`.
5. Discovered project `.oc2` directories from nearest to outermost, again legacy then dedicated. The outer directory loads later and can override the nearer one.
6. Legacy and dedicated files under `~/.oc2`.
7. Legacy and dedicated files under `OC2_CONFIG_DIR`.

This means project configuration intentionally overrides `OC2_TUI_CONFIG`. At each directory tier, JSON loads before JSONC, and dedicated `tui.json[c]` values override legacy values from `oc2.json[c]`.

The legacy fields are top-level `theme` and `keybinds`, plus `tui.scroll_speed`, `tui.scroll_acceleration`, and `tui.diff_style`. Move those values to their corresponding fields in `tui.json[c]` for new configuration. Other main configuration behavior remains owned by [Configuration](./configuration.md).

See [Configuration](./configuration.md) for main V1 configuration merging, substitutions, and validation behavior. See [Extensions](./extensions.md) for TUI plugins and [Providers](./providers.md) for model connectivity.
