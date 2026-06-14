# MCP Protocol Completion Remediation

## Goal

Finish the missing implementation pieces from `specs/02-mcp-protocol-completeness.md` so configured MCP servers behave as complete local-client integrations in `oc2`.

The strategy is to preserve the existing `oc2` tool registry, permission system, scheduler, events, and TUI projection while completing protocol gaps incrementally: transport correctness first, then host callbacks, then OAuth, then deterministic compatibility coverage.

## Current State

- `src/mcp/client.ts` now exposes a richer `McpClient` surface with tools, resources, prompts, list-change callbacks, and host handler plumbing.
- `src/mcp/protocol.ts` defines MCP protocol types for capabilities, resources, prompts, and JSON-RPC errors.
- `src/config/schema.ts` accepts `stdio`, `http`, `sse`, headers, env, and OAuth config fields.
- `src/mcp/client.ts` still uses a hand-rolled HTTP `fetch` transport and minimal SSE handling.
- `src/mcp/client.ts` handles `roots/list`, `sampling/createMessage`, and `elicitation/create` only for stdio server requests.
- `src/session/run.ts` and `src/cli/index.ts` create MCP services without normal-run host handlers.
- `src/mcp/mcp-service.ts` subscribes only to tools list changes, even though the client parses resources/prompts list changes.
- `src/mcp/meta-tools.ts` defines resource and prompt meta-tools, but `src/tools/permissions.ts` defaults unmatched permission checks to allow.
- `src/mcp/auth.ts` contains OAuth helper functions, but `requiresDeferredOAuth` still short-circuits every `oauth.enabled` server.
- `README.md` includes an MCP support matrix, while `docs/mcp.md` and `docs/authorization.md` still describe OAuth callback flow as deferred.
- `test/mcp/protocol-smoke.test.ts` covers stdio protocol behavior.
- `test/mcp/http-fixture-server.ts` exists but is not fully exercised for Streamable HTTP, SSE, OAuth success, OAuth refresh, or malformed output.

## Non-Negotiables

- Must preserve existing MCP tool names: `mcp_<server>_<tool>`.
- Must preserve existing invoke permission resource shape: `mcp.invoke:<server>/<tool>`.
- Must not expose MCP credentials, OAuth tokens, authorization headers, refresh tokens, or client secrets to model-visible schemas, runtime events, logs, snapshots, or error messages.
- Must treat MCP roots as advisory protocol scope, not a security boundary.
- Must keep `McpClientFactory` injectable so tests can use fake clients.
- Must keep direct tool invocation working before adding progressive discovery optimizations.
- Must not add generic MCP server hosting.
- Must not add programmatic model tool-calling/code-mode.
- Each implementation slice must receive a fresh read-only review before being marked complete.

## Protocol And Transport Design

`McpClient` must support these operations for all applicable transports:

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
  setHostHandlers(handlers: McpHostHandlers): void
  close(): Promise<void>
}
```

Transport behavior:

- `stdio` must support bidirectional JSON-RPC requests, responses, notifications, host callbacks, cancellation, and lifecycle cleanup.
- `http` must support MCP Streamable HTTP semantics, including session headers if required by the server.
- `sse` must support server-sent notifications for tools/resources/prompts/roots list changes.
- Abort must reject local callers and send MCP `notifications/cancelled` when the request has already been sent.
- JSON-RPC errors must preserve `code`, `message`, and `data` internally while redacting sensitive data before user/model-visible output.
- Tool results with `isError: true` must remain tool execution failures, not transport failures.

## Host Behavior Design

Host handlers must be wired into normal session runs, not only tests.

```ts
interface McpHostHandlers {
  listRoots(): Promise<{ roots: Array<{ uri: string; name?: string }> }>
  createSamplingMessage(input: McpSamplingCreateMessageInput): Promise<McpSamplingCreateMessageResult>
  elicit(input: McpElicitationCreateInput): Promise<McpElicitationCreateResult>
}
```

Required behavior:

- `roots/list` returns current `SessionRecord.workspaceRoots` as `file://` URIs.
- `sampling/createMessage` routes through `src/model/model-service.ts`.
- Sampling must require an explicit permission action such as `mcp.sampling:<serverId>`.
- Sampling must prevent unbounded recursion by rejecting nested MCP sampling requests from the same active MCP request chain.
- `elicitation/create` routes through the existing question resolution path used by `src/tools/builtins/question.ts`.
- Elicitation responses must be validated against the server-provided schema before returning to the MCP server.
- Elicitation must return deterministic decline/cancel results when the user rejects, cancels, or schema validation fails.
- Roots, sampling, and elicitation capabilities must be advertised only when the corresponding handler is installed.

## Resources And Prompts Design

Meta-tools remain the first-pass exposure mechanism.

Tool names:

```txt
mcp_resource_list
mcp_resource_read
mcp_prompt_list
mcp_prompt_get
```

Permission resources:

```txt
mcp.resource:<server>/<uri>
mcp.prompt:<server>/<name>
```

Required behavior:

- Permission checks must happen before `resources/read` and `prompts/get`.
- Meta-tools must not be silently default-allow for read/get operations.
- Resource output must pass through existing output-size handling.
- Prompt arguments must be schema-bounded before model-visible exposure.
- Prompt meta-tools must still register when prompt discovery succeeds, even if resource discovery fails.
- Resource and prompt list changes must refresh service state or mark stale state deterministically.

## OAuth Design

Remote `http` and `sse` servers with OAuth enabled must use OAuth 2.1 authorization-code-with-PKCE.

Required behavior:

- On `401` or `403` with `WWW-Authenticate` protected-resource metadata, discover protected resource metadata.
- Discover authorization server metadata.
- Support preconfigured `oauth.clientId`.
- Support Dynamic Client Registration when `registration_endpoint` exists and no usable client ID is configured.
- Generate PKCE verifier/challenge and state.
- Start a local callback listener using configured `oauth.redirectUri` or `oauth.callbackPort`.
- Exchange authorization code for tokens.
- Refresh access tokens when expired.
- Retry failed bearer requests once after refresh.
- Store tokens under the configured local data directory, not config files.
- Redact access tokens, refresh tokens, authorization headers, client secrets, PKCE verifier, and state in logs/events/snapshots/errors.
- Stdio servers must continue to use env/config credentials and must not use OAuth browser flow by default.

OAuth status shape:

```ts
type McpAuthStatus =
  | { state: "auth_required"; authUrl: string; metadataUrl?: string }
  | { state: "callback_pending"; authUrl: string }
  | { state: "authenticated" }
  | { state: "refresh_failed"; authUrl: string; reason: string }
```

## CLI, TUI, And Events

- `oc2 mcp test <id>` must return success when a server is reachable or when auth is required with an actionable URL.
- CLI text output must include auth URL when status is `auth_required`, `callback_pending`, or `refresh_failed`.
- CLI JSON output must include resource count, prompt count, and auth state.
- TUI MCP status must distinguish `connected`, `auth_required`, `callback_pending`, `authenticated`, `refresh_failed`, and `error`.
- Runtime events must include resource and prompt counts when already discovered without extra server calls.
- Events and snapshots must never include tokens or raw authorization headers.

## Implementation Slices

### PR 1: Transport Correctness And JSON-RPC Errors

- Replace or wrap the hand-rolled request path in `src/mcp/client.ts` with a transport boundary that supports stdio, Streamable HTTP, and SSE consistently.
- Preserve `McpClientFactory` injection.
- Add structured JSON-RPC error handling that preserves `code`, `message`, and `data` internally.
- Redact structured error data before events, logs, snapshots, and model-visible tool output.
- Send MCP `notifications/cancelled` when an aborted request has already been sent.
- Ensure `close()` cleans up child processes, pending requests, fetch/SSE handles, and listeners.
- Add or activate deterministic HTTP fixture tests using `test/mcp/http-fixture-server.ts`.

Verification:

- `bun test test/mcp/protocol-smoke.test.ts`
- `bun test test/mcp/mcp-service.test.ts`
- `bun run typecheck`

Review:

A fresh read-only reviewer must inspect the diff for transport lifecycle cleanup, Streamable HTTP compatibility, SSE notification handling, cancellation semantics, structured error redaction, and unchanged existing tool invocation behavior.

### PR 2: Resource And Prompt Meta-Tool Hardening

- Split resource discovery and prompt discovery so one failure does not prevent the other from registering safe meta-tools.
- Wire `resources/list_changed` and `prompts/list_changed` into `src/mcp/mcp-service.ts`.
- Require explicit permission checks before `mcp_resource_read` and `mcp_prompt_get`.
- Ensure default-allow permission behavior does not accidentally allow resource or prompt reads.
- Bound prompt argument schemas before exposing meta-tools.
- Ensure resource contents use existing output-size limits.
- Add tests for denied resource reads, denied prompt gets, discovery partial failure, and list-changed refresh behavior.

Verification:

- `bun test test/mcp`
- `bun test test/tools`
- `bun run typecheck`

Review:

A fresh read-only reviewer must verify permission checks happen before MCP server calls, resource content cannot bypass output-size limits, prompt schemas are bounded, and discovery failure isolation is deterministic.

### PR 3: Roots In Normal Sessions

- Add host handler construction for normal session runs in `src/session/run.ts`.
- Return `SessionRecord.workspaceRoots` as `file://` roots.
- Advertise `roots: { listChanged: true }` only when the root handler is installed.
- Keep dynamic root updates out of scope except for static per-run roots.
- Add tests proving stdio MCP servers can call `roots/list` during a normal session setup path.

Verification:

- `bun test test/mcp`
- `bun test test/session`
- `bun run typecheck`

Review:

A fresh read-only reviewer must verify roots are advisory only, workspace root URIs are normalized deterministically, and no security boundary is implied by roots.

### PR 4: Sampling Host Handler

- Implement `sampling/createMessage` host handling through `src/model/model-service.ts`.
- Add explicit permission action `mcp.sampling:<serverId>`.
- Reject recursive or nested MCP sampling chains that could create unbounded model work.
- Redact MCP server input where needed before model-visible events.
- Add deterministic tests using a fake model service and fake permission decisions.

Verification:

- `bun test test/mcp`
- `bun test test/session`
- `bun run typecheck`

Review:

A fresh read-only reviewer must check permission gating, recursion prevention, model request isolation, cancellation propagation, and redaction of server-provided sensitive fields.

### PR 5: Elicitation Host Handler

- Implement `elicitation/create` through the existing question resolver path used by `src/tools/builtins/question.ts`.
- Validate user answers against the server-provided schema before returning them.
- Return deterministic decline/cancel responses for user rejection, cancellation, timeout, or schema validation failure.
- Do not silently request secrets; surface secret-looking prompts clearly to the user.
- Add tests for accept, decline, cancel, invalid answer, and schema mismatch.

Verification:

- `bun test test/mcp`
- `bun test test/tools`
- `bun test test/tui`
- `bun run typecheck`

Review:

A fresh read-only reviewer must verify elicitation cannot silently collect secrets, schema validation is deterministic, and declined/cancelled responses are protocol-shaped.

### PR 6: Remote OAuth Flow

- Replace `requiresDeferredOAuth` short-circuit behavior in `src/mcp/auth.ts` and `src/mcp/mcp-service.ts`.
- Integrate protected resource metadata discovery from `WWW-Authenticate`.
- Integrate authorization server metadata discovery.
- Support configured `oauth.clientId`.
- Support DCR when `registration_endpoint` exists.
- Implement PKCE authorization URL generation and callback state validation.
- Add local callback listener using configured redirect/callback settings.
- Exchange authorization code for access/refresh tokens.
- Persist tokens under the local data directory.
- Add bearer authorization to HTTP/SSE MCP requests.
- Refresh expired tokens and retry once.
- Add redaction tests for token storage, events, errors, snapshots, and logs.

Verification:

- `bun test test/mcp`
- `bun test test/config`
- `bun test test/cli`
- `bun run typecheck`

Review:

A fresh read-only security reviewer must inspect token storage location, file permissions where applicable, state/PKCE validation, callback validation, refresh behavior, bearer retry, and token redaction boundaries.

### PR 7: CLI, TUI, Events, And Docs

- Add resource count, prompt count, and auth state to MCP event payloads where already discovered.
- Update `src/cli/output.ts` to show actionable auth URLs and counts.
- Update TUI MCP status projection to distinguish auth states.
- Update `README.md` support matrix to match actual implemented and tested behavior.
- Update `docs/mcp.md` and `docs/authorization.md` to remove deferred OAuth language only after PR 6 is complete.
- Add exact config examples for stdio credentials and remote OAuth.

Verification:

- `bun test test/cli`
- `bun test test/tui`
- `bun test test/mcp`
- `bun run typecheck`

Review:

A fresh read-only reviewer must compare docs and README claims against deterministic tests and verify no status output leaks credentials or tokens.

### PR 8: Compatibility Matrix And Deterministic Fixtures

- Add fixture coverage for stdio, Streamable HTTP, SSE, tools, resources, prompts, roots, sampling, elicitation, cancellation, list-changed notifications, auth-required, OAuth success, OAuth refresh, and malformed server output.
- Add malformed server tests for invalid JSON-RPC, missing result fields, unsupported methods, failed initialization, and bad OAuth metadata.
- Ensure every README support matrix claim has at least one deterministic test.
- Keep upstream protocol docs unchanged unless intentionally refreshing them.

Verification:

- `bun run diagnostics`
- `bun test test/mcp`
- `bun run start mcp list --json`
- `bun run typecheck`

Review:

A fresh read-only reviewer must map each support matrix row to a deterministic test and verify fixture behavior does not depend on external network services.

## Future Work

- Progressive discovery meta-tools after complete protocol support is stable.
- Dynamic root updates during long-running TUI sessions.
- Encrypted OAuth token storage.
- Provider-native MCP tool search integration.
- Generic MCP server hosting.
- Programmatic tool calling/code-mode with a separate sandbox and security spec.

## Open Questions

- Should OAuth tokens be encrypted at rest in the first pass?
  Default: no. Store in the local data directory with strict redaction and filesystem permissions; add encryption later.
- Should resource and prompt reads be default-deny even when the global permission service defaults unmatched rules to allow?
  Default: yes. Reads and prompt gets should require an explicit allow or interactive approval path.
- Should Streamable HTTP use the official MCP TypeScript SDK directly?
  Default: yes if it works cleanly with Bun and preserves `McpClientFactory`; otherwise isolate custom transport logic behind the same boundary.
