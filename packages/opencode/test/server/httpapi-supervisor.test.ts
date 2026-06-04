import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Database } from "@opencode-ai/core/database/database"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { SessionPaths } from "@/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Supervisor } from "@/supervisor/supervisor"
import { Workspace } from "@/control-plane/workspace"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    Workspace.defaultLayer.pipe(Layer.provide(InstanceStore.defaultLayer), Layer.provide(InstanceBootstrap.defaultLayer)),
    Database.defaultLayer,
    httpApiLayer,
  ),
)

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

function addShellCommand(sessionID: SessionID, command: string) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    const message = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: Date.now() },
    } as MessageV2.User)
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: message.id,
      type: "tool",
      callID: "call",
      tool: "bash",
      state: {
        status: "completed",
        input: { command },
        output: "",
        title: command,
        metadata: { exitCode: 0 },
        time: { start: Date.now(), end: Date.now() },
      },
    })
  })
}

function addPatch(sessionID: SessionID, files: string[]) {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    const message = yield* session.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: Date.now() },
    } as MessageV2.User)
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: message.id,
      type: "patch",
      hash: PartID.ascending(),
      files,
    })
  })
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("supervisor HttpApi", () => {
  it.instance(
    "GET returns derived supervisor state",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Session.use.create({ title: "derive" })
        const headers = { "x-opencode-directory": test.directory }
        yield* addShellCommand(session.id, "bun   typecheck")

        const state = yield* requestJson<Supervisor.State>(pathFor(SessionPaths.supervisor, { sessionID: session.id }), {
          headers,
        })

        expect(state.mode).toBe("observe")
        expect(state.commandsRun[0]).toMatchObject({ command: "bun typecheck", validation: true, exitCode: 0 })
        expect(state.validationsRun).toEqual(["bun typecheck"])
        expect(state.risks).toEqual([])
      }),
    { config: { formatter: false, lsp: false, supervisor: { mode: "observe" } } },
  )

  it.instance("PATCH uses supervisor service settings flow", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* Session.use.create({ title: "patch" })
      const state = yield* requestJson<Supervisor.State>(pathFor(SessionPaths.supervisor, { sessionID: session.id }), {
        headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
        method: "PATCH",
        body: JSON.stringify({ mode: "advise", validation_command_patterns: ["custom check"] }),
      })

      expect(state.mode).toBe("advise")
      expect(state.config.modeSource).toBe("session")
      expect(state.config.session?.validation_command_patterns).toEqual(["custom check"])
      expect((yield* Session.use.get(session.id)).supervisor?.mode).toBe("advise")
    }),
  )

  it.instance(
    "GET report returns observable supervisor report",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Session.use.create({ title: "report" })
        yield* addPatch(session.id, ["src/app.ts"])

        const report = yield* requestJson<Supervisor.Report>(
          pathFor(SessionPaths.supervisorReport, { sessionID: session.id }),
          { headers: { "x-opencode-directory": test.directory } },
        )

        expect(report.sessionID).toBe(session.id)
        expect(report.filesTouched).toEqual(["src/app.ts"])
        expect(report.risks.map((risk) => risk.trigger)).toContain("missing_validation")
        expect(JSON.stringify(report)).not.toContain("raw output")
      }),
    { config: { formatter: false, lsp: false, supervisor: { mode: "observe" } } },
  )
})
