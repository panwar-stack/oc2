# MCP Examples

MCP servers use the canonical `oc2` config shape under `mcp`. Enabled servers can be tested with `oc2 mcp test <id>` and are started for one-shot runs when selected by config or command flags.

Discovered tools are registered as `mcp_<server>_<tool>`. Invocation uses the normal tool scheduler, permission service, timeout, cancellation, root checks where applicable, and output bounding path.

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

`stdio` servers require `command`. `args`, `cwd`, and `env` are optional.

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
        "clientSecretEnv": "PROTECTED_MCP_CLIENT_SECRET",
        "redirectUri": "http://localhost:7331/callback",
        "callbackPort": 7331,
        "scopes": ["tools"],
      },
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
    },
  },
}
```

### Permission rules

```jsonc
{
  "tools": {
    "mcp_my-server_search": {
      "permissions": [{ "match": "mcp.invoke:my-server/search", "decision": "allow" }],
    },
  },
}
```

## Commands

```sh
bun run start mcp list
bun run start mcp enable localDocs
bun run start mcp disable remoteSearch
bun run start mcp test localDocs --json
bun run start run "use local docs" --mcp localDocs --no-mcp remoteSearch
```
