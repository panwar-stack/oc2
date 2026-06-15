# MCP Examples

MCP servers use the canonical `oc2` config shape under `mcp`. Enabled servers can be tested with `oc2 mcp test <id>` and are started for one-shot runs when selected by config or command flags.

Discovered tools are registered as `mcp_<server>_<tool>`. Invocation uses the normal tool scheduler, permission service, timeout, cancellation, root checks where applicable, and output bounding path.
Resource reads and prompt gets use explicit MCP permission resources: `mcp.resource:<server>/<uri>` and `mcp.prompt:<server>/<name>`.

## Stdio Server

```jsonc
{
  "mcp": {
    "localDocs": {
      "enabled": true,
      "transport": "stdio",
      "command": "docs-mcp",
      "args": ["--root", "."],
      "cwd": ".",
      "env": {},
      "toolPermissions": [{ "match": "mcp.invoke:localDocs/*", "decision": "ask" }],
      "startupTimeoutMs": 10000,
    },
  },
}
```

`stdio` servers require `command`. `args`, `cwd`, and `env` are optional. Stdio servers do not use the browser OAuth flow by default; provide credentials through environment variables or server-specific config. Secret-shaped values are redacted from logs and diagnostics.

## HTTP Server

```jsonc
{
  "mcp": {
    "remoteSearch": {
      "enabled": false,
      "transport": "http",
      "url": "https://example.test/mcp",
      "headers": {
        "authorization": "Bearer ${TOKEN}",
      },
      "startupTimeoutMs": 10000,
    },
  },
}
```

`http` and `sse` servers require `url`. Header and environment values are redacted from logs and diagnostics when they look secret-shaped.

## SSE Server

```jsonc
{
  "mcp": {
    "eventStream": {
      "enabled": false,
      "transport": "sse",
      "url": "https://example.test/sse",
    },
  },
}
```

## Auth-Required Servers

Remote `http` and `sse` servers with OAuth enabled use OAuth 2.1 authorization-code-with-PKCE. The client discovers protected resource metadata and authorization server metadata, registers dynamically when needed, generates PKCE challenge/state, opens a local callback listener, exchanges the authorization code for tokens, refreshes expired tokens, and retries bearer requests once. Tokens are stored under the local data directory and are redacted from logs, events, and snapshots.

`oc2 mcp test <id>` exits successfully when the server connects or reports `auth_required`. Text output includes discovered tool/resource/prompt counts and `auth: <url>` when user action is needed. JSON output includes the same counts plus `authState`, such as `callback_pending`, `authenticated`, or `refresh_failed`.

```jsonc
{
  "mcp": {
    "protected": {
      "enabled": true,
      "transport": "http",
      "url": "https://example.test/mcp",
      "oauth": {
        "enabled": true,
        "clientId": "local-client",
        "callbackPort": 7331,
        "scopes": ["tools"],
      },
      "toolPermissions": [{ "match": "mcp.invoke:protected/*", "decision": "ask" }],
      "startupTimeoutMs": 20000,
    },
  },
}
```

## Config Examples

### Stdio server

```jsonc
{
  "mcp": {
    "my-server": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/workspace"],
      "env": { "API_KEY": "${MY_API_KEY}" },
      "toolPermissions": [{ "match": "mcp.invoke:my-server/*", "decision": "ask" }],
    },
  },
}
```

### Remote HTTP server with OAuth

```jsonc
{
  "mcp": {
    "remote-server": {
      "enabled": true,
      "transport": "http",
      "url": "https://mcp-server.example.com",
      "oauth": {
        "enabled": true,
        "clientId": "your-client-id",
        "scopes": ["read", "write"],
        "callbackPort": 9876,
      },
      "toolPermissions": [{ "match": "mcp.invoke:remote-server/*", "decision": "ask" }],
    },
  },
}
```

### Permission rules

```jsonc
{
  "mcp": {
    "my-server": {
      "toolPermissions": [{ "match": "mcp.invoke:my-server/search", "decision": "allow" }],
    },
  },
}
```

Generated MCP permission resources use these shapes: tool invocation `mcp.invoke:<server>/<tool>`, resource read `mcp.resource:<server>/<uri>`, and prompt get `mcp.prompt:<server>/<name>`.

## Commands

```sh
bun run start mcp list
bun run start mcp enable localDocs
bun run start mcp disable remoteSearch
bun run start mcp test localDocs --json
bun run start run "use local docs" --mcp localDocs --no-mcp remoteSearch
```
