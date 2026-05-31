import { describe, expect } from "bun:test"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SupervisorState, buildRecommendationInput, buildReport, validateRecommendationOutput } from "@/supervisor"
import { Supervisor } from "@/supervisor/supervisor"
import { Effect, Layer, Queue } from "effect"
import * as Option from "effect/Option"
import * as Log from "@opencode-ai/core/util/log"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(
  SupervisorState.layer.pipe(
    Layer.provideMerge(Session.defaultLayer),
    Layer.provideMerge(SessionSummary.defaultLayer),
    Layer.provideMerge(Config.defaultLayer),
    Layer.provideMerge(Bus.layer),
  ),
)

const config = {
  supervisor: {
    mode: "advise",
    recommendation_timeout_ms: 1,
    min_review_interval_ms: 1000,
    max_recommendation_chars: 80,
  },
} satisfies Partial<Config.Info>

function state() {
  const base = Supervisor.state({ sessionID: SessionID.make("ses_test"), config })
  return {
    ...base,
    status: "drifting" as const,
    filesTouched: ["src/app.ts"],
    commandsRun: [
      {
        command: "bun test",
        exitCode: 1,
        validation: true,
        repeatedFailureCount: 1,
      },
    ],
    validationsRun: [],
    risks: [
      {
        trigger: "missing_validation" as const,
        severity: "warning" as const,
        evidence: ["file:src/app.ts"],
        message: "Edits were observed without a successful validation command.",
      },
    ],
  } satisfies Supervisor.State
}

function addMessage() {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    const info = yield* session.create({})
    const message = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: info.id,
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: Date.now() },
    } as MessageV2.User)
    return { info, message }
  })
}

describe("supervisor recommendation and report behavior", () => {
  it.effect("builds bounded recommendation input without raw command output", () =>
    Effect.sync(() => {
      const input = buildRecommendationInput(state())
      expect(input.filesTouched).toEqual(["src/app.ts"])
      expect(JSON.stringify(input)).not.toContain("raw output")
      expect(JSON.stringify(input)).not.toContain("SECRET")
    }),
  )

  it.effect("rejects model output with invented evidence", () =>
    Effect.sync(() => {
      expect(
        validateRecommendationOutput({
          state: state(),
          output: {
            recommend: true,
            action: "nudge",
            trigger: "missing_validation",
            message: "Run validation.",
            evidence: ["file:invented.ts"],
          },
        }),
      ).toBeUndefined()
    }),
  )

  it.effect("accepts valid structured model output", () =>
    Effect.sync(() => {
      expect(
        validateRecommendationOutput({
          state: state(),
          output: {
            recommend: true,
            action: "nudge",
            trigger: "missing_validation",
            message: "Run the relevant validation before wrapping up.",
            evidence: ["file:src/app.ts"],
          },
          model: { providerID: "test", modelID: "test-model" },
        }),
      ).toMatchObject({ source: "model", trigger: "missing_validation", evidence: ["file:src/app.ts"] })
    }),
  )

  it.effect("rejects out-of-scope model requests", () =>
    Effect.sync(() => {
      expect(
        validateRecommendationOutput({
          state: state(),
          output: {
            recommend: true,
            action: "warn",
            trigger: "missing_validation",
            message: "Block the session and roll back the edits.",
            evidence: ["file:src/app.ts"],
          },
        }),
      ).toBeUndefined()
    }),
  )

  it.effect("allows model-only triggers only with enough observable evidence", () =>
    Effect.sync(() => {
      const noRisk = { ...state(), risks: [] }
      expect(
        validateRecommendationOutput({
          state: noRisk,
          output: {
            recommend: true,
            action: "nudge",
            trigger: "trajectory_drift",
            message: "Refocus on the edited file and failed command.",
            evidence: ["file:src/app.ts", "command:bun test"],
          },
        }),
      ).toMatchObject({ trigger: "trajectory_drift" })
      expect(
        validateRecommendationOutput({
          state: noRisk,
          output: {
            recommend: true,
            action: "nudge",
            trigger: "trajectory_drift",
            message: "Refocus on the edited file.",
            evidence: ["file:src/app.ts"],
          },
        }),
      ).toBeUndefined()
    }),
  )

  it.instance("does not emit recommendations without a resolved model", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const supervisor = yield* SupervisorState.Service
      const events = yield* Queue.unbounded<unknown>()
      const { info, message } = yield* addMessage()
      yield* Effect.acquireRelease(
        bus.subscribeCallback(Supervisor.Event.RecommendationCreated, (event) => {
          if (event.properties.sessionID === info.id) Queue.offerUnsafe(events, event)
        }),
        (off) => Effect.sync(off),
      )
      yield* supervisor.init()
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "advise" } })
      yield* Session.Service.use((session) =>
        session.updatePart({
          id: PartID.ascending(),
          sessionID: info.id,
          messageID: message.id,
          type: "patch",
          hash: PartID.ascending(),
          files: ["src/app.ts"],
        }),
      )
      yield* bus.publish(SessionStatus.Event.Idle, { sessionID: info.id })

      expect(Option.isNone(yield* Queue.take(events).pipe(Effect.timeoutOption("150 millis")))).toBe(true)
    }),
  )

  it.effect("generates reports from observable state and emitted recommendations", () =>
    Effect.sync(() => {
      const recommendation = validateRecommendationOutput({
        state: state(),
        output: {
          recommend: true,
          action: "nudge",
          trigger: "missing_validation",
          message: "Run validation.",
          evidence: ["file:src/app.ts"],
        },
      })
      const report = buildReport(state(), recommendation ? [recommendation] : [])
      expect(report.risks.map((risk) => risk.trigger)).toEqual(["missing_validation"])
      expect(report.evidence).toContain("file:src/app.ts")
      expect(JSON.stringify(report)).not.toContain("raw output")
    }),
  )
})
