const secretKeyPattern =
  /(api[_-]?key|token|secret|password|authorization|cookie|set-cookie|clientsecret|client_secret|code[_-]?verifier|code[_-]?challenge|authorization[_-]?code|auth[_-]?code|pkce)/i
const bearerPattern = /Bearer\s+[A-Za-z0-9._~+/=-]+/g
const apiKeyPattern = /\b(sk|oc2|anthropic|openai)-[A-Za-z0-9_-]{8,}\b/g

export const REDACTED = "[REDACTED]"

/** Returns true when a field name conventionally carries sensitive material. */
export function isSecretKey(key: string): boolean {
  return secretKeyPattern.test(key)
}

/** Redacts inline bearer tokens and common API-key prefixes in free-form text. */
export function redactText(value: string): string {
  return value.replace(bearerPattern, `Bearer ${REDACTED}`).replace(apiKeyPattern, REDACTED)
}

/** Recursively redacts strings and object fields before values leave process logs. */
export function redactValue(value: unknown, parentKey = ""): unknown {
  if (isSecretKey(parentKey)) return REDACTED
  if (typeof value === "string") return redactText(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item))
  if (typeof value !== "object" || value === null) return value

  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child, key)]))
}
