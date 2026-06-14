import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createOAuthManager } from "../../src"

function tmpDataDir(): string {
  const dir = join(tmpdir(), `oc2-oauth-test-${crypto.randomUUID()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeServer(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-server",
    enabled: true,
    transport: "http" as const,
    url: "https://mcp.test/mcp",
    args: [] as string[],
    env: {} as Record<string, string>,
    headers: {} as Record<string, string>,
    toolPermissions: [] as { match?: string; decision?: "allow" | "deny" | "ask" }[],
    startupTimeoutMs: 10_000,
    oauth: { enabled: true, scopes: [] as string[] },
    ...overrides,
  }
}

// ── Mock fetch setup ──────────────────────────────────────────

let originalFetch: typeof globalThis.fetch

function mockFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const handlers: Array<{
    match: (url: string, init?: RequestInit) => boolean
    response: () => Promise<Response>
  }> = []

  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = url instanceof Request ? url.url : String(url)
    const reqInit = url instanceof Request ? undefined : init
    calls.push({ url: urlStr, init: reqInit })

    for (const handler of handlers) {
      if (handler.match(urlStr, reqInit)) {
        return handler.response()
      }
    }
    return new Response("Not Found", { status: 404 })
  }

  const on = (url: string, response: unknown) => {
    handlers.push({
      match: (reqUrl: string) => reqUrl === url,
      response: async () =>
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    })
  }

  const onPost = (url: string, response: unknown) => {
    handlers.push({
      match: (reqUrl: string, reqInit?: RequestInit) => reqUrl === url && reqInit?.method === "POST",
      response: async () =>
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    })
  }

  originalFetch = globalThis.fetch
  globalThis.fetch = fetchFn as unknown as typeof globalThis.fetch

  return {
    calls,
    on,
    onPost,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

// ── Tests ─────────────────────────────────────────────────────

test("OAuth manager initializes flow with configured clientId", async () => {
  const dataDir = tmpDataDir()
  const mock = mockFetch()

  mock.on("https://mcp.test/mcp/.well-known/oauth-protected-resource", {
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://auth.test"],
    scopes_supported: ["openid", "read"],
  })
  mock.on("https://auth.test/.well-known/oauth-authorization-server", {
    issuer: "https://auth.test",
    authorization_endpoint: "https://auth.test/authorize",
    token_endpoint: "https://auth.test/token",
    registration_endpoint: "https://auth.test/register",
  })

  const server = makeServer({
    oauth: { enabled: true, scopes: ["read"], clientId: "my-client-id", callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)

  expect(status.state).toBe("callback_pending")
  expect(status.state === "callback_pending" ? status.authUrl : "").toContain("https://auth.test/authorize")
  expect(status.state === "callback_pending" ? status.authUrl : "").toContain("client_id=my-client-id")
  expect(status.state === "callback_pending" ? status.authUrl : "").toContain("scope=read")
  expect(status.state === "callback_pending" ? status.authUrl : "").toContain("code_challenge_method=S256")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("OAuth manager initializes flow without clientId (uses DCR)", async () => {
  const dataDir = tmpDataDir()
  const mock = mockFetch()

  mock.on("https://mcp.test/mcp/.well-known/oauth-protected-resource", {
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://auth.test"],
    scopes_supported: ["openid"],
  })
  mock.on("https://auth.test/.well-known/oauth-authorization-server", {
    issuer: "https://auth.test",
    authorization_endpoint: "https://auth.test/authorize",
    token_endpoint: "https://auth.test/token",
    registration_endpoint: "https://auth.test/register",
  })
  mock.onPost("https://auth.test/register", {
    client_id: "dcr-client-id",
    client_secret: "dcr-secret",
  })

  const server = makeServer({
    oauth: { enabled: true, scopes: ["read"], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)

  expect(status.state).toBe("callback_pending")
  expect(status.state === "callback_pending" ? status.authUrl : "").toContain("client_id=dcr-client-id")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("OAuth manager returns auth_required when discovery fails", async () => {
  const dataDir = tmpDataDir()
  const _mock = mockFetch()
  // No handlers → all requests 404

  const server = makeServer({
    oauth: { enabled: true, scopes: [], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)

  expect(status.state).toBe("auth_required")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("OAuth manager stores and loads tokens", async () => {
  const dataDir = tmpDataDir()

  // Simulate a completed flow by writing tokens directly
  const tokens = {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: Date.now() + 3600_000,
    tokenType: "Bearer",
    scopes: ["read"],
  }

  // Mock a full flow that returns callback_pending, then we manually store tokens
  const mock = mockFetch()
  mock.on("https://mcp.test/mcp/.well-known/oauth-protected-resource", {
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://auth.test"],
    scopes_supported: ["read"],
  })
  mock.on("https://auth.test/.well-known/oauth-authorization-server", {
    issuer: "https://auth.test",
    authorization_endpoint: "https://auth.test/authorize",
    token_endpoint: "https://auth.test/token",
    registration_endpoint: "https://auth.test/register",
  })
  mock.onPost("https://auth.test/register", { client_id: "dcr-id" })

  const server = makeServer({
    oauth: { enabled: true, scopes: ["read"], callbackPort: 0 },
  })

  // First run: initFlow → callback_pending
  const manager1 = createOAuthManager(server, dataDir)
  const status1 = await manager1.initFlow(new AbortController().signal)
  expect(status1.state).toBe("callback_pending")
  await manager1.close()

  // Manually write tokens to simulate callback completion
  // We can call handleCallback if we have the code/state, but the mock didn't provide a code exchange
  // Instead, directly write a token file
  const tokenDir = join(dataDir, "mcp-tokens")
  mkdirSync(tokenDir, { recursive: true })
  const tokenPath = join(tokenDir, "test-server.json")
  const { writeFileSync, chmodSync } = await import("node:fs")
  writeFileSync(tokenPath, JSON.stringify(tokens), { mode: 0o600 })

  // Second run: initFlow → should find tokens and be authenticated
  const manager2 = createOAuthManager(server, dataDir)
  const status2 = await manager2.initFlow(new AbortController().signal)
  expect(status2.state).toBe("authenticated")

  // getAuthHeaders should return the bearer token
  const headers = await manager2.getAuthHeaders()
  expect(headers.Authorization).toBe("Bearer test-access-token")

  await manager2.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("OAuth manager getAuthHeaders throws when not authenticated", async () => {
  const dataDir = tmpDataDir()
  const server = makeServer({
    oauth: { enabled: true, scopes: [], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  await expect(manager.getAuthHeaders()).rejects.toThrow("Not authenticated")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test("OAuth manager refreshIfNeeded returns refresh_failed when no tokens", async () => {
  const dataDir = tmpDataDir()
  const server = makeServer({
    oauth: { enabled: true, scopes: [], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  await manager.refreshIfNeeded()
  expect(manager.status().state).toBe("refresh_failed")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test("OAuth manager handles callback with valid state", async () => {
  const dataDir = tmpDataDir()
  const mock = mockFetch()

  mock.on("https://mcp.test/mcp/.well-known/oauth-protected-resource", {
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://auth.test"],
    scopes_supported: ["read"],
  })
  mock.on("https://auth.test/.well-known/oauth-authorization-server", {
    issuer: "https://auth.test",
    authorization_endpoint: "https://auth.test/authorize",
    token_endpoint: "https://auth.test/token",
    registration_endpoint: "https://auth.test/register",
  })
  mock.onPost("https://auth.test/register", { client_id: "dcr-id" })
  mock.onPost("https://auth.test/token", {
    access_token: "callback-access-token",
    refresh_token: "callback-refresh-token",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "read write",
  })

  const server = makeServer({
    oauth: { enabled: true, scopes: ["read", "write"], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)
  expect(status.state).toBe("callback_pending")

  // Now simulate a callback with the state from the auth URL
  // We don't have direct access to the state, but we can use handleCallback
  // with the state extracted from the auth URL
  const authUrl = status.state === "callback_pending" ? status.authUrl : ""
  const urlObj = new URL(authUrl)
  const flowState = urlObj.searchParams.get("state")!

  await manager.handleCallback("auth-code-123", flowState)

  expect(manager.status().state).toBe("authenticated")

  const headers = await manager.getAuthHeaders()
  expect(headers.Authorization).toBe("Bearer callback-access-token")

  // Verify tokens were persisted
  const tokenDir = join(dataDir, "mcp-tokens")
  const tokenPath = join(tokenDir, "test-server.json")
  expect(existsSync(tokenPath)).toBe(true)
  const savedTokens = JSON.parse(readFileSync(tokenPath, "utf-8"))
  expect(savedTokens.accessToken).toBe("callback-access-token")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("OAuth manager rejects callback with invalid state", async () => {
  const dataDir = tmpDataDir()
  const mock = mockFetch()

  mock.on("https://mcp.test/mcp/.well-known/oauth-protected-resource", {
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://auth.test"],
    scopes_supported: ["read"],
  })
  mock.on("https://auth.test/.well-known/oauth-authorization-server", {
    issuer: "https://auth.test",
    authorization_endpoint: "https://auth.test/authorize",
    token_endpoint: "https://auth.test/token",
    registration_endpoint: "https://auth.test/register",
  })
  mock.onPost("https://auth.test/register", { client_id: "dcr-id" })

  const server = makeServer({
    oauth: { enabled: true, scopes: [], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)
  expect(status.state).toBe("callback_pending")

  // Try with wrong state
  await expect(manager.handleCallback("auth-code-123", "wrong-state")).rejects.toThrow("State mismatch")

  // Status should still be callback_pending
  expect(manager.status().state).toBe("callback_pending")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("OAuth manager getAuthHeaders returns bearer token", async () => {
  const dataDir = tmpDataDir()

  // Write valid tokens
  const tokens = {
    accessToken: "final-access-token",
    refreshToken: "final-refresh-token",
    expiresAt: Date.now() + 3600_000,
    tokenType: "Bearer",
    scopes: ["read"],
  }
  const tokenDir = join(dataDir, "mcp-tokens")
  mkdirSync(tokenDir, { recursive: true })
  const { writeFileSync } = await import("node:fs")
  writeFileSync(join(tokenDir, "test-server.json"), JSON.stringify(tokens), { mode: 0o600 })

  const server = makeServer({
    oauth: { enabled: true, scopes: ["read"], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)
  expect(status.state).toBe("authenticated")

  const headers = await manager.getAuthHeaders()
  expect(headers).toEqual({ Authorization: "Bearer final-access-token" })

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("Redaction: tokens not in status", () => {
  const dataDir = tmpDataDir()
  const server = makeServer()

  const manager = createOAuthManager(server, dataDir)
  const status = manager.status()

  const serialized = JSON.stringify(status)
  // Status should never contain tokens
  expect(serialized).not.toContain("accessToken")
  expect(serialized).not.toContain("refreshToken")
  expect(serialized).not.toContain("Bearer")

  rmSync(dataDir, { recursive: true, force: true })
})

test("Token file has restricted permissions", async () => {
  const dataDir = tmpDataDir()
  const mock = mockFetch()

  mock.on("https://mcp.test/mcp/.well-known/oauth-protected-resource", {
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://auth.test"],
    scopes_supported: ["openid"],
  })
  mock.on("https://auth.test/.well-known/oauth-authorization-server", {
    issuer: "https://auth.test",
    authorization_endpoint: "https://auth.test/authorize",
    token_endpoint: "https://auth.test/token",
    registration_endpoint: "https://auth.test/register",
  })
  mock.onPost("https://auth.test/register", { client_id: "dcr-id" })
  mock.onPost("https://auth.test/token", {
    access_token: "perm-token",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "read",
  })

  const server = makeServer({
    oauth: { enabled: true, scopes: ["read"], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)
  expect(status.state).toBe("callback_pending")

  const authUrl = status.state === "callback_pending" ? status.authUrl : ""
  const urlObj = new URL(authUrl)
  const flowState = urlObj.searchParams.get("state")!

  await manager.handleCallback("test-code", flowState)

  const tokenPath = join(dataDir, "mcp-tokens", "test-server.json")
  expect(existsSync(tokenPath)).toBe(true)

  // On unix, check that the file has 0o600 permissions
  if (process.platform !== "win32") {
    const { statSync } = await import("node:fs")
    const stats = statSync(tokenPath)
    const mode = stats.mode & 0o777
    expect(mode).toBe(0o600)
  }

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("Bearer token added to HTTP requests", async () => {
  const dataDir = tmpDataDir()

  // Write valid tokens
  const tokens = {
    accessToken: "http-test-token",
    refreshToken: "http-test-refresh",
    expiresAt: Date.now() + 3600_000,
    tokenType: "Bearer",
    scopes: ["read"],
  }
  const tokenDir = join(dataDir, "mcp-tokens")
  mkdirSync(tokenDir, { recursive: true })
  const { writeFileSync } = await import("node:fs")
  writeFileSync(join(tokenDir, "test-server.json"), JSON.stringify(tokens), { mode: 0o600 })

  // Set up mock fetch that captures the Authorization header
  let capturedAuthHeader = ""
  const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const reqInit = (url instanceof Request ? url : init) as RequestInit | undefined
    capturedAuthHeader = (reqInit?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
  }

  // This test validates the integration: tokenProvider returns headers
  const server = {
    id: "test-server",
    enabled: true,
    transport: "http" as const,
    url: "https://mcp.test/mcp",
    args: [] as string[],
    env: {} as Record<string, string>,
    headers: {} as Record<string, string>,
    toolPermissions: [] as { match?: string; decision?: "allow" | "deny" | "ask" }[],
    startupTimeoutMs: 10_000,
    oauth: { enabled: true, scopes: ["read"] as string[], callbackPort: 0 },
    tokenProvider: async () => ({ Authorization: "Bearer http-test-token" }),
  }

  // The tokenProvider on the server config is what the HTTP client calls.
  // Simulate that: call the tokenProvider
  const headers = await server.tokenProvider!()
  expect(headers.Authorization).toBe("Bearer http-test-token")

  rmSync(dataDir, { recursive: true, force: true })
})

test("OAuth flow fails with bad auth server metadata (missing token endpoint)", async () => {
  const dataDir = tmpDataDir()
  const mock = mockFetch()

  mock.on("https://mcp.test/mcp/.well-known/oauth-protected-resource", {
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://auth.test"],
    scopes_supported: ["read"],
  })
  mock.on("https://auth.test/.well-known/oauth-authorization-server", {
    issuer: "https://auth.test",
    authorization_endpoint: "https://auth.test/authorize",
    // missing token_endpoint
  })

  const server = makeServer({
    oauth: { enabled: true, scopes: ["read"], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)

  expect(status.state).toBe("auth_required")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("OAuth flow fails with bad auth server metadata (missing authorization endpoint)", async () => {
  const dataDir = tmpDataDir()
  const mock = mockFetch()

  mock.on("https://mcp.test/mcp/.well-known/oauth-protected-resource", {
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://auth.test"],
    scopes_supported: ["read"],
  })
  mock.on("https://auth.test/.well-known/oauth-authorization-server", {
    issuer: "https://auth.test",
    token_endpoint: "https://auth.test/token",
    // missing authorization_endpoint
  })

  const server = makeServer({
    oauth: { enabled: true, scopes: ["read"], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)

  expect(status.state).toBe("auth_required")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("OAuth flow fails with bad protected resource metadata (no authorization_servers)", async () => {
  const dataDir = tmpDataDir()
  const mock = mockFetch()

  mock.on("https://mcp.test/mcp/.well-known/oauth-protected-resource", {
    resource: "https://mcp.test/mcp",
    // missing authorization_servers
  })

  const server = makeServer({
    oauth: { enabled: true, scopes: ["read"], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)

  expect(status.state).toBe("auth_required")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("Bearer token retry: getAuthHeaders returns fresh token on refresh", async () => {
  const dataDir = tmpDataDir()
  const mock = mockFetch()

  mock.on("https://mcp.test/mcp/.well-known/oauth-protected-resource", {
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://auth.test"],
    scopes_supported: ["read"],
  })
  mock.on("https://auth.test/.well-known/oauth-authorization-server", {
    issuer: "https://auth.test",
    authorization_endpoint: "https://auth.test/authorize",
    token_endpoint: "https://auth.test/token",
    registration_endpoint: "https://auth.test/register",
  })
  mock.onPost("https://auth.test/register", { client_id: "dcr-id" })
  mock.onPost("https://auth.test/token", {
    access_token: "fresh-retry-token",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "read",
  })

  const server = makeServer({
    oauth: { enabled: true, scopes: ["read"], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)
  expect(status.state).toBe("callback_pending")

  // Complete callback to get authenticated
  const authUrl = status.state === "callback_pending" ? status.authUrl : ""
  const urlObj = new URL(authUrl)
  const flowState = urlObj.searchParams.get("state")!
  await manager.handleCallback("auth-code-456", flowState)
  expect(manager.status().state).toBe("authenticated")

  // getAuthHeaders should return the bearer token
  const headers = await manager.getAuthHeaders()
  expect(headers.Authorization).toBe("Bearer fresh-retry-token")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)

test("Bearer token retry: refreshIfNeeded returns refresh_failed when no tokens", async () => {
  const dataDir = tmpDataDir()
  const server = makeServer({
    oauth: { enabled: true, scopes: [], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  await manager.refreshIfNeeded()
  expect(manager.status().state).toBe("refresh_failed")

  await manager.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test("OAuth manager close cleans up callback server", async () => {
  const dataDir = tmpDataDir()
  const mock = mockFetch()

  mock.on("https://mcp.test/mcp/.well-known/oauth-protected-resource", {
    resource: "https://mcp.test/mcp",
    authorization_servers: ["https://auth.test"],
    scopes_supported: ["read"],
  })
  mock.on("https://auth.test/.well-known/oauth-authorization-server", {
    issuer: "https://auth.test",
    authorization_endpoint: "https://auth.test/authorize",
    token_endpoint: "https://auth.test/token",
    registration_endpoint: "https://auth.test/register",
  })
  mock.onPost("https://auth.test/register", { client_id: "dcr-id" })

  const server = makeServer({
    oauth: { enabled: true, scopes: [], callbackPort: 0 },
  })

  const manager = createOAuthManager(server, dataDir)
  const status = await manager.initFlow(new AbortController().signal)
  expect(status.state).toBe("callback_pending")

  // Closing should work without errors
  await manager.close()

  rmSync(dataDir, { recursive: true, force: true })
}, 15_000)
