import type { LLMRequest } from "../schema/messages"
import type { CachePlan } from "./capability"
import type { CacheBoundaryPlan } from "./planner"
import { planCacheRequest } from "./planner"
import type { CacheFingerprintComponentName } from "./fingerprint"

export const LOCAL_CACHE_REGRESSION_REPORT_VERSION = 1

export type LocalCacheRegressionStatus = "pass" | "fail" | "skip" | "inconclusive"

export type LocalCacheRegressionCompareExpectation = "same" | "different"

export type LocalCacheRegressionCacheKeyExpectation =
  | LocalCacheRegressionCompareExpectation
  | "present"
  | "absent"
  | "ignore"

export type CacheBoundaryComponent = "system" | "tools" | "messages"

export interface LocalCacheRegressionExpectation {
  readonly stablePrefix?: LocalCacheRegressionCompareExpectation
  readonly cacheKey?: LocalCacheRegressionCacheKeyExpectation
  readonly components?: Partial<Record<CacheFingerprintComponentName, LocalCacheRegressionCompareExpectation>>
  readonly stableBoundary?: Partial<Record<CacheBoundaryComponent, ReadonlyArray<number>>>
  readonly dynamicBoundary?: Partial<Record<CacheBoundaryComponent, ReadonlyArray<number>>>
}

export interface LocalCacheRegressionFixture {
  readonly name: string
  readonly build: (run: "first" | "second") => LLMRequest
  readonly expect?: LocalCacheRegressionExpectation
}

export interface LocalCacheRegressionPlanSnapshot {
  readonly provider: string
  readonly model: string
  readonly mode: CachePlan["mode"]
  readonly eligible: boolean
  readonly cacheKey: string | null
  readonly stablePrefixFingerprint: string
  readonly componentFingerprints: Record<string, string>
  readonly stable: Record<CacheBoundaryComponent, ReadonlyArray<number>>
  readonly dynamic: Record<CacheBoundaryComponent, ReadonlyArray<number>>
  readonly breakpoints: CachePlan["breakpoints"]
  readonly duration: CachePlan["duration"]
  readonly minimumPrefixTokens: number | null
}

export interface LocalCacheRegressionCheckReport {
  readonly name: string
  readonly status: LocalCacheRegressionStatus
  readonly reasonCodes: ReadonlyArray<string>
  readonly first?: LocalCacheRegressionPlanSnapshot
  readonly second?: LocalCacheRegressionPlanSnapshot
}

export interface LocalCacheRegressionReport {
  readonly version: typeof LOCAL_CACHE_REGRESSION_REPORT_VERSION
  readonly status: LocalCacheRegressionStatus
  readonly summary: Record<LocalCacheRegressionStatus, number>
  readonly checks: ReadonlyArray<LocalCacheRegressionCheckReport>
}

export const checkLocalCacheRegression = (
  fixtures: ReadonlyArray<LocalCacheRegressionFixture>,
): LocalCacheRegressionReport => {
  if (fixtures.length === 0) return reportFor([])
  return reportFor(fixtures.map(checkFixture))
}

const checkFixture = (fixture: LocalCacheRegressionFixture): LocalCacheRegressionCheckReport => {
  let first: LocalCacheRegressionPlanSnapshot
  let second: LocalCacheRegressionPlanSnapshot
  try {
    first = snapshot(planCacheRequest(fixture.build("first")))
    second = snapshot(planCacheRequest(fixture.build("second")))
  } catch (error) {
    return {
      name: fixture.name,
      status: "inconclusive",
      reasonCodes: ["fixture_build_or_plan_error", errorKind(error)],
    }
  }

  if (!first.eligible && !second.eligible) {
    return { name: fixture.name, status: "skip", reasonCodes: ["cache_plan_ineligible"], first, second }
  }

  const failures = compareSnapshots(first, second, fixture.expect ?? {})
  return {
    name: fixture.name,
    status: failures.length === 0 ? "pass" : "fail",
    reasonCodes: failures,
    first,
    second,
  }
}

const compareSnapshots = (
  first: LocalCacheRegressionPlanSnapshot,
  second: LocalCacheRegressionPlanSnapshot,
  expectation: LocalCacheRegressionExpectation,
) => {
  const failures: Array<string> = []
  if (first.eligible !== second.eligible) failures.push("eligibility_changed")
  compareValue(
    failures,
    "stable_prefix",
    first.stablePrefixFingerprint,
    second.stablePrefixFingerprint,
    expectation.stablePrefix ?? "same",
  )
  compareCacheKey(failures, first.cacheKey, second.cacheKey, expectation.cacheKey ?? "ignore")
  for (const [component, compare] of Object.entries(expectation.components ?? {})) {
    compareValue(
      failures,
      `component_${component}`,
      first.componentFingerprints[component],
      second.componentFingerprints[component],
      compare,
    )
  }
  compareBoundaries(failures, "stable", first.stable, expectation.stableBoundary)
  compareBoundaries(failures, "dynamic", first.dynamic, expectation.dynamicBoundary)
  return failures
}

const compareValue = (
  failures: Array<string>,
  name: string,
  first: string | undefined | null,
  second: string | undefined | null,
  expectation: LocalCacheRegressionCompareExpectation,
) => {
  if (first === undefined || second === undefined) {
    failures.push(`${name}_missing`)
    return
  }
  if (expectation === "same" && first !== second) failures.push(`${name}_changed`)
  if (expectation === "different" && first === second) failures.push(`${name}_unchanged`)
}

const compareCacheKey = (
  failures: Array<string>,
  first: string | null,
  second: string | null,
  expectation: LocalCacheRegressionCacheKeyExpectation,
) => {
  if (expectation === "ignore") return
  if (expectation === "present") {
    if (first === null || second === null) failures.push("cache_key_missing")
    return
  }
  if (expectation === "absent") {
    if (first !== null || second !== null) failures.push("cache_key_present")
    return
  }
  compareValue(failures, "cache_key", first, second, expectation)
}

const compareBoundaries = (
  failures: Array<string>,
  kind: "stable" | "dynamic",
  actual: Record<CacheBoundaryComponent, ReadonlyArray<number>>,
  expected: Partial<Record<CacheBoundaryComponent, ReadonlyArray<number>>> | undefined,
) => {
  for (const [component, indexes] of Object.entries(expected ?? {}) as ReadonlyArray<
    readonly [CacheBoundaryComponent, ReadonlyArray<number>]
  >) {
    if (!sameIndexes(actual[component], indexes)) failures.push(`${kind}_${component}_boundary_changed`)
  }
}

const sameIndexes = (left: ReadonlyArray<number>, right: ReadonlyArray<number>) =>
  left.length === right.length && left.every((value, index) => value === right[index])

const snapshot = (planned: CacheBoundaryPlan): LocalCacheRegressionPlanSnapshot => ({
  provider: planned.plan.provider,
  model: planned.plan.model,
  mode: planned.plan.mode,
  eligible: planned.plan.eligible,
  cacheKey: planned.plan.cacheKey,
  stablePrefixFingerprint: planned.plan.stablePrefixFingerprint,
  componentFingerprints: planned.plan.componentFingerprints,
  stable: planned.stable,
  dynamic: planned.dynamic,
  breakpoints: planned.plan.breakpoints,
  duration: planned.plan.duration,
  minimumPrefixTokens: planned.plan.minimumPrefixTokens,
})

const reportFor = (checks: ReadonlyArray<LocalCacheRegressionCheckReport>): LocalCacheRegressionReport => {
  const summary = {
    pass: checks.filter((check) => check.status === "pass").length,
    fail: checks.filter((check) => check.status === "fail").length,
    skip: checks.filter((check) => check.status === "skip").length,
    inconclusive: checks.filter((check) => check.status === "inconclusive").length,
  }
  return {
    version: LOCAL_CACHE_REGRESSION_REPORT_VERSION,
    status: summary.fail > 0 ? "fail" : summary.inconclusive > 0 ? "inconclusive" : summary.pass > 0 ? "pass" : "skip",
    summary,
    checks,
  }
}

const errorKind = (error: unknown) => {
  if (error instanceof Error) return error.name || "Error"
  return typeof error
}

export * as CacheRegressionChecker from "./regression-checker"
