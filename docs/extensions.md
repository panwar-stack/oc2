# Extensions

OC2 extends the shipped V1 CLI through MCP servers, plugins, and skills. Put
these settings in `oc2.json` or `oc2.jsonc`; see
[Configuration](configuration.md) for configuration locations, loading order,
merge behavior, and substitutions.

## MCP

The top-level `mcp` object maps a server name to a local connection, a remote
connection, or an enable-only override:

- A local server has `type: "local"`, a required `command` array, and optional
  `environment`.
- A remote server has `type: "remote"`, a `url`, and optional `headers` and
  `oauth`.
- An override contains only `enabled`, which is useful for disabling a server
  contributed by another configuration source.

`command` and `environment` are not valid for remote servers; `url`, `headers`,
and `oauth` are not valid for local servers. Both shapes accept `enabled` and a
positive `timeout` in milliseconds. Servers are enabled unless `enabled` is
`false`. Without a configured value, connection attempts and tool-list requests
default to 30 seconds, but model-facing tool calls do not receive that default.
An explicitly configured `timeout` applies to all three; progress notifications
reset a running tool call's timeout. MCP prompt and resource operations do not
currently use this setting.

Use the validated examples as starting points:

- [Local MCP server](examples/oc2.mcp-local.jsonc)
- [Remote MCP server](examples/oc2.mcp-remote.jsonc)

### Transports And OAuth

Local servers run as child processes over stdio. They start in the active
project directory and inherit the OC2 process environment, with `environment`
values applied on top.

Remote servers try Streamable HTTP first, then SSE. Configured `headers` are
sent by either transport. OAuth discovery is enabled for remote servers by
default. Set `oauth` to `false` to disable it, or provide an object with any of
`clientId`, `clientSecret`, `scope`, `callbackPort`, and `redirectUri`. Without
`clientId`, OC2 attempts dynamic client registration. The callback defaults to
`http://127.0.0.1:19876/mcp/oauth/callback`; `callbackPort` changes its port
unless `redirectUri` is set.

### Generated Names

For model-facing tools, OC2 generates `<server>_<tool>`. For MCP prompts, it
generates `<server>:<prompt>`, which is also the slash-command name. Characters
other than ASCII letters, digits, `_`, and `-` in either component become `_`.
For example, tool `search.docs` from server `team-api` becomes
`team-api_search_docs`, while prompt `review.pr` becomes
`/team-api:review_pr`.

### CLI

`oc2 mcp` provides:

| Command                 | Purpose                                      |
| ----------------------- | -------------------------------------------- |
| `add [name]`            | Add a local or remote server                 |
| `list` (`ls`)           | Show configured servers and connection state |
| `auth [name]`           | Run OAuth authentication                     |
| `auth list` (`auth ls`) | Show OAuth status                            |
| `logout [name]`         | Remove stored OAuth credentials              |
| `debug <name>`          | Diagnose a remote server's OAuth connection  |

Non-interactive `add` accepts exactly one of `--url <url>` or a command after
`--`. Repeat `--header KEY=VALUE` for remote servers or `--env KEY=VALUE` for
local servers. See [CLI](cli.md) for the top-level command reference.

## Plugins

V1 configuration uses the singular top-level `plugin` list. Each entry is an
npm specifier, a file path or URL, or a `[specifier, options]` tuple:

```jsonc
{
  "plugin": [
    "@example/oc2-plugin",
    ["@example/oc2-plugin-with-options@1.2.3", { "mode": "compact" }],
    "./.oc2/plugins/local.ts",
  ],
}
```

Relative paths resolve from the configuration file that declares them. OC2
installs npm plugins on demand. It also discovers `*.ts` and `*.js` files under
`plugin/` and `plugins/` in loaded `.oc2` directories, so those files need no
list entry. Duplicate npm package names or file URLs are loaded once.

Modern modules default-export one object with an optional `id` and exactly one
entry point:

```ts
import type { PluginModule } from "@oc2-ai/plugin"

export default {
  id: "example.server",
  async server() {
    return {}
  },
} satisfies PluginModule
```

Use `server` for runtime hooks or `tui` for a TUI extension; one object cannot
provide both. Path plugins must provide `id`; npm plugins may use their package
name. Packages expose `./server` and/or `./tui` in `exports`; `main` remains a
server fallback. For compatibility, server modules may instead export one or
more plugin functions directly. New plugins should use the object form.

Install and register an npm plugin with `oc2 plugin <module>` (alias
`oc2 plug`). Add `--global` (`-g`) for global configuration or `--force` (`-f`)
to replace an existing version. `OC2_PURE` skips external server and TUI
plugins, while `OC2_DISABLE_DEFAULT_PLUGINS` skips built-in server plugins; see
[Environment](reference/environment.md) for control flag details.

## Skills

A skill is a directory containing `SKILL.md` with YAML frontmatter and Markdown
instructions:

```md
---
name: release-check
description: Check release readiness and changelog consistency.
---

Follow the repository release checklist and report blockers.
```

OC2 discovers skills from:

- Built-in skills.
- `skill/**/SKILL.md` and `skills/**/SKILL.md` in loaded `.oc2` directories.
- `~/.claude/skills/**/SKILL.md` and `~/.agents/skills/**/SKILL.md`, plus matching
  project directories found from the active directory up to the worktree root.
- Directories in `skills.paths`, scanned recursively for `**/SKILL.md`.
- Remote indexes in `skills.urls`, whose downloaded skill directories are
  scanned recursively.

`skills.paths` expands a leading `~/`; other relative paths resolve from the
active instance directory. A disk skill with the same name as a built-in
replaces the built-in. Duplicate names among discovered disk skills produce a
warning, but their winner is not a stable precedence contract because skill
files load concurrently. Use unique skill names. Give every skill a description:
only described, permitted skills are advertised to the model.

The model loads a skill through the `skill` tool. The agent's `skill` permission
is matched against the skill name: denied skills are omitted from its available
list, and loading a skill performs the normal permission check. See
[Agents And Permissions](agents-permissions.md) for rule syntax.

Discovered skills also become `/<name>` commands unless that name is reserved
or already belongs to a configured command or MCP prompt. `/skills` opens the
skill selector. Slash invocation expands the skill as a command; the model-facing
`skill` permission controls advertisement and tool loading rather than command
registration.

External Claude/Agents skill scans can be disabled independently without
disabling `.oc2`, configured-path, URL, or built-in skills. The canonical flags
and their interaction are listed in [Environment](reference/environment.md).
