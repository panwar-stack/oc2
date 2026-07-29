import { canonicalConfigPath, contentDigest } from "./hot-reload"

export type ConfigWriteRejectionReason = "parse" | "schema" | "bootstrap" | "unsupported"

export function configWriteRejection(input: unknown): {
  readonly reason: ConfigWriteRejectionReason
  readonly message: string
} | undefined {
  const name = input instanceof Error ? input.name.toLowerCase() : ""
  const tag =
    input && typeof input === "object" && "_tag" in input && typeof input._tag === "string"
      ? input._tag.toLowerCase()
      : ""
  const kind = `${name} ${tag}`
  if (kind.includes("unsupported"))
    return { reason: "unsupported", message: "This configuration change requires a restart." }
  if (kind.includes("parse") || kind.includes("json"))
    return { reason: "parse", message: "The configuration file could not be parsed." }
  if (kind.includes("invalid") || kind.includes("schema"))
    return { reason: "schema", message: "The configuration did not pass validation." }
  return undefined
}

export class ConfigWriteRejected extends Error {
  readonly path: string
  readonly digest: string
  readonly reason: ConfigWriteRejectionReason
  readonly publicMessage: string

  constructor(input: {
    readonly path: string
    readonly digest: string
    readonly reason: ConfigWriteRejectionReason
    readonly message: string
  }) {
    super(input.message)
    this.name = "ConfigWriteRejected"
    this.path = canonicalConfigPath(input.path)
    this.digest = input.digest
    this.reason = input.reason
    this.publicMessage = input.message
  }

  static fromCandidate(path: string, content: string | Uint8Array, error: unknown) {
    const diagnostic = configWriteRejection(error)
    if (!diagnostic) return undefined
    return new ConfigWriteRejected({ path, digest: contentDigest(content), ...diagnostic })
  }
}
