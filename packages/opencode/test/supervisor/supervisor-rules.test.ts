import { describe, expect } from "bun:test"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { SupervisorState } from "@/supervisor"
import { Effect, Layer } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { pollWithTimeout, testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(
  SupervisorState.layer.pipe(
    Layer.provideMerge(Config.defaultLayer),
    Layer.provideMerge(Session.defaultLayer),
    Layer.provideMerge(SessionStatus.layer),
    Layer.provideMerge(SessionSummary.defaultLayer),
    Layer.provideMerge(Bus.layer),
  ),
)

function addMessage(sessionID: SessionID) {
  return Session.Service.use((session) =>
    session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: Date.now() },
    } as MessageV2.User),
  )
}

function updatePatch(input: { sessionID: SessionID; messageID: MessageID; files: string[] }) {
  return Session.Service.use((session) =>
    session.updatePart({
      id: PartID.ascending(),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "patch",
      hash: PartID.ascending(),
      files: input.files,
    }),
  )
}

function updateText(input: { sessionID: SessionID; messageID: MessageID; text: string }) {
  return Session.Service.use((session) =>
    session.updatePart({
      id: PartID.ascending(),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "text",
      text: input.text,
    }),
  )
}

function updateTool(input: { sessionID: SessionID; messageID: MessageID; command: string; exitCode?: number }) {
  return Session.Service.use((session) =>
    session.updatePart({
      id: PartID.ascending(),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "tool",
      callID: PartID.ascending(),
      tool: "bash",
      state: {
        status: "completed",
        input: { command: input.command },
        output: "raw output must not be stored in supervisor state",
        title: input.command,
        metadata: input.exitCode === undefined ? {} : { exitCode: input.exitCode },
        time: { start: Date.now(), end: Date.now() },
      },
    }),
  )
}

describe("supervisor deterministic rules", () => {
  it.instance("detects missing reproduction after edits", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* updateText({ sessionID: info.id, messageID: message.id, text: "Fix this bug, it crashes on submit" })
      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["src/app.ts"] })

      expect((yield* supervisor.get(info.id)).risks.map((risk) => risk.trigger)).toContain("missing_reproduction")
    }),
  )

  it.instance("detects repeated command failure", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({
        sessionID: info.id,
        patch: { mode: "observe", max_repeated_command_failures: 2 },
      })

      yield* updateTool({ sessionID: info.id, messageID: message.id, command: "bun test", exitCode: 1 })
      yield* updateTool({ sessionID: info.id, messageID: message.id, command: "bun test", exitCode: 1 })

      const state = yield* supervisor.get(info.id)
      expect(state.commandsRun[0]?.repeatedFailureCount).toBe(2)
      expect(state.risks.map((risk) => risk.trigger)).toContain("repeated_command_failure")
    }),
  )

  it.instance("detects missing validation after edits", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      const bus = yield* Bus.Service
      yield* supervisor.init()
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["src/app.ts"] })
      yield* bus.publish(SessionStatus.Event.Idle, { sessionID: info.id })

      const state = yield* pollWithTimeout(
        supervisor
          .get(info.id)
          .pipe(Effect.map((state) => (state.risks.some((risk) => risk.trigger === "missing_validation") ? state : undefined))),
        "missing validation risk was not observed after idle",
      )
      expect(state.risks.map((risk) => risk.trigger)).toContain("missing_validation")
    }),
  )

  it.instance("detects scope expansion above the configured file limit", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe", broad_diff_file_limit: 2 } })

      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["a.ts", "b.ts", "c.ts"] })

      expect((yield* supervisor.get(info.id)).risks.map((risk) => risk.trigger)).toContain("scope_expansion")
    }),
  )

  it.instance("detects risky edits in configured sensitive paths", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({
        sessionID: info.id,
        patch: { mode: "observe", sensitive_path_globs: ["**/auth/**"] },
      })

      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["src/auth/token.ts"] })

      expect((yield* supervisor.get(info.id)).risks.map((risk) => risk.trigger)).toContain("risky_edit")
    }),
  )

  it.instance("does not flag reproduction or validation when both were observed", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["src/app.ts"] })
      yield* updateTool({ sessionID: info.id, messageID: message.id, command: "node repro.js", exitCode: 0 })
      yield* updateTool({ sessionID: info.id, messageID: message.id, command: "bun test", exitCode: 0 })

      expect((yield* supervisor.get(info.id)).risks.map((risk) => risk.trigger)).not.toContain("missing_reproduction")
      expect((yield* supervisor.get(info.id)).risks.map((risk) => risk.trigger)).not.toContain("missing_validation")
    }),
  )

  it.instance("does not flag missing validation before the session becomes idle", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["src/app.ts"] })

      expect((yield* supervisor.get(info.id)).risks.map((risk) => risk.trigger)).not.toContain("missing_validation")
    }),
  )

  it.instance("does not flag risky edits after validation since the edit", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({
        sessionID: info.id,
        patch: { mode: "observe", sensitive_path_globs: ["**/auth/**"] },
      })

      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["src/auth/token.ts"] })
      yield* updateTool({ sessionID: info.id, messageID: message.id, command: "bun test", exitCode: 0 })

      expect((yield* supervisor.get(info.id)).risks.map((risk) => risk.trigger)).not.toContain("risky_edit")
    }),
  )

  it.instance("does not re-raise a validated risky edit after a later non-sensitive patch", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({
        sessionID: info.id,
        patch: { mode: "observe", sensitive_path_globs: ["**/auth/**"] },
      })

      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["src/auth/token.ts"] })
      yield* updateTool({ sessionID: info.id, messageID: message.id, command: "bun test", exitCode: 0 })
      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["src/app.ts"] })

      expect((yield* supervisor.get(info.id)).risks.map((risk) => risk.trigger)).not.toContain("risky_edit")
    }),
  )
})
