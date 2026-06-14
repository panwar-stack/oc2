export type DiagnosticLevel = "info" | "warning" | "error"

export interface Diagnostic {
  level: DiagnosticLevel
  code: string
  message: string
  path?: string
  details?: Record<string, unknown>
}

export interface DiagnosticReport {
  generatedAt: string
  environment: Record<string, unknown>
  diagnostics: Diagnostic[]
}

/** Creates a diagnostic shape while omitting undefined optional fields. */
export function createDiagnostic(
  level: DiagnosticLevel,
  code: string,
  message: string,
  options: { path?: string; details?: Record<string, unknown> } = {},
): Diagnostic {
  return {
    level,
    code,
    message,
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.details === undefined ? {} : { details: options.details }),
  }
}

/** Builds the serializable diagnostics payload emitted by the CLI. */
export function createDiagnosticReport(
  environment: Record<string, unknown>,
  diagnostics: Diagnostic[],
  generatedAt = new Date().toISOString(),
): DiagnosticReport {
  return {
    generatedAt,
    environment,
    diagnostics,
  }
}
