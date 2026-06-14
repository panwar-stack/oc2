# MCP Protocol Completeness

## Goal

Implement complete MCP client/host support for configured MCP servers in `oc2`: stdio, Streamable HTTP, SSE fallback, OAuth for remote servers, tools, resources, prompts, roots, sampling, elicitation, cancellation, status, and deterministic tests.

Use the official TypeScript MCP SDK if it reduces protocol risk, but keep the existing `oc2` tool registry, permission checks, scheduler, events, and TUI projection as the integration boundary.

## Current State

- `src/mcp/client.ts` defines a minimal `McpClient` with only `initialize`, `listTools`, `callTool`, `onToolsChanged`, and `close`.
- `src/mcp/client.ts` hardcodes `initialize` capabilities to `{}` and only supports `tools/list` and `tools/call`.
- `src/mcp/mcp-service.ts` discovers tools and registers them as normal `oc2` tools.
- `src/config/schema.ts` supports `stdio`, `http`, `sse`, headers, env, OAuth metadata, and tool permissions.
- `src/mcp/auth.ts` defers all OAuth-enabled servers as `auth_required`.
- `docs/client-concepts.md` identifies client-side MCP features: elicitation, roots, and sampling.
- `docs/client-best-practices.md` recommends progressive tool discovery and refresh on `tools/list_changed`.
- `docs/authorization.md` describes OAuth 2.1 protected resource metadata, authorization server discovery, DCR, browser authorization, and bearer requests.
- `README.md` states OAuth callback flow is deferred and should be updated when implemented.

## Non-Negotiables

- Must preserve existing `mcp_<server>_<tool>` naming and `mcp.invoke:<server>/<tool>` permission behavior.
- Must keep MCP server credentials and OAuth tokens out of model-visible tool schemas, events, logs, snapshots, and error messages.
- Must support direct tool invocation before progressive discovery optimizations.
- Must treat roots as advisory protocol scope, not a security boundary.
- Must not implement generic MCP server hosting in first pass; this spec is for `oc2` as an MCP host/client.
- Must not add programmatic tool calling/code-mode in first pass; it requires a separate sandbox security spec.

## Protocol Surface

Add a richer client boundary:

```ts
interface McpClient {
  initialize(input: McpInitializeInput, signal: AbortSignal): Promise<McpInitializeResult>
  listTools(signal: AbortSignal): Promise<readonly McpToolInfo[]>
  callTool(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>
  listResources(signal: AbortSignal): Promise<readonly McpResourceInfo[]>
  readResource(uri: string, signal: AbortSignal): Promise<McpResourceReadResult>
  listPrompts(signal: AbortSignal): Promise<readonly McpPromptInfo[]>
  getPrompt(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpPromptResult>
  onListChanged(kind: "tools" | "resources" | "prompts" | "roots", callback: () => void): void
  close(): Promise<void>
}
```

Client capabilities must advertise only what `oc2` actually implements:

```ts
{
  roots: { listChanged: true },
  sampling: {},
  elicitation: {},
}
```

## Host Behaviors

- `roots/list` returns current session workspace roots as `file://` URIs.
- `notifications/roots/list_changed` is sent when a future session root update occurs; first pass only needs static per-run roots.
- `sampling/createMessage` routes through `ModelService.collect` with a dedicated permission action such as `mcp.sampling:<serverId>`.
- `elicitation/create` routes through existing question resolution and validates the returned object against the server-provided schema.
- `resources/list`, `resources/read`, `prompts/list`, and `prompts/get` are exposed as internal `oc2` MCP meta-tools only after permission review.
- Tool errors with `isError: true` remain tool execution failures, not transport failures.

## OAuth

- Remote `http` and `sse` servers must support OAuth 2.1 authorization-code-with-PKCE.
- On `401` with `WWW-Authenticate` resource metadata, discover PRM, authorization server metadata, and registration support.
- Support preconfigured `oauth.clientId`; support DCR when `registration_endpoint` exists.
- Store access/refresh tokens in the local data directory with redaction in logs and persistence.
- `oc2 mcp test <id>` must show `auth_required` with an actionable auth URL or start the browser callback flow, depending on CLI/TUI capabilities.
- Stdio servers must continue using env/config credentials and must not use OAuth browser flow by default.

## Implementation Slices

### PR 1: SDK Or Transport Foundation

- Replace or wrap the hand-rolled JSON-RPC transport in `src/mcp/client.ts` with protocol-complete stdio, Streamable HTTP, and SSE behavior.
- Add typed normalization for initialize results, server capabilities, JSON-RPC errors, cancellation, and list-change notifications.
- Keep `McpClientFactory` injectable so existing tests can use fake clients.
- Add fixture servers for stdio and HTTP protocol smoke tests.

Verification:

- `bun test test/mcp/mcp-service.test.ts`
- `bun run typecheck`

Review:

A fresh read-only reviewer must inspect the diff against this PR scope before merge, focusing on transport correctness, lifecycle cleanup, cancellation, and whether existing tool behavior changed unintentionally.

### PR 2: Resources And Prompts

- Add `McpResourceInfo`, `McpPromptInfo`, and result types in `src/mcp/status.ts` or a new `src/mcp/protocol.ts`.
- Implement `resources/list`, `resources/read`, `prompts/list`, and `prompts/get` in the client.
- Register safe oc2 meta-tools such as `mcp_resource_list`, `mcp_resource_read`, `mcp_prompt_list`, and `mcp_prompt_get`.
- Apply per-server permission actions, for example `mcp.resource:<server>/<uri>` and `mcp.prompt:<server>/<name>`.
- Add TUI and event status counts only if they are already available from discovery without extra server calls.

Verification:

- `bun test test/mcp`
- `bun test test/tools`
- `bun run typecheck`

Review:

A fresh read-only reviewer must verify schemas are bounded, permission checks happen before reads/prompts, and resource contents cannot bypass existing output-size handling.

### PR 3: Roots, Sampling, And Elicitation

- Advertise `roots`, `sampling`, and `elicitation` during initialize only after handlers exist.
- Implement `roots/list` from `SessionRecord.workspaceRoots`.
- Handle `sampling/createMessage` by creating a separate model request through `src/model/model-service.ts`, gated by explicit permission.
- Handle `elicitation/create` through the existing question resolver used by `src/tools/builtins/question.ts`.
- Validate elicitation answers against the provided schema and return decline/cancel results deterministically.

Verification:

- `bun test test/mcp`
- `bun test test/session`
- `bun test test/tui`
- `bun run typecheck`

Review:

A fresh read-only reviewer must check that sampling cannot recursively start unbounded model work, elicitation never requests secrets silently, and roots are clearly advisory.

### PR 4: Remote OAuth

- Replace `src/mcp/auth.ts` deferred behavior with OAuth 2.1 client flow for remote transports.
- Implement PRM discovery from `WWW-Authenticate`, auth server metadata discovery, PKCE, optional DCR, token exchange, refresh, and bearer request retry.
- Store tokens under the configured data directory, not config files.
- Add CLI/TUI status fields for auth URL, callback pending, authenticated, refresh failed, and auth required.
- Update `README.md` MCP section to remove the deferred OAuth note.

Verification:

- `bun test test/mcp`
- `bun test test/config`
- `bun test test/cli`
- `bun run typecheck`

Review:

A fresh read-only security reviewer must inspect token storage, redaction, callback validation, state/PKCE handling, and whether any token can reach model context or persisted runtime events.

### PR 5: Compatibility Matrix And Docs

- Add local fixture coverage for stdio, Streamable HTTP, SSE, tools, resources, prompts, roots, sampling, elicitation, list-changed notifications, auth-required, OAuth success, OAuth refresh, and malformed server output.
- Add a compact MCP support matrix to `README.md`.
- Add exact config examples for stdio local credentials and remote OAuth.
- Keep `docs/` protocol copies unchanged unless intentionally refreshing upstream MCP docs.

Verification:

- `bun run diagnostics`
- `bun test test/mcp`
- `bun run start mcp list --json`

Review:

A fresh read-only reviewer must compare the matrix against tests and verify every claimed supported protocol feature has at least one deterministic test.

## Future Work

- Progressive discovery meta-tools once complete protocol support is stable.
- Programmatic tool calling/code mode with a separate sandbox, broker, and security review.
- Provider-native tool search integration when the model provider supports it.
- Dynamic root updates during long-running TUI sessions.

## Open Questions

- Should OAuth tokens be encrypted at rest or stored as plaintext in the local data directory with filesystem permissions? Default: local plaintext with strict redaction for first pass, encryption as follow-up.
- Should resources and prompts be model-visible by default? Default: no; expose them through permissioned meta-tools first.
- Should the first transport PR adopt `@modelcontextprotocol/sdk` directly? Default: yes if it works cleanly with Bun and preserves current injection tests.
