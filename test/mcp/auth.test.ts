import { expect, test } from "bun:test"

import {
  createMcpService,
  createToolRegistry,
  defaultConfig,
  McpAuthRequiredError,
  requiresDeferredOAuth,
} from "../../src"

test("requiresDeferredOAuth returns false when OAuth is not enabled", () => {
  const srv = {
    id: "test",
    enabled: true,
    transport: "http" as const,
    url: "https://example.test/mcp",
    args: [] as string[],
    env: {} as Record<string, string>,
    headers: {} as Record<string, string>,
    toolPermissions: [] as { match?: string; decision?: "allow" | "deny" | "ask" }[],
    startupTimeoutMs: 10_000,
  }
  expect(requiresDeferredOAuth(srv)).toBe(false)
})

test("requiresDeferredOAuth returns false for remote OAuth servers", () => {
  const srv = {
    id: "test",
    enabled: true,
    transport: "http" as const,
    url: "https://example.test/mcp",
    args: [] as string[],
    env: {} as Record<string, string>,
    headers: {} as Record<string, string>,
    toolPermissions: [] as { match?: string; decision?: "allow" | "deny" | "ask" }[],
    startupTimeoutMs: 10_000,
    oauth: { enabled: true, scopes: [] as string[] },
  }
  expect(requiresDeferredOAuth(srv)).toBe(false)
})

test("requiresDeferredOAuth returns true for stdio OAuth servers", () => {
  const srv = {
    id: "test",
    enabled: true,
    transport: "stdio" as const,
    command: "oauth-stdio-server",
    args: [] as string[],
    env: {} as Record<string, string>,
    headers: {} as Record<string, string>,
    toolPermissions: [] as { match?: string; decision?: "allow" | "deny" | "ask" }[],
    startupTimeoutMs: 10_000,
    oauth: { enabled: true, scopes: [] as string[] },
  }
  expect(requiresDeferredOAuth(srv)).toBe(true)
})

test("McpAuthRequiredError carries metadata URL", () => {
  const err = new McpAuthRequiredError("auth required", "https://example.test/.well-known/oauth-protected-resource")
  expect(err.metadataUrl).toBe("https://example.test/.well-known/oauth-protected-resource")
  expect(err.name).toBe("McpAuthRequiredError")
  expect(err.message).toBe("auth required")
  expect(JSON.stringify(err)).not.toContain("secret")
})

test("access token is redacted in McpAuthRequiredError messages", () => {
  const err = new McpAuthRequiredError("failed with Bearer sk-secret-token-12345")
  const serialized = JSON.stringify(err)
  expect(serialized).not.toContain("secret-token")
})

test("authUrl appears in auth_required MCP status", async () => {
  const registry = createToolRegistry()
  const config = {
    ...defaultConfig,
    mcp: {
      remote: {
        enabled: true,
        transport: "http" as const,
        url: "https://example.test/mcp",
        args: [] as string[],
        env: {} as Record<string, string>,
        headers: {} as Record<string, string>,
        toolPermissions: [] as { match?: string; decision?: "allow" | "deny" | "ask" }[],
        startupTimeoutMs: 10_000,
      },
    },
  }

  const service = createMcpService({
    config,
    registry,
    clientFactory: () => {
      throw new McpAuthRequiredError("auth required", "https://example.test/.well-known/oauth-protected-resource")
    },
  })

  const status = await service.test("remote")
  expect(status.status).toBe("auth_required")
  expect(status.authUrl).toBe("https://example.test/.well-known/oauth-protected-resource")
})

test("HTTP auth failures without metadata URL still report auth_required", async () => {
  const registry = createToolRegistry()
  const config = {
    ...defaultConfig,
    mcp: {
      server: {
        enabled: true,
        transport: "http" as const,
        url: "https://example.test/mcp",
        args: [] as string[],
        env: {} as Record<string, string>,
        headers: {} as Record<string, string>,
        toolPermissions: [] as { match?: string; decision?: "allow" | "deny" | "ask" }[],
        startupTimeoutMs: 10_000,
      },
    },
  }

  const service = createMcpService({
    config,
    registry,
    clientFactory: () => {
      throw new McpAuthRequiredError("Bearer secret-token")
    },
  })

  const status = await service.test("server")
  expect(status.status).toBe("auth_required")
  expect(status.authUrl).toBeUndefined()
  expect(JSON.stringify(status)).not.toContain("secret-token")
})
