import type { RuntimeEventBus } from "../events/event-bus"
import type { Oc2Config } from "../config/schema"
import { ToolExecutionError, type ToolPermissionDecision, type ToolPermissionRequest } from "./tool"

export type ToolPermissionRule = NonNullable<Oc2Config["tools"][string]["permissions"]>[number]

export interface PermissionResolverResult {
  readonly decision: ToolPermissionDecision
  readonly remember?: boolean
}

export interface ToolPermissionServiceOptions {
  readonly events?: RuntimeEventBus<unknown>
  readonly rules?: readonly ToolPermissionRule[]
  readonly resolver?: (request: ToolPermissionRequest, signal: AbortSignal) => Promise<PermissionResolverResult | ToolPermissionDecision>
}

export interface ToolPermissionService {
  decide(request: ToolPermissionRequest, signal: AbortSignal): Promise<ToolPermissionDecision>
}

export const createToolPermissionService = (options: ToolPermissionServiceOptions = {}): ToolPermissionService => {
  const savedRules: ToolPermissionRule[] = []

  return {
    async decide(request, signal) {
      const configured = findDecision([...options.rules ?? [], ...savedRules], request)
      const decision = configured ?? "allow"
      if (decision !== "ask") return decision

      const permissionId = crypto.randomUUID()
      options.events?.publish({ type: "permission.requested", payload: { permissionId, toolName: request.toolName } })
      const resolved = options.resolver ? await options.resolver(request, signal) : "deny"
      const normalized = typeof resolved === "string" ? { decision: resolved } : resolved
      options.events?.publish({ type: "permission.resolved", payload: { permissionId, decision: normalized.decision === "allow" ? "allow" : "deny" } })

      if (normalized.remember) {
        savedRules.push({ match: request.resource, decision: normalized.decision })
      }
      return normalized.decision
    },
  }
}

export const assertToolPermission = async (
  service: ToolPermissionService,
  request: ToolPermissionRequest,
  signal: AbortSignal,
): Promise<void> => {
  const decision = await service.decide(request, signal)
  if (decision !== "allow") {
    throw new ToolExecutionError({ code: "permission_denied", message: `Permission denied for ${request.toolName}`, details: { request, decision } })
  }
}

export const findDecision = (
  rules: readonly ToolPermissionRule[],
  request: ToolPermissionRequest,
): ToolPermissionDecision | undefined => {
  let decision: ToolPermissionDecision | undefined
  const candidates = [request.toolName, request.action, request.resource, `${request.toolName}:${request.resource}`, `${request.action}:${request.resource}`]

  for (const rule of rules) {
    if (!rule.decision) continue
    const pattern = rule.match ?? "*"
    if (candidates.some((candidate) => wildcardMatch(pattern, candidate))) {
      decision = rule.decision
    }
  }

  return decision
}

export const wildcardMatch = (pattern: string, value: string): boolean => {
  if (pattern === "*" || pattern === value) return true
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
  return new RegExp(`^${escaped}$`).test(value)
}
