import type { LanguageModelV3Middleware, LanguageModelV3StreamPart } from "@ai-sdk/provider"

export type ProviderOutcome = "success" | "error" | "interrupt" | "eof"

export type ProviderInterval = {
  readonly step: number
  readonly started: number
  readonly completed: number
  readonly duration: number
  readonly outcome: ProviderOutcome
}

export type ProviderStepTiming = ProviderInterval

export type ProviderTiming = {
  readonly now: () => number
  currentStep?: number
  active?: { readonly step: number; readonly started: number }
  readonly intervals: Map<number, ProviderInterval[]>
  readonly consumed: Set<number>
}

export class MissingProviderTerminalError extends Error {
  override readonly name = "MissingProviderTerminalError"

  constructor() {
    super("Provider stream ended without a terminal event")
  }
}

export const makeProviderTiming = (now: () => number = Date.now): ProviderTiming => ({
  now,
  intervals: new Map(),
  consumed: new Set(),
})

export function beginProviderStep(timing: ProviderTiming | undefined, step: number) {
  if (!timing) return
  if (timing.active) throw new Error(`Provider step ${timing.active.step} still has an active attempt`)
  if (timing.consumed.has(step)) throw new Error(`Provider step ${step} timing was already consumed`)
  timing.currentStep = step
}

export function beginProviderAttempt(timing: ProviderTiming | undefined) {
  if (!timing) return
  if (timing.active) throw new Error(`Provider step ${timing.active.step} already has an active attempt`)
  if (timing.currentStep === undefined) throw new Error("Provider attempt is missing a step")
  if (timing.consumed.has(timing.currentStep)) {
    throw new Error(`Provider step ${timing.currentStep} timing was already consumed`)
  }
  timing.active = { step: timing.currentStep, started: timing.now() }
}

export function finishProviderAttempt(timing: ProviderTiming | undefined, outcome: ProviderOutcome) {
  if (!timing) return
  if (!timing.active) throw new Error("Provider attempt has no active dispatch")
  const completed = timing.now()
  const interval = {
    step: timing.active.step,
    started: timing.active.started,
    completed,
    duration: Math.max(0, Math.floor(completed - timing.active.started)),
    outcome,
  } satisfies ProviderInterval
  timing.intervals.set(interval.step, [...(timing.intervals.get(interval.step) ?? []), interval])
  timing.active = undefined
  return interval
}

export function takeProviderStep(timing: ProviderTiming | undefined, step: number): ProviderStepTiming | undefined {
  if (!timing) return
  if (timing.active?.step === step) throw new Error(`Provider step ${step} still has an active attempt`)
  if (timing.consumed.has(step)) throw new Error(`Provider step ${step} timing was already consumed`)
  const intervals = timing.intervals.get(step)
  if (!intervals?.length) return
  const result = {
    step,
    started: intervals[0].started,
    completed: intervals.at(-1)!.completed,
    duration: intervals.reduce((total, interval) => total + interval.duration, 0),
    outcome: intervals.at(-1)!.outcome,
  } satisfies ProviderStepTiming
  timing.intervals.delete(step)
  timing.consumed.add(step)
  if (timing.currentStep === step) timing.currentStep = undefined
  return result
}

export function takeCurrentProviderStep(timing: ProviderTiming | undefined) {
  if (!timing || timing.currentStep === undefined) return
  return takeProviderStep(timing, timing.currentStep)
}

export function middleware(timing: ProviderTiming | undefined): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    async wrapStream({ doStream, params }) {
      beginProviderAttempt(timing)
      let result: Awaited<ReturnType<typeof doStream>>
      try {
        result = await doStream()
      } catch (error) {
        finishProviderAttempt(timing, params.abortSignal?.aborted ? "interrupt" : "error")
        throw error
      }

      const reader = result.stream.getReader()
      let terminal = false
      return {
        ...result,
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          async pull(controller) {
            try {
              const chunk = await reader.read()
              if (chunk.done) {
                if (terminal) {
                  controller.close()
                  return
                }
                finishProviderAttempt(timing, "eof")
                controller.error(new MissingProviderTerminalError())
                return
              }
              if (terminal) {
                controller.error(new Error("Provider emitted content after a terminal event"))
                return
              }
              if (chunk.value.type === "finish" || chunk.value.type === "error") {
                finishProviderAttempt(timing, chunk.value.type === "finish" ? "success" : "error")
                terminal = true
              }
              controller.enqueue(chunk.value)
            } catch (error) {
              if (!terminal && timing?.active) {
                finishProviderAttempt(timing, params.abortSignal?.aborted ? "interrupt" : "error")
              }
              controller.error(error)
            }
          },
          async cancel(reason) {
            if (!terminal && timing?.active) finishProviderAttempt(timing, "interrupt")
            await reader.cancel(reason)
          },
        }),
      }
    },
  }
}

export * as ProviderTimingLifecycle from "./provider-timing"
