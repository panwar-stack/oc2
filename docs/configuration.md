# Configuration

The shipped `oc2` CLI reads the V1 configuration surface. Its public collection keys are singular, including `agent`, `command`, `provider`, `plugin`, `permission`, and `mcp`; do not use variants such as `agents`, `commands`, `providers`, or `plugins`.

Start with [`examples/oc2.minimal.jsonc`](examples/oc2.minimal.jsonc), or see [`examples/oc2.full.jsonc`](examples/oc2.full.jsonc) for a broader validated example. Provider setup belongs in the [provider guide](providers.md), agent and permission behavior in [Agents and permissions](agents-permissions.md), and MCP, plugins, and skills in [Extensions](extensions.md).

## Files And Precedence

The normal global directory is `~/.config/oc2` (`$XDG_CONFIG_HOME/oc2` when `XDG_CONFIG_HOME` is set). OC2 recursively merges these sources from lowest to highest priority:

1. Configuration returned for authenticated providers by `/.well-known/oc2`, including any fetched remote configuration it names.
2. Global `~/.config/oc2/oc2.json`, then `~/.config/oc2/oc2.jsonc`, then the legacy `~/.config/oc2/config` TOML file.
3. The file named by `OC2_CONFIG`.
4. Direct project files from the worktree boundary toward the current project directory, ancestor to descendant. Each directory contributes `oc2.json`, then `oc2.jsonc`.
5. Project `.oc2` directories, currently from the nearest directory outward through its ancestors. Each contributes `oc2.json`, then `oc2.jsonc`.
6. `~/.oc2/oc2.json`, then `~/.oc2/oc2.jsonc`.
7. `oc2.json`, then `oc2.jsonc`, in the directory named by `OC2_CONFIG_DIR`.
8. Inline JSON or JSONC from `OC2_CONFIG_CONTENT`.
9. System-managed `oc2.json`, then `oc2.jsonc`.
10. macOS managed preferences installed through MDM.

The project `.oc2` nearest-first order is intentional current behavior: an outer ancestor loaded later can override a nearer one. Direct project files use the more typical root-first order, so the nearest direct file wins.

`OC2_DISABLE_PROJECT_CONFIG` skips only sources 4 and 5. It does not disable global configuration, `~/.oc2`, `OC2_CONFIG`, `OC2_CONFIG_DIR`, `OC2_CONFIG_CONTENT`, or managed configuration.

### JSON And JSONC

JSONC supports comments and trailing commas. When both names exist in a directory, OC2 reads both rather than selecting one: `oc2.jsonc` is later and therefore has higher priority than `oc2.json`. The same JSON-then-JSONC order applies to global, project, home, custom-directory, and system-managed directory tiers.

The legacy global `~/.config/oc2/config` TOML file loads after the two global JSON files and can override them. When it contains both `provider` and `model`, OC2 combines those fields as `provider/model`; either field alone is discarded. Unreadable or invalid legacy TOML is ignored. Later tiers such as `OC2_CONFIG` and project files still override it.

Configuration updates preserve an existing global `oc2.jsonc` in preference to `oc2.json`; if neither exists, OC2 creates global `oc2.jsonc`. Project updates target the last existing project-owned file in the direct/project-`.oc2` plan, or create `oc2.json` in the routed project directory when none exists. Environment-selected, remote, home, and managed sources are not write targets for these updates.

## Merge Rules

Later sources recursively override earlier sources. Nested objects retain keys that a later source does not replace.

- `instructions` arrays concatenate in source order and remove exact duplicate strings while keeping the first occurrence.
- `plugin` entries retain their source and global/local provenance. They are deduplicated by load identity, with the later declaration winning: package name for package specs and exact resolved file URL for local specs.
- All other arrays replace the earlier array rather than concatenate.

Relative plugin paths are resolved against the file that declared them before sources are merged.

## Substitutions

OC2 expands substitutions before parsing and validating each contribution:

- `{env:NAME}` is replaced directly with `NAME` from the environment. An unavailable or empty variable becomes an empty string. Because replacement is textual, place the token where the resulting text remains valid JSON or JSONC.
- `{file:path}` reads the file, trims leading and trailing whitespace, JSON-escapes its contents, and inserts the escaped string contents. Relative paths resolve from the configuration file's directory; paths in `OC2_CONFIG_CONTENT` resolve from the routed project directory. Absolute paths and `~/` are supported. A missing or unreadable file aborts main configuration loading.

`{file:...}` text on a `//` comment line is left unchanged. Substitution happens in memory and does not rewrite the source file. See the [environment variable reference](reference/environment.md) for the environment controls themselves.

## Validation And Errors

JSON and JSONC main configuration contributions are parsed and validated against the shipped V1 schema. Unknown top-level V1 keys fail validation. Invalid project, custom, inline, home, and managed main configuration aborts loading rather than being partially applied. The normal cached global `~/.config/oc2/oc2.json[c]` path is tolerant: a parse, substitution, validation, or plugin-resolution failure logs an error, drops the entire global JSON/JSONC tier, and continues with defaults and later sources. Nested validation still follows the schema for that section.

Agent selection and the strict `default_agent` contract are documented in [Agents and permissions](agents-permissions.md).

## Managed Configuration

Administrators can enforce the final file-based tier with:

- macOS: `/Library/Application Support/oc2`
- Windows: `%ProgramData%\oc2`
- Linux and other Unix systems: `/etc/oc2`

These directories load `oc2.json` and then `oc2.jsonc`. On macOS, an MDM profile in the `ai.oc2.managed` preferences domain has still higher priority than those files and every user-controlled source. OC2 checks the per-user managed preference before the machine-wide preference and uses the first available profile.

## TUI Compatibility

TUI settings have a separate loader and precedence model. New configuration must put TUI settings in `tui.json` or `tui.jsonc`. Legacy `theme`, `keybinds`, and `tui` values in `oc2.json[c]` are read only as compatibility contributions and are removed before main V1 validation.

Unlike invalid main V1 configuration, an invalid TUI contribution may be logged and skipped so the TUI can continue loading other sources. `OC2_TUI_CONFIG` also participates only in TUI precedence. See the [TUI guide](tui.md) for the detailed workflow, compatibility order, and keybinding configuration, and the [keybinding reference](reference/keybindings.md) for the complete binding list.
