import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { type ResolvedMcpServerConfig } from "./config"
import {
  discoverOAuthMetadata,
  discoverOAuthMetadataAt,
  discoverAuthServerMetadata,
  dynamicClientRegistration,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshToken,
  type OAuthTokens,
} from "./auth"
import { redactText } from "../logging/redaction"

export type McpAuthStatus =
  | { readonly state: "auth_required"; readonly error?: string }
  | { readonly state: "callback_pending"; readonly authUrl: string }
  | { readonly state: "authenticated" }
  | { readonly state: "refresh_failed" }

export interface OAuthManager {
  status(): McpAuthStatus
  initFlow(signal: AbortSignal, metadataUrl?: string): Promise<McpAuthStatus>
  handleCallback(code: string, state: string): Promise<void>
  getAuthHeaders(): Promise<Record<string, string>>
  refreshIfNeeded(): Promise<void>
  close(): Promise<void>
}

const AUTH_SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><title>Authorization Successful</title></head>
<body>
<h1>Authorization successful</h1>
<p>You may close this window.</p>
</body>
</html>`

function authFailureHtml(reason: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>Authorization Failed</title></head>
<body>
<h1>Authorization failed</h1>
<p>${escapeHtml(reason)}</p>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function tokenFilePath(dataDir: string, serverId: string): string {
  const safeId = serverId.replace(/[^a-zA-Z0-9_-]/g, "_")
  const dir = join(dataDir, "mcp-tokens")
  return join(dir, `${safeId}.json`)
}

function loadTokens(dataDir: string, serverId: string): OAuthTokens | null {
  const path = tokenFilePath(dataDir, serverId)
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf-8")
    const parsed = JSON.parse(raw) as OAuthTokens
    if (!parsed.accessToken) return null
    return parsed
  } catch {
    return null
  }
}

function saveTokens(dataDir: string, serverId: string, tokens: OAuthTokens): void {
  const path = tokenFilePath(dataDir, serverId)
  const dir = join(dataDir, "mcp-tokens")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path, JSON.stringify(tokens), { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function createOAuthManager(server: ResolvedMcpServerConfig, dataDir: string): OAuthManager {
  let currentStatus: McpAuthStatus = { state: "auth_required" }
  let tokens: OAuthTokens | null = null
  let verifier: string | null = null
  let flowState: string | null = null
  let tokenEndpoint: string | null = null
  let clientId: string | null = null
  let resource: string | null = null
  let authorizationServer: string | null = null
  let redirectUri: string | null = null
  let callbackServer: ReturnType<typeof Bun.serve> | null = null

  const existing = loadTokens(dataDir, server.id)
  if (existing?.accessToken) {
    tokens = existing
    tokenEndpoint = existing.tokenEndpoint ?? null
    clientId = existing.clientId ?? server.oauth?.clientId ?? null
    resource = existing.resource ?? null
    authorizationServer = existing.authorizationServer ?? null
    currentStatus = { state: "authenticated" }
  }

  const isTokenValid = (t: OAuthTokens): boolean => {
    if (!t.accessToken) return false
    if (t.expiresAt !== undefined) {
      const buffer = 60_000
      return Date.now() < t.expiresAt - buffer
    }
    return true
  }

  const status = (): McpAuthStatus => currentStatus

  const initFlow = async (signal: AbortSignal, metadataUrl?: string): Promise<McpAuthStatus> => {
    if (tokens && isTokenValid(tokens)) return currentStatus

    const oauth = server.oauth
    if (!oauth?.enabled) {
      currentStatus = { state: "auth_required", error: "OAuth not enabled" }
      return currentStatus
    }

    const scopes = oauth.scopes ?? []

    if (oauth.clientId) {
      clientId = oauth.clientId
    }

    const serverUrl = server.url ?? ""
    if (!serverUrl) {
      currentStatus = { state: "auth_required", error: "No server URL configured" }
      return currentStatus
    }

    const prm = metadataUrl ? await discoverOAuthMetadataAt(metadataUrl) : await discoverOAuthMetadata(serverUrl)
    if (!prm) {
      currentStatus = { state: "auth_required", error: "Failed to discover OAuth protected resource metadata" }
      return currentStatus
    }
    resource = prm.resource

    const authServerUrl = prm.authorizationServers[0]
    if (!authServerUrl) {
      currentStatus = { state: "auth_required", error: "No authorization server in protected resource metadata" }
      return currentStatus
    }
    authorizationServer = authServerUrl

    const asm = await discoverAuthServerMetadata(authServerUrl)
    if (!asm) {
      currentStatus = { state: "auth_required", error: "Failed to discover authorization server metadata" }
      return currentStatus
    }
    tokenEndpoint = asm.tokenEndpoint

    const callbackPort = oauth.callbackPort ?? 0

    const onAbort = () => {
      if (callbackServer) {
        callbackServer.stop(true)
        callbackServer = null
      }
    }
    signal.addEventListener("abort", onAbort, { once: true })

    try {
      callbackServer = Bun.serve({
        port: callbackPort === 0 ? 0 : callbackPort,
        hostname: "127.0.0.1",
        async fetch(request: Request) {
          const url = new URL(request.url)
          if (url.pathname === "/callback" || url.pathname === "/") {
            const code = url.searchParams.get("code")
            const stateParam = url.searchParams.get("state")

            if (code && stateParam) {
              try {
                await handleCallback(code, stateParam)
                signal.removeEventListener("abort", onAbort)
                if (callbackServer) {
                  callbackServer.stop(true)
                  callbackServer = null
                }
                return new Response(AUTH_SUCCESS_HTML, {
                  headers: { "content-type": "text/html" },
                })
              } catch (err) {
                const reason = err instanceof Error ? err.message : "Unknown error"
                return new Response(authFailureHtml(redactText(reason)), {
                  headers: { "content-type": "text/html" },
                  status: 400,
                })
              }
            }

            return new Response(authFailureHtml("Missing authorization code or state"), {
              headers: { "content-type": "text/html" },
              status: 400,
            })
          }
          return new Response("Not Found", { status: 404 })
        },
      })
    } catch (err) {
      signal.removeEventListener("abort", onAbort)
      throw err instanceof Error ? err : new Error(String(err))
    }

    const actualPort = callbackServer.port
    redirectUri = oauth.redirectUri ?? `http://127.0.0.1:${actualPort}/callback`

    if (!clientId) {
      if (!asm.registrationEndpoint) {
        currentStatus = {
          state: "auth_required",
          error: "No client ID configured and no registration endpoint available",
        }
        await closeCallbackServer()
        signal.removeEventListener("abort", onAbort)
        return currentStatus
      }
      const dcr = await dynamicClientRegistration(asm.registrationEndpoint, "oc2", redirectUri)
      if (!dcr) {
        currentStatus = { state: "auth_required", error: "Dynamic client registration failed" }
        await closeCallbackServer()
        signal.removeEventListener("abort", onAbort)
        return currentStatus
      }
      clientId = dcr.clientId
    }

    const authResult = await buildAuthorizationUrl(asm.authorizationEndpoint, clientId, redirectUri, scopes, resource ?? undefined)
    verifier = authResult.verifier
    flowState = authResult.state

    const authUrl = authResult.url

    currentStatus = { state: "callback_pending", authUrl }
    return currentStatus
  }

  const handleCallback = async (code: string, state: string): Promise<void> => {
    if (flowState === null) {
      throw new Error("No OAuth flow in progress")
    }
    if (state !== flowState) {
      throw new Error("State mismatch in OAuth callback")
    }
    if (!tokenEndpoint || !clientId || !redirectUri || !verifier) {
      throw new Error("OAuth flow not properly initialized")
    }

    const result = await exchangeCodeForTokens(tokenEndpoint, clientId, redirectUri, code, verifier, resource ?? undefined)
    if (!result) {
      throw new Error("Failed to exchange authorization code for tokens")
    }

    verifier = null
    flowState = null
    tokens = { ...result, tokenEndpoint, clientId, resource: resource ?? undefined, authorizationServer: authorizationServer ?? undefined }
    saveTokens(dataDir, server.id, tokens)
    currentStatus = { state: "authenticated" }
  }

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    if (currentStatus.state !== "authenticated" || !tokens) {
      throw new Error("Not authenticated - OAuth flow incomplete")
    }

    if (!isTokenValid(tokens)) {
      await refreshIfNeeded()
      if (currentStatus.state !== "authenticated" || !tokens) {
        throw new Error("Token refresh failed")
      }
    }

    return { Authorization: `Bearer ${tokens.accessToken}` }
  }

  const refreshIfNeeded = async (): Promise<void> => {
    if (!tokens?.refreshToken || !tokenEndpoint || !clientId) {
      currentStatus = { state: "refresh_failed" }
      return
    }

    const newTokens = await refreshToken(tokenEndpoint, clientId, tokens.refreshToken, resource ?? undefined)
    if (!newTokens) {
      currentStatus = { state: "refresh_failed" }
      return
    }

    tokens = { ...newTokens, tokenEndpoint, clientId, resource: resource ?? undefined, authorizationServer: authorizationServer ?? undefined }
    saveTokens(dataDir, server.id, tokens)
    currentStatus = { state: "authenticated" }
  }

  const closeCallbackServer = async (): Promise<void> => {
    if (callbackServer) {
      callbackServer.stop(true)
      callbackServer = null
    }
  }

  const close = async (): Promise<void> => {
    await closeCallbackServer()
    verifier = null
    flowState = null
  }

  return {
    status,
    initFlow,
    handleCallback,
    getAuthHeaders,
    refreshIfNeeded,
    close,
  }
}
