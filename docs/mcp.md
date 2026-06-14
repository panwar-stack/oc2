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

OAuth config is recognized so a server can be marked auth-aware, but the full browser OAuth callback flow is deferred. OAuth-required servers report `auth_required` instead of completing an interactive login flow.

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

## Commands

```sh
bun src/index.ts mcp list
bun src/index.ts mcp enable localDocs
bun src/index.ts mcp disable remoteSearch
bun src/index.ts mcp test localDocs --json
bun src/index.ts run "use local docs" --mcp localDocs --no-mcp remoteSearch
```
