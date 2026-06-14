# Configuration Examples

`oc2` configuration is JSONC. Files are merged in this order:

```text
defaults < user config < project config < explicit config
```

Supported paths:

- `~/.config/oc2/config.jsonc`
- `./oc2.jsonc`
- `./.oc2/config.jsonc`
- `OC2_CONFIG=/path/to/config.jsonc`

CLI flags are command-scoped overrides where supported.

## Complete Example

```jsonc
{
  "model": {
    "provider": "fake",
    "model": "test",
  },
  "tools": {
    "bash": {
      "enabled": true,
      "permissions": [
        { "match": "bash", "decision": "ask" },
        { "match": "bash:rm", "decision": "deny" },
      ],
    },
    "write": {
      "enabled": true,
      "permissions": [{ "match": "write", "decision": "ask" }],
    },
  },
  "mcp": {
    "localDocs": {
      "enabled": true,
      "transport": "stdio",
      "command": "docs-mcp",
      "args": [],
      "cwd": ".",
      "env": {},
      "toolPermissions": [{ "match": "mcp.invoke:localDocs/*", "decision": "ask" }],
      "startupTimeoutMs": 10000,
    },
  },
  "agents": {
    "reviewer": {
      "name": "Reviewer",
      "description": "Read-only implementation reviewer",
      "mode": "subagent",
      "systemPrompt": "Review the diff and report findings only.",
      "defaultModel": "fake/test",
      "allowedTools": [{ "match": "write", "decision": "deny" }],
      "maxIterations": 12,
      "timeoutMs": 120000,
    },
  },
  "runtime": {
    "maxConcurrentTools": 4,
    "maxConcurrentSubAgents": 2,
    "maxConcurrentTeamMembers": 4,
    "defaultTimeoutMs": 120000,
    "logLevel": "info",
  },
  "tui": {
    "sidePanel": true,
    "theme": "default",
  },
}
```

## Permission Rules

Permission rules have this shape:

```jsonc
{ "match": "tool-or-action-pattern", "decision": "allow" }
```

`decision` may be `allow`, `deny`, or `ask`. Match candidates include the tool name, action, resource, `toolName:resource`, and `action:resource`. If no rule matches, the operation is allowed. In non-interactive runs, `ask` without a resolver is denied with a structured tool error.

## Command Overrides

```sh
bun run start run "hello" --json --model fake/test
bun run start run "inspect" --root . --tool read --no-tool bash
bun run start run "search docs" --mcp localDocs --no-mcp remoteSearch
```
