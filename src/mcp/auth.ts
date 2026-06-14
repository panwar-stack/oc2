import type { ResolvedMcpServerConfig } from "./config"

export interface OAuthTokens {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt?: number
  readonly tokenType: string
  readonly scopes: readonly string[]
}

export interface OAuthClientState {
  readonly state: "pending" | "authenticated" | "refresh_failed"
  readonly authUrl?: string
  readonly tokens?: OAuthTokens
}

async function sha256(buffer: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder()
  return crypto.subtle.digest("SHA-256", encoder.encode(buffer))
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes.buffer)
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256(verifier))
}

function generateState(): string {
  return crypto.randomUUID()
}

export function requiresDeferredOAuth(server: ResolvedMcpServerConfig): boolean {
  return server.oauth?.enabled === true
}

export async function discoverOAuthMetadata(serverUrl: string): Promise<{
  authorizationServers: string[]
  scopesSupported: string[]
  resource: string
} | null> {
  const prmUrl = `${serverUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource`
  try {
    const response = await fetch(prmUrl, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const metadata = (await response.json()) as Record<string, unknown>
    if (!metadata.resource) return null
    return {
      resource: String(metadata.resource),
      authorizationServers: Array.isArray(metadata.authorization_servers)
        ? (metadata.authorization_servers as string[]).map(String)
        : [],
      scopesSupported: Array.isArray(metadata.scopes_supported)
        ? (metadata.scopes_supported as string[]).map(String)
        : [],
    }
  } catch {
    return null
  }
}

export async function discoverAuthServerMetadata(issuerUrl: string): Promise<{
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
} | null> {
  const metadataUrl = `${issuerUrl.replace(/\/$/, "")}/.well-known/oauth-authorization-server`
  try {
    const response = await fetch(metadataUrl, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    const metadata = (await response.json()) as Record<string, unknown>
    if (!metadata.token_endpoint) return null
    return {
      authorizationEndpoint: String(metadata.authorization_endpoint),
      tokenEndpoint: String(metadata.token_endpoint),
      registrationEndpoint:
        typeof metadata.registration_endpoint === "string" ? metadata.registration_endpoint : undefined,
    }
  } catch {
    return null
  }
}

export async function dynamicClientRegistration(
  registrationEndpoint: string,
  clientName: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string } | null> {
  try {
    const response = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const result = (await response.json()) as Record<string, unknown>
    return {
      clientId: String(result.client_id ?? ""),
      clientSecret: typeof result.client_secret === "string" ? result.client_secret : undefined,
    }
  } catch {
    return null
  }
}

export async function buildAuthorizationUrl(
  authorizationEndpoint: string,
  clientId: string,
  redirectUri: string,
  scopes: string[],
): Promise<{ url: string; verifier: string; state: string }> {
  const verifier = generateCodeVerifier()
  const challenge = await generateCodeChallenge(verifier)
  const state = generateState()
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })
  if (scopes.length > 0) {
    params.set("scope", scopes.join(" "))
  }
  const url = `${authorizationEndpoint}?${params.toString()}`
  return { url, verifier, state }
}

export async function exchangeCodeForTokens(
  tokenEndpoint: string,
  clientId: string,
  redirectUri: string,
  code: string,
  verifier: string,
): Promise<OAuthTokens | null> {
  try {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const result = (await response.json()) as Record<string, unknown>
    return {
      accessToken: String(result.access_token ?? ""),
      refreshToken: typeof result.refresh_token === "string" ? result.refresh_token : undefined,
      expiresAt: typeof result.expires_in === "number" ? Date.now() + result.expires_in * 1000 : undefined,
      tokenType: String(result.token_type ?? "Bearer"),
      scopes: typeof result.scope === "string" ? result.scope.split(" ") : [],
    }
  } catch {
    return null
  }
}

export async function refreshToken(
  tokenEndpoint: string,
  clientId: string,
  token: string,
): Promise<OAuthTokens | null> {
  try {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: clientId,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const result = (await response.json()) as Record<string, unknown>
    return {
      accessToken: String(result.access_token ?? ""),
      refreshToken: typeof result.refresh_token === "string" ? result.refresh_token : token,
      expiresAt: typeof result.expires_in === "number" ? Date.now() + result.expires_in * 1000 : undefined,
      tokenType: String(result.token_type ?? "Bearer"),
      scopes: typeof result.scope === "string" ? result.scope.split(" ") : [],
    }
  } catch {
    return null
  }
}
