const secretKeyPattern =
  /(?:^|[_-])(?:api[_-]?key|authorization|client[_-]?secret|password|secret|token|access[_-]?token|refresh[_-]?token|cookie|set[_-]?cookie)(?:$|[_-])/i

export const sanitizeForPersistence = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeForPersistence)
  if (!value || typeof value !== "object") return value

  const sanitized: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    if (key === "cause") continue
    sanitized[key] = secretKeyPattern.test(key) ? "[redacted]" : sanitizeForPersistence(nested)
  }
  return sanitized
}
