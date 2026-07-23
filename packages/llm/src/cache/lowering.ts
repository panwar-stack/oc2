import type { LLMRequest } from "../schema/messages"
import type { CacheDuration, CachePlan } from "./capability"

const EXPLICIT_OPENAI_CACHE_DENYLIST = new Set(["deepseek", "kimi", "moonshot", "moonshot-ai", "moonshotai"])

export const requestCachePlan = (request: LLMRequest): CachePlan | undefined => {
  const plan = request.metadata?.cachePlan
  if (!isCachePlan(plan)) return undefined
  return plan
}

export const openAIPromptCacheKey = (request: LLMRequest): string | undefined => {
  const provider = String(request.model.provider).toLowerCase()
  const model = String(request.model.id).toLowerCase()
  if (EXPLICIT_OPENAI_CACHE_DENYLIST.has(provider) || model.includes("kimi")) return undefined

  const plan = requestCachePlan(request)
  if (plan?.provider === "openai" && plan.mode !== "disabled" && plan.eligible && plan.cacheKey) return plan.cacheKey
  return undefined
}

export const planHasBreakpoint = (
  plan: CachePlan | undefined,
  component: string,
  index: number,
  supportedContentTypes: ReadonlySet<string>,
  maximum: number,
) => {
  if (!plan || plan.mode !== "explicit" || !plan.eligible) return false
  const supported = plan.breakpoints.filter((breakpoint) => supportedContentTypes.has(breakpoint.contentType))
  return supported
    .slice(Math.max(0, supported.length - maximum))
    .some((breakpoint) => breakpoint.component === component && breakpoint.index === index)
}

export const planDuration = (
  plan: CachePlan | undefined,
  supported: ReadonlySet<CacheDuration>,
): CacheDuration | undefined => {
  if (!plan?.duration || !supported.has(plan.duration)) return undefined
  return plan.duration
}

const isCachePlan = (value: unknown): value is CachePlan =>
  typeof value === "object" &&
  value !== null &&
  "provider" in value &&
  "model" in value &&
  "mode" in value &&
  "cacheKey" in value &&
  "breakpoints" in value &&
  Array.isArray(value.breakpoints)

export * as CacheLowering from "./lowering"
