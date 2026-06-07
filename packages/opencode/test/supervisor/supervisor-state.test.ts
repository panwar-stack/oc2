import { describe, expect } from "bun:test"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Supervisor } from "@/supervisor/supervisor"
import { SupervisorState } from "@/supervisor"
import { Effect, Layer, Queue, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

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
type StateUpdated = Schema.Schema.Type<typeof Supervisor.Event.StateUpdated.properties>["state"]

function addMessage(sessionID: SessionID) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    return yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: Date.now() },
    } as MessageV2.User)
  })
}

function updateTool(input: {
  sessionID: SessionID
  messageID: MessageID
  command: string
  tool?: string
  exitCode?: number
  output?: string
}) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    return yield* session.updatePart({
      id: PartID.ascending(),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "tool",
      callID: "call",
      tool: input.tool ?? "bash",
      state: {
        status: "completed",
        input: { command: input.command },
        output: input.output ?? "",
        title: input.command,
        metadata: input.exitCode === undefined ? {} : { exitCode: input.exitCode },
        time: { start: Date.now(), end: Date.now() },
      },
    })
  })
}

function updatePatch(input: { sessionID: SessionID; messageID: MessageID; files: string[] }) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    return yield* session.updatePart({
      id: PartID.ascending(),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "patch",
      hash: PartID.ascending(),
      files: input.files,
    })
  })
}

describe("supervisor state service", () => {
  it.instance("returns runtime defaults with empty derived state", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const state = yield* supervisor.get(info.id)

      expect(state.mode).toBe("advise")
      expect(state.filesTouched).toEqual([])
      expect(state.commandsRun).toEqual([])
      expect(state.risks).toEqual([])
    }),
  )

  it.instance("skips observation events while effective mode is off", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      yield* supervisor.init()
      const info = yield* session.create({})
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "off" } })
      const message = yield* addMessage(info.id)

      yield* updateTool({ sessionID: info.id, messageID: message.id, command: "bun test", exitCode: 0 })

      expect((yield* supervisor.get(info.id)).commandsRun).toEqual([])
    }),
  )

  it.instance("derives shell commands and validations in observe mode", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      yield* supervisor.init()
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* updateTool({ sessionID: info.id, messageID: message.id, command: " bun   test ", exitCode: 0 })

      const state = yield* pollWithTimeout(
        supervisor.get(info.id).pipe(Effect.map((state) => (state.commandsRun.length ? state : undefined))),
        "supervisor command state was not derived",
      )
      expect(state.mode).toBe("observe")
      expect(state.commandsRun[0]?.command).toBe("bun test")
      expect(state.commandsRun[0]?.validation).toBe(true)
      expect(state.validationsRun).toEqual(["bun test"])
      expect(state.risks).toEqual([])
    }),
  )

  it.instance("strips leading workspace cd before validation matching", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* updateTool({
        sessionID: info.id,
        messageID: message.id,
        command: "cd packages/opencode && bun typecheck",
        exitCode: 0,
      })

      const state = yield* supervisor.get(info.id)
      expect(state.commandsRun[0]?.command).toBe("bun typecheck")
      expect(state.commandsRun[0]?.validation).toBe(true)
      expect(state.validationsRun).toEqual(["bun typecheck"])
      expect(state.risks).toEqual([])
    }),
  )

  it.instance("keeps leading cd when target is outside workspace", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* updateTool({ sessionID: info.id, messageID: message.id, command: "cd /tmp && bun typecheck", exitCode: 0 })

      const state = yield* supervisor.get(info.id)
      expect(state.commandsRun[0]?.command).toBe("cd /tmp && bun typecheck")
      expect(state.commandsRun[0]?.validation).toBe(false)
      expect(state.validationsRun).toEqual([])
      expect(state.risks).toEqual([])
    }),
  )

  it.instance("uses activity label instead of raw first user text summary", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({ title: "raw title should not leak" })
      const message = yield* addMessage(info.id)
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: info.id,
        messageID: message.id,
        type: "text",
        text: "please expose this exact prompt",
      })
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      const state = yield* supervisor.get(info.id)
      expect(state.summary).toBe("Coding session")
      expect(state.summary).not.toContain("please expose")
      expect(state.summary).not.toContain("raw title")
      expect(state.risks).toEqual([])
    }),
  )

  it.instance("emits state update for permission events in observe mode", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const events = yield* Queue.unbounded<StateUpdated>()
      const info = yield* session.create({})
      yield* Effect.acquireRelease(
        bus.subscribeCallback(Supervisor.Event.StateUpdated, (event) => {
          if (event.properties.sessionID === info.id) Queue.offerUnsafe(events, event.properties.state)
        }),
        (off) => Effect.sync(off),
      )
      yield* supervisor.init()
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })
      yield* Queue.take(events)

      yield* bus.publish(Permission.Event.Asked, {
        id: PermissionID.ascending(),
        sessionID: info.id,
        permission: "tool.execute",
        patterns: ["bash"],
        metadata: {},
        always: [],
      })

      const state = yield* awaitWithTimeout(Queue.take(events), "permission event did not emit supervisor state")
      expect(state.risks).toEqual([])
      expect(state.updatedAt).toBeGreaterThan(0)
    }),
  )

  it.instance("maps session status and error events to observable supervisor status", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      yield* supervisor.init()
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* bus.publish(SessionStatus.Event.Status, { sessionID: info.id, status: { type: "busy" } })
      const busy = yield* pollWithTimeout(
        supervisor.get(info.id).pipe(Effect.map((state) => (state.status === "uncertain" ? state : undefined))),
        "busy status was not observed",
      )
      expect(busy.risks).toEqual([])

      yield* bus.publish(Session.Event.Error, {
        sessionID: info.id,
        error: { name: "UnknownError", data: { message: "failed" } },
      })
      const blocked = yield* pollWithTimeout(
        supervisor.get(info.id).pipe(Effect.map((state) => (state.status === "blocked" ? state : undefined))),
        "error status was not observed",
      )
      expect(blocked.risks).toEqual([])

      yield* bus.publish(SessionStatus.Event.Status, { sessionID: info.id, status: { type: "idle" } })
      const idle = yield* pollWithTimeout(
        supervisor.get(info.id).pipe(Effect.map((state) => (state.status === "on_track" ? state : undefined))),
        "idle status was not observed",
      )
      expect(idle.risks).toEqual([])
    }),
  )

  it.instance("ignores unknown tool parts", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      yield* supervisor.init()
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* updateTool({ sessionID: info.id, messageID: message.id, command: "bun test", tool: "webfetch", exitCode: 0 })

      expect((yield* supervisor.get(info.id)).commandsRun).toEqual([])
    }),
  )

  it.instance("bounds files and commands", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* Effect.forEach(
        Array.from({ length: 30 }, (_, index) => index),
        (index) =>
          Effect.all([
            updatePatch({ sessionID: info.id, messageID: message.id, files: [`file-${index}.ts`] }),
            updateTool({ sessionID: info.id, messageID: message.id, command: `npm test ${index}`, exitCode: 0 }),
          ]),
        { discard: true },
      )

      const state = yield* supervisor.get(info.id)
      expect(state.filesTouched).toHaveLength(25)
      expect(state.commandsRun).toHaveLength(20)
      expect(state.validationsRun).toHaveLength(10)
    }),
  )

  it.instance("returns supervisor activity newest first", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["src/app.ts"] })
      yield* updateTool({ sessionID: info.id, messageID: message.id, command: "bun test", exitCode: 0 })

      const activity = yield* supervisor.getActivity(info.id)
      expect(activity.map((item) => item.type).slice(0, 3)).toEqual(["validation", "command", "file"])
      expect(activity[0]?.time).toBeGreaterThanOrEqual(activity[1]?.time ?? 0)
      expect(activity[1]?.time).toBeGreaterThanOrEqual(activity[2]?.time ?? 0)
    }),
  )

  it.instance("bounds supervisor activity to the latest 100 entries", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      yield* supervisor.init()
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })

      yield* Effect.forEach(
        Array.from({ length: 120 }, (_, index) => index),
        (index) => updatePatch({ sessionID: info.id, messageID: message.id, files: [`activity-${index}.ts`] }),
        { discard: true },
      )

      const activity = yield* pollWithTimeout(
        supervisor.getActivity(info.id).pipe(
          Effect.map((activity) =>
            activity.length === 100 && JSON.stringify(activity).includes("activity-119.ts") ? activity : undefined,
          ),
        ),
        "supervisor activity was not bounded",
      )
      expect(JSON.stringify(activity)).toContain("activity-119.ts")
      expect(JSON.stringify(activity)).not.toContain("activity-0.ts")
    }),
  )

  it.instance("dedupes supervisor activity across repeated rebuilds", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })
      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["src/app.ts"] })
      yield* updateTool({ sessionID: info.id, messageID: message.id, command: "bun test", exitCode: 0 })

      const first = yield* supervisor.getActivity(info.id)
      yield* supervisor.get(info.id)
      const second = yield* supervisor.getActivity(info.id)

      expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id))
    }),
  )

  it.instance("stores observable-only supervisor activity payloads", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const supervisor = yield* SupervisorState.Service
      const info = yield* session.create({})
      const message = yield* addMessage(info.id)
      yield* supervisor.updateSettings({ sessionID: info.id, patch: { mode: "observe" } })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: info.id,
        messageID: message.id,
        type: "text",
        text: "SECRET prompt text should not leak",
      })
      yield* updateTool({
        sessionID: info.id,
        messageID: message.id,
        command: "bun test",
        exitCode: 1,
        output: "SECRET raw command output should not leak",
      })
      yield* updatePatch({ sessionID: info.id, messageID: message.id, files: ["src/app.ts"] })

      const serialized = JSON.stringify(yield* supervisor.getActivity(info.id))
      expect(serialized).toContain("bun test")
      expect(serialized).toContain("src/app.ts")
      expect(serialized).not.toContain("SECRET")
      expect(serialized).not.toContain("recentEvents")
      expect(serialized).not.toContain("raw command output")
    }),
  )
})
