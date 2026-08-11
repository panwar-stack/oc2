import { NodeFileSystem } from "@effect/platform-node"
import { ConfigV1 } from "@oc2-ai/core/v1/config/config"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Database } from "@oc2-ai/core/database/database"
import { eq } from "drizzle-orm"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@oc2-ai/core/session/event"
import { SessionMessage } from "@oc2-ai/core/session/message"
import { Prompt } from "@oc2-ai/core/session/prompt"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Latch, Layer, Option, Queue, Scope } from "effect"
import * as DateTime from "effect/DateTime"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { NamedError } from "@oc2-ai/core/util/error"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "../../src/command"
import { Config } from "@/config/config"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "@/provider/provider"
import { Env } from "../../src/env"
import { Git } from "../../src/git"
import { Image } from "../../src/image/image"

import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "@/session/session"
import { SessionMessageTable, SessionTable } from "@oc2-ai/core/session/sql"
import { TeamMessageRecipientTable, TeamTable, TeamUsageEventTable } from "@/team/team.sql"
import { MessageReceived } from "@/team/events"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionV2 } from "@oc2-ai/core/session"
import { SessionExecution } from "@oc2-ai/core/session/execution"
import { Skill } from "../../src/skill"
import { Team } from "@/team/team"
import { SystemPrompt } from "../../src/session/system"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Memory } from "@/memory/memory"
import { RepositoryMemoryCommitTable } from "@/memory/memory.sql"
import { tokenText } from "@/memory/search"
import * as Log from "@oc2-ai/core/util/log"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Search } from "@oc2-ai/core/filesystem/search"
import { Opengrep } from "@oc2-ai/core/filesystem/opengrep"
import { Format } from "../../src/format"
import { Reference } from "../../src/reference/reference"
import { RepositoryCache } from "../../src/reference/repository-cache"
import { provideTmpdirInstance, provideTmpdirServer, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { ModelV2 } from "@oc2-ai/core/model"
import { SessionControl } from "@oc2-ai/core/session/control"
import { Runner } from "@/effect/runner"
import { InstanceStore } from "@/project/instance-store"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: SessionV1.Part[]) {
  return parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
}

type CompletedToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
type ErrorToolPart = SessionV1.ToolPart & { state: SessionV1.ToolStateError }

function completedTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: SessionV1.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

const processorCreateStarted: Array<() => void> = []
const blockingProcessor = Layer.succeed(
  SessionProcessor.Service,
  SessionProcessor.Service.of({
    create: () => Effect.sync(() => processorCreateStarted.shift()?.()).pipe(Effect.andThen(Effect.never)),
  }),
)

function makePrompt(input?: { processor?: "blocking" }) {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    lsp,
    mcp,
    FSUtil.defaultLayer,
    BackgroundJob.defaultLayer,
    Team.defaultLayer,
    Memory.defaultLayer,
    status,
    Database.defaultLayer,
    EventV2Bridge.defaultLayer,
    SessionControl.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(RepositoryCache.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(Search.defaultLayer),
    Layer.provide(Memory.defaultLayer),
    Layer.provide(Layer.mock(Opengrep.Service, { available: () => Effect.succeed(false) })),
    Layer.provide(Format.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc =
    input?.processor === "blocking"
      ? blockingProcessor
      : SessionProcessor.layer.pipe(
          Layer.provide(summary),
          Layer.provide(Image.defaultLayer),
          Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
          Layer.provideMerge(deps),
        )
  const compact = SessionCompaction.layer.pipe(
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(proc),
    Layer.provideMerge(deps),
  )
  return SessionPrompt.layer.pipe(
    Layer.provide(SessionRevert.defaultLayer),
    Layer.provide(Image.defaultLayer),
    Layer.provide(Reference.defaultLayer),
    Layer.provide(summary),
    Layer.provideMerge(run),
    Layer.provideMerge(compact),
    Layer.provideMerge(proc),
    Layer.provideMerge(registry),
    Layer.provideMerge(trunc),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(SystemPrompt.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalEventSystem: true })),
    Layer.provideMerge(deps),
    Layer.provide(summary),
  )
}

function makeHttp(input?: { processor?: "blocking" }) {
  return Layer.mergeAll(TestLLMServer.layer, makePrompt(input))
}

function makeHttpNoLLMServer(input?: { processor?: "blocking" }) {
  return makePrompt(input)
}

const it = testEffect(makeHttp())
const noLLMServer = testEffect(makeHttpNoLLMServer())
const raceNoLLMServer = testEffect(makeHttpNoLLMServer({ processor: "blocking" }))
const unix = process.platform !== "win32" ? it.instance : it.instance.skip
const unixNoLLMServer = process.platform !== "win32" ? noLLMServer.instance : noLLMServer.instance.skip

// Config that registers a custom "test" provider with a "test-model" model
// so provider model lookup succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(file, text)
})

const ensureDir = Effect.fn("test.ensureDir")(function* (dir: string) {
  const fs = yield* FSUtil.Service
  yield* fs.ensureDir(dir)
})

const writeConfig = Effect.fn("test.writeConfig")(function* (dir: string, config: Partial<ConfigV1.Info>) {
  yield* writeText(
    path.join(dir, "oc2.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }),
  )
})

const useServerConfig = Effect.fn("test.useServerConfig")(function* (config: (url: string) => Partial<ConfigV1.Info>) {
  const { directory: dir } = yield* TestInstance
  const llm = yield* TestLLMServer
  yield* writeConfig(dir, config(llm.url))
  return { dir, llm }
})

// Wait for a session's runner to enter a busy state. SessionStatus is flipped
// inside Runner.startShell's serialized transition, so cancel can't no-op once
// we observe it.
const waitForBusy = (sessionID: SessionID, duration: Duration.Input = "2 seconds") =>
  pollWithTimeout(
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service
      const s = yield* status.get(sessionID)
      return s.type === "busy" ? (true as const) : undefined
    }),
    `session ${sessionID} never became busy`,
    duration,
  )

const hasBash = Effect.sync(() => Bun.which("bash") !== null)

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const succeedVoid = (deferred: Deferred.Deferred<void>) => {
  Effect.runSync(Deferred.succeed(deferred, void 0).pipe(Effect.ignore))
}

// Asserts the session loop did not exit within the window: the finalization barrier parks the
// lead while a finite member is nonterminal. Timing-safe because a loop that is still processing
// (not yet parked) also satisfies "not exited".
const assertLoopParked = (fiber: Fiber.Fiber<SessionV1.WithParts, Runner.Suspended>, label: string) =>
  Effect.gen(function* () {
    const result = yield* Fiber.await(fiber).pipe(Effect.timeout("500 millis"), Effect.exit)
    // A timeout (Failure) means the loop stayed parked. A Success carrying a fiber Exit means the
    // loop exited when it should have remained parked.
    if (Exit.isSuccess(result) && result.value !== undefined) {
      return yield* Effect.fail(new Error(`${label}: expected the loop to stay parked`))
    }
  })

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const instrumentFinalizationParks = Effect.fnUntraced(function* (input?: { fallbackCallbacks?: boolean }) {
  const run = yield* SessionRunState.Service
  const events = yield* EventV2Bridge.Service
  const registrations = yield* Queue.unbounded<{ sessionID: SessionID; signal: Deferred.Deferred<void> }>()
  const mutableRun = run as Mutable<SessionRunState.Interface>
  const mutableEvents = events as Mutable<EventV2Bridge.Interface>
  const originalRegisterPark = run.registerPark
  const originalHandoffPark = run.handoffPark
  const originalSubscribeCallback = events.subscribeCallback
  const subscribeFallback = originalSubscribeCallback as (
    type: string | object,
    callback: (event: { type: string; properties: unknown; data: Record<string, unknown> }) => void,
  ) => Effect.Effect<() => void>
  const originalPublish = events.publish
  let beforeNextHandoff: Effect.Effect<void> | undefined
  let afterNextHandoff: Effect.Effect<void> | undefined
  let activeFallbacks = 0

  mutableRun.registerPark = ((sessionID, signal, continuation) =>
    originalRegisterPark(sessionID, signal, continuation).pipe(
      Effect.tap(() => Queue.offer(registrations, { sessionID, signal })),
    )) as SessionRunState.Interface["registerPark"]
  mutableRun.handoffPark = ((sessionID, signal, replacement) =>
    Effect.suspend(() => {
      const before = beforeNextHandoff
      beforeNextHandoff = undefined
      return Effect.gen(function* () {
        if (before) yield* before
        const result = yield* originalHandoffPark(sessionID, signal, replacement)
        if (result) {
          const after = afterNextHandoff
          afterNextHandoff = undefined
          if (after) yield* after
        }
        return result
      })
    })) as SessionRunState.Interface["handoffPark"]
  mutableEvents.subscribeCallback = ((
    type: string | object,
    callback: (event: { type: string; properties: unknown; data: Record<string, unknown> }) => void,
  ) => {
    if (input?.fallbackCallbacks) {
      return subscribeFallback(type, callback).pipe(
        Effect.map((off) => {
          activeFallbacks += 1
          let active = true
          return () => {
            if (!active) return
            active = false
            activeFallbacks -= 1
            off()
          }
        }),
      )
    }
    // Simulate an unavailable fallback bridge: registrations succeed, but no event callback is
    // retained. The real barrier must therefore make progress only through direct park signals.
    return Effect.sync(() => {
      activeFallbacks += 1
      let active = true
      return () => {
        if (!active) return
        active = false
        activeFallbacks -= 1
      }
    })
  }) as EventV2Bridge.Interface["subscribeCallback"]

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      mutableRun.registerPark = originalRegisterPark
      mutableRun.handoffPark = originalHandoffPark
      mutableEvents.subscribeCallback = originalSubscribeCallback
      mutableEvents.publish = originalPublish
    }),
  )

  return {
    run,
    next: (label: string) => awaitWithTimeout(Queue.take(registrations), `timed out waiting for ${label}`, "5 seconds"),
    beforeNextHandoff: (effect: Effect.Effect<void>) =>
      Effect.sync(() => {
        beforeNextHandoff = effect
      }),
    afterNextHandoff: (effect: Effect.Effect<void>) =>
      Effect.sync(() => {
        afterNextHandoff = effect
      }),
    activeFallbacks: () => activeFallbacks,
    failPublish: Effect.sync(() => {
      mutableEvents.publish = ((definition, data, options) =>
        definition.type === "team.message.received"
          ? Effect.die(new Error("simulated unavailable event publication"))
          : originalPublish(definition, data, options)) as EventV2Bridge.Interface["publish"]
    }),
    gatePublish: Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      mutableEvents.publish = ((definition, data, options) =>
        definition.type === "team.message.received"
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(originalPublish(definition, data, options)),
            )
          : originalPublish(definition, data, options)) as EventV2Bridge.Interface["publish"]
      return { entered, release }
    }),
    restorePublish: Effect.sync(() => {
      mutableEvents.publish = originalPublish
    }),
  }
})

// Sets up an active team whose lead has one worker member in the requested status/lifecycle and
// returns the services and handles the tests drive.
const parkLeadOnWorker = Effect.fnUntraced(function* (input: {
  llm: TestLLMServer["Service"]
  memberStatus?: Team.MemberStatus
  lifecycle?: Team.MemberLifecycle
  daemonState?: Team.MemberDaemonState
  /** When false, the lead gets no user message; the caller creates its own (e.g. structured). */
  leadPrompt?: boolean
}) {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const team = yield* Team.Service
  const lead = yield* sessions.create({ title: "Lead" })
  const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
  const info = yield* team.create({
    name: `park-team-${crypto.randomUUID().slice(0, 6)}`,
    goal: "Coordinate work",
    leadSessionID: lead.id,
  })
  const member = yield* team.addMember({
    teamID: info.id,
    sessionID: worker.id,
    name: "worker",
    agentType: "build",
    rolePrompt: "Worker task",
    lifecycle: input.lifecycle ?? "task",
    ...(input.daemonState !== undefined ? { daemonState: input.daemonState } : {}),
  })
  if (input.memberStatus !== undefined && input.memberStatus !== "starting") {
    const update = input.daemonState !== undefined ? { daemonState: input.daemonState } : undefined
    yield* team.updateMemberStatus(member.id, input.memberStatus, update)
  }
  if (input.leadPrompt !== false) {
    yield* prompt.prompt({
      sessionID: lead.id,
      agent: "build",
      model: ref,
      noReply: true,
      parts: [{ type: "text", text: "coordinate the team" }],
    })
  }
  return { prompt, sessions, team, lead, worker, info, member }
})

const setLegacyTeamProtocol = Effect.fnUntraced(function* (teamID: string) {
  const { db } = yield* Database.Service
  yield* db.update(TeamTable).set({ protocol_version: 0 }).where(eq(TeamTable.id, teamID)).run().pipe(Effect.orDie)
})

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const config = yield* Config.Service
  const prompt = yield* SessionPrompt.Service
  const run = yield* SessionRunState.Service
  const sessions = yield* Session.Service
  yield* config.get()
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, run, sessions, chat }
})

// Loop semantics

noLLMServer.instance(
  "paused prompt preserves queued input without entering the loop",
  () =>
    Effect.gen(function* () {
      const { prompt, sessions, chat } = yield* boot()
      const control = yield* SessionControl.Service
      yield* control.pause({ rootSessionID: chat.id })

      const exit = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [{ type: "text", text: "queued while paused" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Suspended)
      const messages = yield* sessions.messages({ sessionID: chat.id })
      expect(
        messages.some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "queued while paused"),
        ),
      ).toBe(true)
      expect(yield* control.release(chat.id)).toMatchObject({ resumableSessionIDs: [chat.id] })
    }),
  { config: cfg },
)

noLLMServer.instance(
  "durable prompt input directly signals only the exact parked session",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const lead = yield* sessions.create({ title: "Lead" })
      const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
      const leadSignal = yield* Deferred.make<void>()
      const leadPark = yield* run.registerPark(lead.id, leadSignal, Effect.die("unexpected park continuation"))
      yield* Effect.addFinalizer(() => leadPark.unregister)

      yield* prompt.prompt({
        sessionID: lead.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "lead input" }],
      })

      expect(yield* Deferred.isDone(leadSignal)).toBe(true)
      expect(
        (yield* sessions.messages({ sessionID: lead.id })).some((message) =>
          message.parts.some((part) => part.type === "text" && part.text === "lead input"),
        ),
      ).toBe(true)

      const replacement = yield* Deferred.make<void>()
      const replacementPark = yield* run.registerPark(lead.id, replacement, Effect.die("unexpected park continuation"))
      yield* Effect.addFinalizer(() => replacementPark.unregister)
      yield* prompt.prompt({
        sessionID: worker.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "worker input" }],
      })

      expect(yield* Deferred.isDone(replacement)).toBe(false)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "loop exits immediately when last assistant has stop finish",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
    }),
  { config: cfg },
)

it.instance("loop exits without an LLM request for interrupted orphan tool calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    const seeded = yield* seed(chat.id, { finish: "stop" })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: seeded.assistant.id,
      sessionID: chat.id,
      type: "tool",
      callID: "interrupted-call",
      tool: "edit",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
        time: { start: 1, end: 2 },
      },
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.id).toBe(seeded.assistant.id)
    expect(yield* llm.hits).toHaveLength(0)
  }),
)

it.instance("loop calls LLM and returns assistant message", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    const parts = result.parts.filter((p) => p.type === "text")
    expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
  }),
)

it.instance("loop stops provider overflow instead of auto-compacting when disabled", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      compaction: { auto: false },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })

    yield* llm.error(413, { error: { message: "request entity too large" } })
    yield* prompt.prompt({
      sessionID: chat.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    const result = yield* prompt.loop({ sessionID: chat.id })
    const messages = yield* sessions.messages({ sessionID: chat.id })

    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.info.error?.name).toBe("ContextOverflowError")
      expect(result.info.finish).toBe("error")
    }
    expect(messages.some((message) => message.parts.some((part) => part.type === "compaction"))).toBe(false)
  }),
)

noLLMServer.instance.skip(
  "prompt emits v2 prompted and synthetic events (v2 projector disabled)",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "hello v2" },
          {
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "data:text/plain;base64,bm90ZSBjb250ZW50",
          },
        ],
      })

      const messages = yield* SessionV2.Service.use((session) => session.messages({ sessionID: chat.id })).pipe(
        Effect.provide(SessionExecution.noopLayer),
        Effect.provide(SessionV2.defaultLayer),
      )
      const { db } = yield* Database.Service
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, chat.id))
        .get()
        .pipe(Effect.orDie)
      expect(messages.find((message) => message.type === "user")).toMatchObject({ type: "user", text: "hello v2" })
      expect(typeof row?.data.time.created).toBe("number")
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining("Called the Read tool") }),
          expect.objectContaining({ type: "synthetic", text: "note content" }),
        ]),
      )
    }),
  { config: cfg },
)

it.instance("static loop returns assistant text through local provider", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })

    yield* llm.text("world")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
    expect(yield* llm.hits).toHaveLength(1)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("static loop consumes queued replies across turns", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Prompt provider turns",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello one" }],
    })

    yield* llm.text("world one")

    const first = yield* prompt.loop({ sessionID: session.id })
    expect(first.info.role).toBe("assistant")
    expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello two" }],
    })

    yield* llm.text("world two")

    const second = yield* prompt.loop({ sessionID: session.id })
    expect(second.info.role).toBe("assistant")
    expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

    expect(yield* llm.hits).toHaveLength(2)
    expect(yield* llm.pending).toBe(0)
  }),
)

it.instance("loop continues when finish is tool-calls", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.tool("first", { value: "first" })
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("glob tool keeps instance context during prompt runs", () =>
  Effect.gen(function* () {
    const { dir, llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Glob context",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const file = path.join(dir, "probe.txt")
    yield* writeText(file, "probe")

    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "find text files" }],
    })
    yield* llm.tool("glob", { pattern: "**/*.txt" })
    yield* llm.text("done")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(result.info.role).toBe("assistant")

    const msgs = yield* MessageV2.filterCompactedEffect(session.id)
    const tool = msgs
      .flatMap((msg) => msg.parts)
      .find(
        (part): part is CompletedToolPart =>
          part.type === "tool" && part.tool === "glob" && part.state.status === "completed",
      )
    if (!tool) return

    expect(tool.state.output).toContain(file)
    expect(tool.state.output).not.toContain("No context found for instance")
    expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
  }),
)

it.instance("loop continues when finish is stop but assistant has tool parts", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      title: "Pinned",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      noReply: true,
      parts: [{ type: "text", text: "hello" }],
    })
    yield* llm.push(reply().tool("first", { value: "first" }).stop())
    yield* llm.text("second")

    const result = yield* prompt.loop({ sessionID: session.id })
    expect(yield* llm.calls).toBe(2)
    expect(result.info.role).toBe("assistant")
    if (result.info.role === "assistant") {
      expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
      expect(result.info.finish).toBe("stop")
    }
  }),
)

it.instance("failed subtask preserves metadata on error tool state", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig((url) => ({
      ...providerCfg(url),
      agent: {
        general: {
          model: "test/missing-model",
        },
      },
    }))
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({ title: "Pinned" })
    yield* llm.tool("task", {
      description: "inspect bug",
      prompt: "look into the cache key path",
      subagent_type: "general",
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    const result = yield* prompt.loop({ sessionID: chat.id })
    expect(result.info.role).toBe("assistant")
    expect(yield* llm.calls).toBe(2)

    const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
    const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
    expect(taskMsg?.info.role).toBe("assistant")
    if (!taskMsg || taskMsg.info.role !== "assistant") return

    const tool = errorTool(taskMsg.parts)
    if (!tool) return

    expect(tool.state.error).toContain("Tool execution failed")
    expect(tool.state.metadata).toBeDefined()
    expect(tool.state.metadata?.sessionId).toBeDefined()
    expect(tool.state.metadata?.model).toEqual({
      providerID: ProviderV2.ID.make("test"),
      modelID: ModelV2.ID.make("missing-model"),
    })
  }),
)

it.instance("subtask child inherits parent session external_directory allow", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const chat = yield* sessions.create({
      title: "Parent",
      permission: [{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }],
    })
    yield* llm.text("done")
    const msg = yield* user(chat.id, "hello")
    yield* addSubtask(chat.id, msg.id)

    yield* prompt.loop({ sessionID: chat.id })

    const kids = yield* sessions.children(chat.id)
    expect(kids).toHaveLength(1)
    const child = kids[0]!
    const rules = child.permission ?? []
    expect(rules).toEqual(
      expect.arrayContaining([{ permission: "external_directory", pattern: "/tmp/allowed/*", action: "allow" }]),
    )
    expect(Permission.evaluate("external_directory", "/tmp/allowed/file", rules).action).toBe("allow")
    expect(Permission.evaluate("task", "anything", rules).action).toBe("deny")
  }),
)

it.instance(
  "running subtask preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          const tool = taskMsg?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running subtask metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBeDefined()
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  5_000,
)

it.instance(
  "running task tool preserves metadata after tool-call transition",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)

      const tool = yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant" && item.info.agent === "build")
          const tool = assistant?.parts.find(
            (part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "task",
          )
          if (tool?.state.status === "running" && tool.state.metadata?.sessionId) return tool
        }),
        "timed out waiting for running task metadata",
      )

      if (tool.state.status !== "running") return
      expect(typeof tool.state.metadata?.sessionId).toBe("string")
      expect(tool.state.title).toBe("inspect bug")
      expect(tool.state.metadata?.model).toBeDefined()

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  30_000,
)

it.instance(
  "loop sets status to busy then idle",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service

      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      expect((yield* status.get(chat.id)).type).toBe("busy")
      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  3_000,
)

// Cancel semantics

it.instance(
  "suspend interrupts the loop without cancellation finalizers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const control = yield* SessionControl.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "pause this run")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* control.pause({ rootSessionID: chat.id })

      const exit = yield* Fiber.await(fiber).pipe(Effect.timeout("100 millis"))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Runner.Suspended)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          return (yield* llm.pending) === 0 ? true : undefined
        }),
        "provider stream did not unwind after suspension",
      )
      const assistant = (yield* sessions.messages({ sessionID: chat.id }))
        .map((message) => message.info)
        .findLast((message): message is SessionV1.Assistant => message.role === "assistant")
      expect(assistant?.error).toBeUndefined()
      expect(assistant?.time.completed).toBeUndefined()
    }),
  3_000,
)

it.instance(
  "wake schedules the loop and returns before the turn completes",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "wake me")

      // wake must not block on the turn, and it must report no result. Callers that treat its
      // answer as the final assistant message settle work against a stale or missing turn.
      const woken = yield* prompt.wake(chat.id).pipe(Effect.timeout("1 second"), Effect.orDie)
      expect(woken).toBeUndefined()
      yield* llm.wait(1)
      expect(yield* llm.calls).toBe(1)

      // The provider stream still hangs, so the scheduled turn is demonstrably unfinished.
      const assistantBeforeFinish = (yield* sessions.messages({ sessionID: chat.id }))
        .map((message) => message.info)
        .findLast((message): message is SessionV1.Assistant => message.role === "assistant")
      expect(assistantBeforeFinish?.finish).toBeUndefined()
      expect(assistantBeforeFinish?.time.completed).toBeUndefined()

      yield* prompt.cancel(chat.id)
    }),
  5_000,
)

it.instance(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id)

      yield* llm.hang

      yield* user(chat.id, "more")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
      }
    }),
  3_000,
)

it.instance(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const info = exit.value.info
        if (info.role === "assistant") {
          expect(info.error?.name).toBe("MessageAbortedError")
        }
      }
    }),
  3_000,
)

raceNoLLMServer.instance(
  "finalizes assistant when cancelled before processor creation completes",
  () =>
    Effect.gen(function* () {
      processorCreateStarted.length = 0
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          processorCreateStarted.length = 0
        }),
      )

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Processor creation race" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "first" }],
      })

      const firstCreate = defer<void>()
      processorCreateStarted.push(firstCreate.resolve)
      const first = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => firstCreate.promise)

      yield* prompt.cancel(chat.id)
      const firstExit = yield* Fiber.await(first)
      expect(Exit.isSuccess(firstExit)).toBe(true)

      let messages = yield* sessions.messages({ sessionID: chat.id })
      const firstInterrupted = messages.at(-1)
      expect(firstInterrupted?.info.role).toBe("assistant")
      expect(firstInterrupted?.parts).toHaveLength(0)
      if (firstInterrupted?.info.role === "assistant") {
        expect(firstInterrupted.info.finish).toBeUndefined()
        expect(firstInterrupted.info.time.completed).toBeNumber()
        expect(firstInterrupted.info.error?.name).toBe("MessageAbortedError")
      }

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "second" }],
      })

      const secondCreate = defer<void>()
      processorCreateStarted.push(secondCreate.resolve)
      const second = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.promise(() => secondCreate.promise)

      yield* prompt.cancel(chat.id)
      const secondExit = yield* Fiber.await(second)
      expect(Exit.isSuccess(secondExit)).toBe(true)

      messages = yield* sessions.messages({ sessionID: chat.id })
      const poisonMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          !message.info.finish &&
          !message.info.time.completed &&
          !message.info.error,
      )
      expect(poisonMessages).toHaveLength(0)

      const interruptedMessages = messages.filter(
        (message) =>
          message.info.role === "assistant" &&
          message.parts.length === 0 &&
          message.info.time.completed &&
          message.info.error?.name === "MessageAbortedError",
      )
      expect(interruptedMessages).toHaveLength(2)

      const lastUser = messages.at(-2)
      const lastAssistant = messages.at(-1)
      expect(lastUser?.info.role).toBe("user")
      expect(lastAssistant?.info.role).toBe("assistant")
      if (lastUser?.info.role === "user" && lastAssistant?.info.role === "assistant") {
        expect(lastAssistant.info.parentID).toBe(lastUser?.info.id)
      }
    }),
  { config: cfg },
  10_000,
)

it.live("injects team orchestration guidance for primary lead sessions when agent teams are enabled", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const { prompt, chat } = yield* boot()
      yield* llm.text("done")

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "refactor auth and routes" }],
      })

      const systemMessages = (yield* llm.inputs).flatMap((input) =>
        ((input.messages as Array<{ role?: string; content?: unknown }> | undefined) ?? [])
          .filter((message) => message.role === "system")
          .map((message) => JSON.stringify(message.content)),
      )
      const leadGuidance = systemMessages.find(
        (body) =>
          body.includes("Agent team orchestration is enabled") &&
          body.includes("team_create") &&
          body.includes("team_spawn") &&
          body.includes("Current teammate model: test/test-model") &&
          body.includes("The current teammate model exposes no teammate variants") &&
          body.includes("Omit team_spawn.variant for default behavior") &&
          body.includes("Lead role") &&
          body.includes("run a final team report"),
      )
      expect(leadGuidance).toBeDefined()
      expect(leadGuidance).toContain("Continue useful decomposition, integration, review, or decision work.")
      expect(leadGuidance).toContain("When no useful work remains, finish the current response normally.")
      expect(leadGuidance).toContain("The runtime parks successful finalization while finite teammates remain active.")
      expect(leadGuidance).toContain(
        "Do not sleep, repeatedly read team state, ask for routine updates, or send filler.",
      )
      expect(leadGuidance).toContain(
        "Teammates must send material progress, blockers, questions, and results without a lead status request.",
      )
      expect(leadGuidance).toContain("Relevant teammate or user events wake the lead.")
      expect(leadGuidance).not.toContain("Do not finalize while finite teammates remain nonterminal.")
      expect(leadGuidance).not.toContain("Ask for periodic updates.")
      expect(leadGuidance).not.toContain("An empty mailbox does not require ending this turn.")
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        experimental: { agent_teams: true },
      }),
    },
  ),
)

it.live("injects available teammate variants into team lead guidance", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const { prompt, chat } = yield* boot()
      yield* llm.text("done")

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "review a focused diff" }],
      })

      const bodies = (yield* llm.inputs).map((input) => JSON.stringify(input))
      expect(
        bodies.some(
          (body) =>
            body.includes("Current teammate model: test/test-model") &&
            body.includes("Available teammate variants for this model: low, medium, high") &&
            body.includes("Use team_spawn.variant only with one of these exact values") &&
            !body.includes("default, low"),
        ),
      ).toBe(true)
    }),
    {
      git: true,
      config: (url) => {
        const config = providerCfg(url)
        return {
          ...config,
          experimental: { agent_teams: true },
          provider: {
            ...config.provider,
            test: {
              ...config.provider.test,
              models: {
                ...config.provider.test.models,
                "test-model": {
                  ...config.provider.test.models["test-model"],
                  variants: { default: {}, low: {}, medium: {}, high: {} },
                },
              },
            },
          },
        }
      },
    },
  ),
)

it.live("tells team leads to omit variants when current model lookup fails", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Missing model" })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "decompose a migration" }],
      })
      yield* Database.Service.use((database) =>
        database.db
          .update(SessionTable)
          .set({ model: { providerID: "missing", id: "missing-model" } })
          .where(eq(SessionTable.id, chat.id))
          .run(),
      )
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: chat.id })

      const bodies = (yield* llm.inputs).map((input) => JSON.stringify(input))
      expect(
        bodies.some(
          (body) =>
            body.includes("Current teammate model: missing/missing-model") &&
            body.includes("Could not resolve teammate variants for the current model") &&
            body.includes("Omit team_spawn.variant rather than guessing"),
        ),
      ).toBe(true)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        experimental: { agent_teams: true },
      }),
    },
  ),
)

it.live("does not inject lead team guidance into teammate sessions", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const team = yield* Team.Service
      const lead = yield* sessions.create({ title: "Lead" })
      const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
      const info = yield* team.create({ name: "guide-team", goal: "Coordinate work", leadSessionID: lead.id })
      yield* team.addMember({
        teamID: info.id,
        sessionID: worker.id,
        name: "worker",
        agentType: "build",
        rolePrompt: "Investigate teammate behavior",
      })
      yield* llm.text("done")

      yield* prompt.prompt({
        sessionID: worker.id,
        agent: "build",
        model: ref,
        parts: [{ type: "text", text: "teammate work" }],
      })

      expect(
        (yield* llm.inputs)
          .map((input) => JSON.stringify(input))
          .filter((body) => body.includes("teammate work"))
          .some((body) => body.includes("Agent team orchestration is enabled")),
      ).toBe(false)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        experimental: { agent_teams: true },
      }),
    },
  ),
)

it.live("injects team mailbox messages into prompts and consumes the pending delivery", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const team = yield* Team.Service
      const lead = yield* sessions.create({ title: "Lead" })
      const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
      const info = yield* team.create({ name: "mailbox-team", goal: "Coordinate work", leadSessionID: lead.id })
      const workerMember = yield* team.addMember({
        teamID: info.id,
        sessionID: worker.id,
        name: "worker",
        agentType: "build",
        rolePrompt: "Report progress",
        lifecycle: "daemon",
      })
      expect(workerMember.lifecycle).toBe("daemon")
      yield* prompt.prompt({
        sessionID: lead.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "start coordinating" }],
      })
      yield* team.sendMessage({
        teamID: info.id,
        sender: worker.id,
        recipients: [lead.id],
        body: "Worker is ready.",
      })
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: lead.id })

      expect((yield* team.getPendingMessages(lead.id, info.id)).length).toBe(0)
      const teamMessageParts = (yield* sessions.messages({ sessionID: lead.id }))
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.TextPart => part.type === "text" && part.text.includes("Worker is ready."))
      expect(teamMessageParts).toHaveLength(1)
      expect(teamMessageParts[0].synthetic).toBe(true)
      expect(teamMessageParts[0].text).toBe(
        [
          "<team-messages>",
          "Review these messages and coordinate the next team action.",
          "",
          `From worker (${worker.id}):`,
          "Worker is ready.",
          "</team-messages>",
        ].join("\n"),
      )
      expect((yield* llm.inputs).some((input) => JSON.stringify(input).includes("Worker is ready."))).toBe(true)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        experimental: { agent_teams: true },
      }),
    },
  ),
)

it.live("bounds prompt mailbox rendering and preserves the exact managed artifact before commit", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const team = yield* Team.Service
      const lead = yield* sessions.create({ title: "Lead" })
      const sender = yield* sessions.create({ parentID: lead.id, title: "Sender" })
      const info = yield* team.create({ name: "bounded-mailbox", goal: "Bound mailbox input", leadSessionID: lead.id })
      const mutableTeam = team as Mutable<Team.Interface>
      const originalMarkMessageDelivered = team.markMessageDelivered
      const committed: string[] = []
      mutableTeam.markMessageDelivered = ((messageID, recipientSession) =>
        Effect.sync(() => committed.push(messageID)).pipe(
          Effect.andThen(originalMarkMessageDelivered(messageID, recipientSession)),
        )) as Team.Interface["markMessageDelivered"]
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          mutableTeam.markMessageDelivered = originalMarkMessageDelivered
        }),
      )
      yield* prompt.prompt({
        sessionID: lead.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "start coordinating" }],
      })
      const body = `large-start-${"y".repeat(800)}-large-end`
      const message = yield* team.sendMessage({
        teamID: info.id,
        sender: sender.id,
        recipients: [lead.id],
        body,
      })
      const expected = [
        "<team-messages>",
        "Review these messages and coordinate the next team action.",
        "",
        `From ${sender.id} (${sender.id}):`,
        body,
        "</team-messages>",
      ].join("\n")
      yield* llm.text("done")

      yield* prompt.loop({ sessionID: lead.id })

      const managedParts = (yield* sessions.messages({ sessionID: lead.id }))
        .flatMap((sessionMessage) => sessionMessage.parts)
        .filter(
          (part): part is MessageV2.TextPart =>
            part.type === "text" && part.synthetic === true && part.text.includes("Full output saved to:"),
        )
      expect(managedParts).toHaveLength(1)
      expect(managedParts[0].text).toContain("bytes truncated")
      expect(managedParts[0].text).not.toContain("large-end")
      const outputPath = managedParts[0].text.match(/Full output saved to: ([^\n]+)/)?.[1]
      expect(typeof outputPath).toBe("string")
      if (!outputPath) throw new Error("expected managed output path")
      expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(expected)
      expect(committed).toEqual([message.id])
      expect(yield* team.getPendingMessages(lead.id, info.id)).toHaveLength(0)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        experimental: { agent_teams: true },
        tool_output: { max_lines: 1_000, max_bytes: 160 },
      }),
    },
  ),
)

it.live("releases prompt mailbox claims after render failure and retries without loss", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const team = yield* Team.Service
      const truncate = yield* Truncate.Service
      const lead = yield* sessions.create({ title: "Lead" })
      const sender = yield* sessions.create({ parentID: lead.id, title: "Sender" })
      const info = yield* team.create({ name: "retry-mailbox", goal: "Retry mailbox input", leadSessionID: lead.id })
      const mutableTeam = team as Mutable<Team.Interface>
      const mutableTruncate = truncate as Mutable<Truncate.Interface>
      const originalMarkMessageDelivered = team.markMessageDelivered
      const originalOutput = truncate.output
      let renderAttempts = 0
      let commits = 0
      mutableTeam.markMessageDelivered = ((messageID, recipientSession) =>
        Effect.sync(() => {
          commits++
        }).pipe(
          Effect.andThen(originalMarkMessageDelivered(messageID, recipientSession)),
        )) as Team.Interface["markMessageDelivered"]
      mutableTruncate.output = ((...args) => {
        renderAttempts++
        return renderAttempts === 1 ? Effect.die(new Error("simulated prompt render failure")) : originalOutput(...args)
      }) as Truncate.Interface["output"]
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          mutableTeam.markMessageDelivered = originalMarkMessageDelivered
          mutableTruncate.output = originalOutput
        }),
      )
      yield* prompt.prompt({
        sessionID: lead.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "start coordinating" }],
      })
      yield* team.sendMessage({
        teamID: info.id,
        sender: sender.id,
        recipients: [lead.id],
        body: "Retry prompt mailbox delivery.",
      })

      const failed = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.exit)

      expect(Exit.isFailure(failed)).toBe(true)
      expect(commits).toBe(0)
      expect(yield* team.getPendingMessages(lead.id, info.id)).toHaveLength(1)

      yield* llm.text("done")
      yield* prompt.loop({ sessionID: lead.id })

      const delivered = (yield* sessions.messages({ sessionID: lead.id }))
        .flatMap((sessionMessage) => sessionMessage.parts)
        .filter(
          (part): part is MessageV2.TextPart =>
            part.type === "text" && part.synthetic === true && part.text.includes("Retry prompt mailbox delivery."),
        )
      expect(delivered).toHaveLength(1)
      expect(renderAttempts).toBe(2)
      expect(commits).toBe(1)
      expect(yield* team.getPendingMessages(lead.id, info.id)).toHaveLength(0)
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        experimental: { agent_teams: true },
      }),
    },
  ),
)

it.live("does not duplicate team message injection when delivery is suspended mid-way", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const team = yield* Team.Service
      const control = yield* SessionControl.Service
      const { db } = yield* Database.Service
      const deliveryClaimed = yield* Deferred.make<void>()
      const holdClaimedDelivery = yield* Deferred.make<void>()
      const messageInjected = yield* Deferred.make<void>()
      const mutableTeam = team as Mutable<Team.Interface>
      const mutableSessions = sessions as Mutable<Session.Interface>
      const originalClaimPendingMessages = team.claimPendingMessages
      const originalUpdatePart = sessions.updatePart
      let heldFirstClaim = false
      mutableTeam.claimPendingMessages = ((recipientSession, teamID) =>
        originalClaimPendingMessages(recipientSession, teamID).pipe(
          Effect.tap((messages) => {
            if (heldFirstClaim || !messages.some((message) => message.body === "Worker is ready.")) return Effect.void
            heldFirstClaim = true
            return Deferred.succeed(deliveryClaimed, undefined).pipe(
              Effect.andThen(Deferred.await(holdClaimedDelivery)),
            )
          }),
        )) as Team.Interface["claimPendingMessages"]
      mutableSessions.updatePart = ((part) =>
        originalUpdatePart(part).pipe(
          Effect.tap(() =>
            part.type === "text" && part.text.includes("Worker is ready.")
              ? Deferred.succeed(messageInjected, undefined)
              : Effect.void,
          ),
        )) as Session.Interface["updatePart"]
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(holdClaimedDelivery, undefined).pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.sync(() => {
              mutableTeam.claimPendingMessages = originalClaimPendingMessages
              mutableSessions.updatePart = originalUpdatePart
            }),
          ),
        ),
      )
      const lead = yield* sessions.create({ title: "Lead" })
      const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
      const info = yield* team.create({ name: "mid-delivery", goal: "Coordinate work", leadSessionID: lead.id })
      const workerMember = yield* team.addMember({
        teamID: info.id,
        sessionID: worker.id,
        name: "worker",
        agentType: "build",
        rolePrompt: "Report progress",
      })
      // Complete the worker so the finalization barrier does not park the lead indefinitely.
      // The canonical completion notification is harmless to this test's assertions.
      yield* team.updateMemberStatus(workerMember.id, "completed")
      yield* prompt.prompt({
        sessionID: lead.id,
        agent: "build",
        model: ref,
        noReply: true,
        parts: [{ type: "text", text: "start coordinating" }],
      })
      yield* team.sendMessage({
        teamID: info.id,
        sender: worker.id,
        recipients: [lead.id],
        body: "Worker is ready.",
      })
      yield* llm.text("done")

      const loop = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)

      // Hold the delivery after its durable claim and before marker or prompt writes. This latch
      // makes the suspension boundary deterministic without polling the recipient row.
      yield* awaitWithTimeout(Deferred.await(deliveryClaimed), "delivery was not claimed", "5 seconds")
      const paused = yield* control.pause({ rootSessionID: lead.id })
      expect(paused.interruptionSignalledSessionIDs).toContain(lead.id)
      yield* awaitWithTimeout(Fiber.await(loop), "timed out waiting for the claimed delivery interruption")
      yield* Deferred.succeed(holdClaimedDelivery, undefined)
      yield* control.release(lead.id)
      yield* prompt.wake(lead.id)
      yield* awaitWithTimeout(
        Deferred.await(messageInjected),
        "resumed delivery did not inject the team message",
        "5 seconds",
      )

      // Exactly one injection: the interrupted delivery either finished before the pause or was
      // re-run cleanly; it must never be injected twice.
      const teamMessageParts = (yield* sessions.messages({ sessionID: lead.id }))
        .flatMap((message) => message.parts)
        .filter((part): part is MessageV2.TextPart => part.type === "text" && part.text.includes("Worker is ready."))
      expect(teamMessageParts).toHaveLength(1)
      expect((yield* team.getPendingMessages(lead.id, info.id)).length).toBe(0)
      expect(
        (yield* db
          .select({ status: TeamMessageRecipientTable.delivery_status })
          .from(TeamMessageRecipientTable)
          .where(eq(TeamMessageRecipientTable.team_id, info.id))
          .get()
          .pipe(Effect.orDie))?.status,
      ).toBe("delivered")
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        experimental: { agent_teams: true },
      }),
    },
  ),
)

it.live(
  "does not inject removed memory guidance into prompts",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "update the Effect service filesystem usage" }],
        })

        const bodies = (yield* llm.inputs).map((input) => JSON.stringify(input))
        expect(bodies.some((body) => body.includes(["Historical", "review", "memory"].join(" ")))).toBe(false)
        expect(bodies.some((body) => body.includes("Prefer Effect FileSystem over raw fs/promises"))).toBe(false)
        expect(bodies.some((body) => body.includes("Repository memory tools are available"))).toBe(false)
      }),
      {
        git: true,
        config: providerCfg,
      },
    ),
  10_000,
)

it.live(
  "injects concise memory workflow guidance by default when memory is indexed",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const memory = yield* Memory.Service
        const current = yield* memory.currentRepository(dir)
        const repository = yield* memory.ensureRepository({
          reference: current.provider === "file" ? pathToFileURL(dir).href : current.identity,
        })
        yield* Database.Service.use((database) =>
          database.db
            .insert(RepositoryMemoryCommitTable)
            .values({
              id: `${repository.id}-commit`,
              repository_id: repository.id,
              hash: "abc123",
              message: "Fix auth validation regression",
              author_time: Date.now(),
              changed_files: JSON.stringify(["src/auth.ts"]),
              diff: "diff --git a/src/auth.ts b/src/auth.ts",
              token_text: tokenText("auth validation regression"),
              time_created: Date.now(),
              time_updated: Date.now(),
            })
            .run(),
        )
        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        yield* prompt.prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "debug auth validation" }],
        })

        const bodies = (yield* llm.inputs).map((input) => JSON.stringify(input))
        expect(bodies.some((body) => body.includes("Repository memory tools are available"))).toBe(true)
        expect(bodies.some((body) => body.includes("Search commits with two or three queries"))).toBe(true)
        expect(bodies.some((body) => body.includes(["Historical", "review", "memory"].join(" ")))).toBe(false)
        expect(bodies.some((body) => body.includes("diff --git a/src/auth.ts"))).toBe(false)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "team lead starts multiple teammates from one assistant step in parallel",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        let releaseRoutes = () => {}
        let releaseCli = () => {}
        const routesReleased = new Promise<void>((resolve) => {
          releaseRoutes = resolve
        })
        const cliReleased = new Promise<void>((resolve) => {
          releaseCli = resolve
        })
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const team = yield* Team.Service
        const lead = yield* sessions.create({
          title: "Lead",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* team.create({ name: "parallel-team", goal: "Check workflows", leadSessionID: lead.id })
        yield* prompt.prompt({
          sessionID: lead.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "check workflow routes and cli" }],
        })

        yield* llm.push(
          reply()
            .tool("team_spawn", {
              name: "routes",
              agent_type: "general",
              role_prompt: "Review workflow routes",
            })
            .tool("team_spawn", {
              name: "cli",
              agent_type: "general",
              role_prompt: "Review workflow CLI",
            }),
        )
        // The members run in the background on the reconciler poll, so their prompt requests
        // interleave with the lead's turns. Match each member on its prompt identity (present only
        // in the member request) instead of the role prompt, which the lead's tool-call history
        // also echoes. The identity string contains raw quotes, so match on the parsed message
        // content rather than JSON.stringify(hit.body), which escapes them.
        const teammateContent = (hit: { body?: Record<string, unknown> }) =>
          (
            ((hit.body as Record<string, unknown> | undefined)?.messages as Array<{ content?: string }> | undefined) ??
            []
          )
            .map((message) => message.content ?? "")
            .join("\n")
        const bodyContent = (body: Record<string, unknown>) =>
          ((body.messages as Array<{ content?: string }> | undefined) ?? [])
            .map((message) => message.content ?? "")
            .join("\n")
        yield* llm.pushMatch(
          (hit) => teammateContent(hit).includes('You are teammate "routes" in team "parallel-team"'),
          reply().wait(routesReleased).text("routes done").stop(),
        )
        yield* llm.pushMatch(
          (hit) => teammateContent(hit).includes('You are teammate "cli" in team "parallel-team"'),
          reply().wait(cliReleased).text("cli done").stop(),
        )
        // The lead's turn after the spawn tool calls returns starts immediately (the spawn does
        // not wait for the members), so it is served before any member request.
        yield* llm.textMatch((hit) => !teammateContent(hit).includes('You are teammate "'), "lead done")

        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        yield* Effect.promise(async () => {
          const end = Date.now() + 15_000
          while (Date.now() < end) {
            const bodies = await Effect.runPromise(llm.inputs)
            const contents = bodies.map((body) => bodyContent(body as Record<string, unknown>))
            if (
              contents.some((content) => content.includes('You are teammate "routes"')) &&
              contents.some((content) => content.includes('You are teammate "cli"'))
            ) {
              return
            }
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for both teammate prompts")
        })
        releaseRoutes()
        releaseCli()

        const result = yield* Fiber.join(fiber)
        // The lead produced its own finalization text in the tool-results turn, then parked at the
        // finalization barrier while the teammates ran in the background. Completion mail wakes the
        // parked lead and the loop continues through a mail-continuation turn before exiting, so the
        // final turn is a plain text stop rather than the earlier "lead done" message.
        expect(result.info.role).toBe("assistant")
        expect(result.info.role === "assistant" && result.info.finish).toBe("stop")
        expect(result.parts.some((part) => part.type === "text")).toBe(true)
        const leadHistory = yield* sessions.messages({ sessionID: lead.id })
        expect(
          leadHistory.some(
            (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text === "lead done"),
          ),
        ).toBe(true)
        const active = yield* team.getActive(lead.id)
        if (Option.isNone(active)) throw new Error("expected active team")
        const members = yield* team.getMembers(active.value.id)
        expect(members.filter((member) => member.status === "completed")).toHaveLength(2)
        // Completion reaches the lead through the mailbox auto-notification, not the spawn result.
        expect(
          leadHistory.some((m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.synthetic)),
        ).toBe(true)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "canceling a protocol-1 team lead force-closes without a final checkpoint and releases work",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const team = yield* Team.Service
        const status = yield* SessionStatus.Service
        const { db } = yield* Database.Service

        yield* llm.hang

        const lead = yield* sessions.create({ title: "Lead" })
        const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
        const info = yield* team.create({ name: "cancel-team", goal: "Abort together", leadSessionID: lead.id })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: worker.id,
          name: "worker",
          agentType: "build",
          rolePrompt: "Keep working until cancelled",
        })
        yield* team.updateMemberStatus(member.id, "active")
        const task = yield* team.createTask({
          teamID: info.id,
          description: "Reserved work",
          owned: [{ rootKey: "/work", pathKey: "/work/cancelled.txt", displayPath: "cancelled.txt" }],
        })
        yield* prompt.prompt({
          sessionID: worker.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "work until cancelled" }],
        })

        const workerFiber = yield* prompt.loop({ sessionID: worker.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect((yield* status.get(worker.id)).type).toBe("busy")

        yield* prompt.cancel(lead.id)
        const exit = yield* Fiber.await(workerFiber)
        const cancelledTask = yield* team.getTask(info.id, task.id)
        const forcedEvents = yield* db
          .select()
          .from(TeamUsageEventTable)
          .where(eq(TeamUsageEventTable.team_id, info.id))
          .all()
          .pipe(Effect.orDie)

        expect(Exit.isSuccess(exit)).toBe(true)
        expect(Option.isNone(yield* team.getActive(lead.id))).toBe(true)
        const closed = yield* team.get(info.id)
        expect(Option.isSome(closed)).toBe(true)
        if (Option.isSome(closed)) {
          expect(closed.value.status).toBe("closed")
          expect(closed.value.protocol_version).toBe(1)
          expect(closed.value.final_report_revision).toBeNull()
        }
        expect((yield* team.getMembers(info.id))[0]?.status).toBe("cancelled")
        expect(Option.isSome(cancelledTask)).toBe(true)
        if (Option.isSome(cancelledTask)) {
          expect(cancelledTask.value.status).toBe("cancelled")
          expect(cancelledTask.value.reservations[0]?.timeReleased).toBeNumber()
        }
        expect(forcedEvents).toHaveLength(1)
        expect(forcedEvents[0]).toMatchObject({
          type: "forced_shutdown",
          metadata: { reason: "Lead session cancelled", force: true, forced_at: expect.any(Number) },
        })
        expect((yield* status.get(worker.id)).type).toBe("idle")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  15_000,
)

// ---------------------------------------------------------------------------
// PR 2: private finalization barrier
// ---------------------------------------------------------------------------

it.live(
  "finalization rechecks a terminal handoff committed between its mailbox and member reads",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, info, member } = yield* parkLeadOnWorker({ llm })
        const barrier = yield* instrumentFinalizationParks()
        const mutableTeam = team as Mutable<Team.Interface>
        const mutableRun = barrier.run as Mutable<SessionRunState.Interface>
        const originalGetMembers = team.getMembers
        const originalHandoffPark = barrier.run.handoffPark
        let committed = false
        let handoffCalls = 0
        mutableTeam.getMembers = ((teamID) =>
          Effect.gen(function* () {
            if (!committed && teamID === info.id) {
              committed = true
              yield* team.updateMemberStatus(member.id, "completed", "handoff committed during exit check")
            }
            return yield* originalGetMembers(teamID)
          })) as Team.Interface["getMembers"]
        mutableRun.handoffPark = ((sessionID, signal, replacement) =>
          Effect.sync(() => {
            handoffCalls++
          }).pipe(
            Effect.andThen(originalHandoffPark(sessionID, signal, replacement)),
          )) as SessionRunState.Interface["handoffPark"]
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mutableTeam.getMembers = originalGetMembers
            mutableRun.handoffPark = originalHandoffPark
          }),
        )

        yield* llm.text("done")
        yield* llm.text("integrated handoff")
        const result = yield* awaitWithTimeout(
          prompt.loop({ sessionID: lead.id }),
          "lead did not integrate the terminal handoff",
          "10 seconds",
        )

        expect(committed).toBe(true)
        expect(yield* llm.calls).toBe(2)
        // The true durable recheck continued this loop without retirement. Only the later false
        // successful-exit decision handed off, so no stale continuation can start after this run.
        expect(handoffCalls).toBe(1)
        expect(result.parts.some((part) => part.type === "text" && part.text === "integrated handoff")).toBe(true)
        const mailParts = (yield* sessions.messages({ sessionID: lead.id }))
          .flatMap((message) => message.parts)
          .filter(
            (part): part is MessageV2.TextPart =>
              part.type === "text" && part.text.includes("handoff committed during exit check"),
          )
        expect(mailParts).toHaveLength(1)
        expect(yield* team.getPendingMessages(lead.id, info.id)).toHaveLength(0)
        const registration = yield* barrier.next("terminal-race barrier registration")
        expect(registration.sessionID).toBe(lead.id)
        expect(yield* barrier.run.signalPark(lead.id)).toBe(false)
        expect(barrier.activeFallbacks()).toBe(0)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "finalization handoff rechecks daemon mail committed after its final durable read",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
          lifecycle: "daemon",
          daemonState: "running",
        })
        const barrier = yield* instrumentFinalizationParks()
        const stagedMessageID = yield* Deferred.make<string>()
        yield* barrier.beforeNextHandoff(
          Effect.gen(function* () {
            const message = yield* team.sendMessage({
              teamID: info.id,
              sender: worker.id,
              recipients: [lead.id],
              body: "daemon mail at final handoff",
            })
            // A duplicate match remains attached to the same old registration. The atomic handoff
            // must still replace it and force a durable recheck instead of starting another run.
            expect(yield* barrier.run.signalPark(lead.id)).toBe(true)
            yield* Deferred.succeed(stagedMessageID, message.id)
          }).pipe(Effect.orDie),
        )

        yield* llm.text("initial finalization")
        yield* llm.text("daemon mail integrated")
        const result = yield* awaitWithTimeout(
          prompt.loop({ sessionID: lead.id }),
          "lead did not continue after the final handoff signal",
          "10 seconds",
        )
        const messageID = yield* Deferred.await(stagedMessageID)

        expect(yield* llm.calls).toBe(2)
        expect(JSON.stringify((yield* llm.inputs)[1])).toContain("daemon mail at final handoff")
        expect(result.parts.some((part) => part.type === "text" && part.text === "daemon mail integrated")).toBe(true)
        expect((yield* team.getPendingMessages(lead.id, info.id)).map((message) => message.id)).not.toContain(messageID)
        expect(
          (yield* sessions.messages({ sessionID: lead.id }))
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text" && part.text.includes("daemon mail at final handoff")),
        ).toHaveLength(1)
        expect(yield* barrier.run.signalPark(lead.id)).toBe(false)
        expect(barrier.activeFallbacks()).toBe(0)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "direct mail signal survives final handoff while event publication is blocked",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
          lifecycle: "daemon",
          daemonState: "running",
        })
        const barrier = yield* instrumentFinalizationParks()
        const publication = yield* barrier.gatePublish
        const senderScope = yield* Scope.make()
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(publication.release, undefined).pipe(Effect.andThen(Scope.close(senderScope, Exit.void))),
        )
        const sender =
          yield* Deferred.make<Fiber.Fiber<Team.Message, Team.MessageToClosedTeam | Team.MessageToTerminalMember>>()

        yield* barrier.beforeNextHandoff(
          Effect.gen(function* () {
            const fiber = yield* team
              .sendMessage({
                teamID: info.id,
                sender: worker.id,
                recipients: [lead.id],
                body: "mail committed before blocked publication",
              })
              .pipe(Effect.forkIn(senderScope))
            yield* Deferred.succeed(sender, fiber)
            yield* awaitWithTimeout(
              Deferred.await(publication.entered),
              "mail publication did not reach the gate",
              "5 seconds",
            )
          }).pipe(Effect.orDie),
        )

        yield* llm.text("initial finalization")
        yield* llm.text("blocked-publication mail integrated")
        const result = yield* awaitWithTimeout(
          prompt.loop({ sessionID: lead.id }),
          "lead did not continue while mail publication was blocked",
          "10 seconds",
        )
        const senderFiber = yield* Deferred.await(sender)

        expect(yield* Deferred.isDone(publication.release)).toBe(false)
        expect(yield* llm.calls).toBe(2)
        expect(JSON.stringify((yield* llm.inputs)[1])).toContain("mail committed before blocked publication")
        expect(
          result.parts.some((part) => part.type === "text" && part.text === "blocked-publication mail integrated"),
        ).toBe(true)
        expect(
          (yield* sessions.messages({ sessionID: lead.id }))
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text" && part.text.includes("mail committed before blocked publication")),
        ).toHaveLength(1)
        expect(yield* team.getPendingMessages(lead.id, info.id)).toHaveLength(0)

        yield* Deferred.succeed(publication.release, undefined)
        const message = yield* awaitWithTimeout(
          Fiber.join(senderFiber),
          "mail sender did not finish after publication release",
          "5 seconds",
        )
        expect((yield* team.getMessages(info.id)).map((item) => item.id)).toContain(message.id)
        expect(yield* barrier.run.signalPark(lead.id)).toBe(false)
        expect(barrier.activeFallbacks()).toBe(0)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "direct mail starts a new Prompt run after retirement and fallback cleanup settle",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, team, lead, worker, info } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
          lifecycle: "daemon",
          daemonState: "running",
        })
        const barrier = yield* instrumentFinalizationParks({ fallbackCallbacks: true })

        yield* llm.text("initial finalization")
        yield* llm.text("post-retirement mail integrated")
        const initial = yield* awaitWithTimeout(
          prompt.loop({ sessionID: lead.id }),
          "initial lead run did not settle",
          "10 seconds",
        )

        expect(initial.parts.some((part) => part.type === "text" && part.text === "initial finalization")).toBe(true)
        expect(yield* barrier.run.signalPark(lead.id)).toBe(false)
        expect(barrier.activeFallbacks()).toBe(0)

        const publication = yield* barrier.gatePublish
        yield* Effect.addFinalizer(() => Deferred.succeed(publication.release, undefined).pipe(Effect.ignore))
        const sender = yield* team
          .sendMessage({
            teamID: info.id,
            sender: worker.id,
            recipients: [lead.id],
            body: "mail after retirement settled",
          })
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(
          Deferred.await(publication.entered),
          "post-retirement mail publication did not reach the gate",
          "5 seconds",
        )
        yield* llm.wait(2)

        expect(yield* Deferred.isDone(publication.release)).toBe(false)
        expect(JSON.stringify((yield* llm.inputs)[1])).toContain("mail after retirement settled")
        expect(yield* team.getPendingMessages(lead.id, info.id)).toHaveLength(0)
        expect(barrier.activeFallbacks()).toBe(0)

        yield* Deferred.succeed(publication.release, undefined)
        yield* awaitWithTimeout(Fiber.join(sender), "post-retirement mail sender did not finish", "5 seconds")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "plan approval starts the real idle planner before event publication",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const team = yield* Team.Service
        const events = yield* EventV2Bridge.Service
        const lead = yield* sessions.create({ title: "Approval lead" })
        const planner = yield* sessions.create({ title: "Planner", parentID: lead.id })
        yield* seed(planner.id, { finish: "stop" })
        const info = yield* team.create({
          name: "approval-publish-gate",
          goal: "Wake the real planner before publication",
          leadSessionID: lead.id,
        })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: planner.id,
          name: "planner",
          agentType: "build",
          rolePrompt: "Plan first",
          planMode: true,
          workMode: "plan",
        })
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const mutableEvents = events as Mutable<EventV2Bridge.Interface>
        const originalPublish = events.publish
        mutableEvents.publish = ((definition, data, options) =>
          definition.type === "team.member.updated"
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(originalPublish(definition, data, options)),
              )
            : originalPublish(definition, data, options)) as EventV2Bridge.Interface["publish"]
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(release, undefined).pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.sync(() => {
                mutableEvents.publish = originalPublish
              }),
            ),
          ),
        )

        yield* llm.text("implementation resumed")
        const approval = yield* team
          .approveMemberPlan(member.id, {
            sender: lead.id,
            body: "PLAN APPROVED. Proceed with implementation.",
            usageMetadata: { member_name: member.name },
          })
          .pipe(Effect.forkChild)
        yield* awaitWithTimeout(
          Deferred.await(entered),
          "plan approval publication did not reach the gate",
          "5 seconds",
        )
        yield* llm.wait(1)

        expect(yield* Deferred.isDone(release)).toBe(false)
        expect(JSON.stringify((yield* llm.inputs)[0])).toContain("PLAN APPROVED. Proceed with implementation.")
        expect(yield* team.getPendingMessages(planner.id, info.id)).toHaveLength(0)
        expect((yield* team.getUsageEvents(info.id)).filter((event) => event.type === "plan_approved")).toHaveLength(1)

        // The tool-level wake runs after approveMemberPlan returns. Repeated full wakes attach to
        // the current run or execute a no-op finished-loop pass; neither can start another model turn.
        yield* prompt.wake(planner.id)
        yield* prompt.wake(planner.id)
        expect(yield* llm.calls).toBe(1)

        yield* Deferred.succeed(release, undefined)
        const approved = yield* awaitWithTimeout(Fiber.join(approval), "plan approval did not finish", "5 seconds")
        expect(Option.isSome(approved)).toBe(true)
        expect(Option.getOrThrow(approved)).toMatchObject({
          status: "active",
          plan_mode: false,
          work_mode: "implement",
        })
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "fallback from another instance notifies the retiring park across final handoff",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, lead, worker, info } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
          lifecycle: "daemon",
          daemonState: "running",
        })
        const events = yield* EventV2Bridge.Service
        const instanceStore = yield* InstanceStore.Service
        const barrier = yield* instrumentFinalizationParks({ fallbackCallbacks: true })
        const otherInstance = yield* tmpdirScoped()
        const continuationFinalized = yield* Deferred.make<void>()

        yield* barrier.afterNextHandoff(
          instanceStore.provide(
            { directory: otherInstance },
            Effect.gen(function* () {
              // The publishing instance has no matching direct registration. Only the fallback
              // callback retained by this barrier can notify its identity-bound retiring handle.
              expect(yield* barrier.run.signalPark(lead.id)).toBe(false)
              expect(barrier.activeFallbacks()).toBe(4)
              yield* events.publish(MessageReceived, {
                messageID: `msg_fallback_${crypto.randomUUID()}`,
                teamID: info.id,
                sender: worker.id,
              })
              yield* barrier.afterNextHandoff(Deferred.succeed(continuationFinalized, undefined))
            }),
          ),
        )

        yield* llm.text("initial finalization")
        const result = yield* awaitWithTimeout(
          prompt.loop({ sessionID: lead.id }),
          "initial run did not settle after the fallback handoff signal",
          "10 seconds",
        )
        yield* awaitWithTimeout(
          Deferred.await(continuationFinalized),
          "fallback handoff did not start and finalize its queued continuation",
          "10 seconds",
        )

        expect(result.parts.some((part) => part.type === "text" && part.text === "initial finalization")).toBe(true)
        expect(yield* llm.calls).toBe(1)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "a normal prompt runs only in the session's owning instance",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const instanceStore = yield* InstanceStore.Service
        const session = yield* sessions.create({ title: "Owned prompt" })
        const otherInstance = yield* tmpdirScoped()

        const foreign = yield* instanceStore
          .provide(
            { directory: otherInstance },
            prompt.prompt({
              sessionID: session.id,
              agent: "build",
              model: ref,
              parts: [{ type: "text", text: "foreign prompt must not persist" }],
            }),
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(foreign)).toBe(true)
        if (Exit.isSuccess(foreign)) throw new Error("Foreign prompt unexpectedly succeeded")
        expect(String(Cause.squash(foreign.cause))).toContain("different project instance")
        expect(yield* sessions.messages({ sessionID: session.id })).toHaveLength(0)
        expect(yield* llm.calls).toBe(0)

        yield* llm.text("owner response")
        const response = yield* prompt.prompt({
          sessionID: session.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "owner prompt" }],
        })

        expect(response.parts).toContainEqual(expect.objectContaining({ type: "text", text: "owner response" }))
        expect(yield* llm.calls).toBe(1)
        expect(JSON.stringify((yield* llm.inputs)[0])).toContain("owner prompt")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "lead input stores tool permissions before its direct wake can start the continuation",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, member } = yield* parkLeadOnWorker({ llm, memberStatus: "active" })
        const barrier = yield* instrumentFinalizationParks()
        const wakeEntered = yield* Deferred.make<void>()
        const releaseWake = yield* Deferred.make<void>()
        const mutableRun = barrier.run as Mutable<SessionRunState.Interface>
        const originalWakeRegistered = barrier.run.wakeRegistered
        mutableRun.wakeRegistered = ((sessionID) =>
          Deferred.succeed(wakeEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWake)),
            Effect.andThen(originalWakeRegistered(sessionID)),
          )) as SessionRunState.Interface["wakeRegistered"]
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(releaseWake, undefined).pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.sync(() => {
                mutableRun.wakeRegistered = originalWakeRegistered
              }),
            ),
          ),
        )

        yield* llm.text("initial finalization")
        yield* llm.text("permission-aware continuation")
        const loopFiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* barrier.next("initial permission barrier registration")
        yield* barrier.next("stable permission barrier registration")

        const inputFiber = yield* prompt
          .prompt({
            sessionID: lead.id,
            agent: "build",
            model: ref,
            noReply: true,
            tools: { read: false },
            parts: [{ type: "text", text: "continue without read" }],
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(wakeEntered)

        expect((yield* sessions.get(lead.id)).permission).toContainEqual({
          permission: "read",
          action: "deny",
          pattern: "*",
        })
        expect(yield* llm.calls).toBe(1)

        yield* Deferred.succeed(releaseWake, undefined)
        expect((yield* Fiber.join(inputFiber)).info.role).toBe("user")
        yield* llm.wait(2)
        yield* barrier.next("permission continuation barrier registration")
        yield* barrier.next("permission continuation re-park")
        expect(yield* llm.calls).toBe(2)

        yield* team.updateMemberStatus(member.id, "completed")
        yield* awaitWithTimeout(Fiber.join(loopFiber), "permission-aware lead did not exit", "5 seconds")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "foreign instances reject durable team producers before commit",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const sessions = yield* Session.Service
        const team = yield* Team.Service
        const instanceStore = yield* InstanceStore.Service
        const lead = yield* sessions.create({ title: "Owner lead" })
        const memberSession = yield* sessions.create({ parentID: lead.id, title: "Owner member" })
        const info = yield* team.create({ name: "owner-team", goal: "Keep mutations local", leadSessionID: lead.id })
        const member = yield* team.addMember({
          teamID: info.id,
          sessionID: memberSession.id,
          name: "planner",
          agentType: "general",
          model: ref,
          rolePrompt: "Plan locally",
          planMode: true,
          workMode: "plan",
        })
        const otherInstance = yield* tmpdirScoped()
        const initialRevision = Option.getOrThrow(yield* team.get(info.id)).revision
        const assertForeignFailure = <A, E>(result: Exit.Exit<A, E>) => {
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isSuccess(result)) throw new Error("Foreign team mutation unexpectedly succeeded")
          expect(String(Cause.squash(result.cause))).toContain("different project instance")
        }

        const foreignMail = yield* instanceStore
          .provide(
            { directory: otherInstance },
            team.sendMessage({
              teamID: info.id,
              sender: memberSession.id,
              recipients: [lead.id],
              body: "must not commit",
            }),
          )
          .pipe(Effect.exit)
        const foreignStatus = yield* instanceStore
          .provide({ directory: otherInstance }, team.updateMemberStatus(member.id, "completed", "must not commit"))
          .pipe(Effect.exit)
        const foreignApproval = yield* instanceStore
          .provide(
            { directory: otherInstance },
            team.approveMemberPlan(member.id, {
              sender: lead.id,
              body: "must not commit",
              usageMetadata: {},
            }),
          )
          .pipe(Effect.exit)
        const foreignShutdown = yield* instanceStore
          .provide(
            { directory: otherInstance },
            team.shutdown({ teamID: info.id, sessionID: lead.id, force: true, reason: "ownership test" }),
          )
          .pipe(Effect.exit)

        assertForeignFailure(foreignMail)
        assertForeignFailure(foreignStatus)
        assertForeignFailure(foreignApproval)
        assertForeignFailure(foreignShutdown)
        expect(Option.getOrThrow(yield* team.get(info.id))).toMatchObject({
          status: "active",
          revision: initialRevision,
        })
        expect((yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)).toMatchObject({
          status: "starting",
          plan_mode: true,
          work_mode: "plan",
        })
        expect(yield* team.getMessages(info.id)).toHaveLength(0)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "material input and daemon mail after successful handoff queue one continuation after the current run",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
          lifecycle: "daemon",
          daemonState: "running",
        })
        const barrier = yield* instrumentFinalizationParks()
        const continuationFinalized = yield* Deferred.make<void>()
        yield* barrier.afterNextHandoff(
          Effect.gen(function* () {
            // Both durable writes occur after handoffPark has retired the active registration but
            // before this Runner can settle. Their matching signals must coalesce on one queued run.
            yield* prompt.prompt({
              sessionID: lead.id,
              agent: "build",
              model: ref,
              noReply: true,
              parts: [{ type: "text", text: "lead input after successful handoff" }],
            })
            yield* team.sendMessage({
              teamID: info.id,
              sender: worker.id,
              recipients: [lead.id],
              body: "daemon mail after successful handoff",
            })
            yield* barrier.afterNextHandoff(Deferred.succeed(continuationFinalized, undefined))
          }).pipe(Effect.orDie),
        )

        yield* llm.text("initial finalization")
        yield* llm.text("post-handoff material integrated")
        const initial = yield* awaitWithTimeout(
          prompt.loop({ sessionID: lead.id }),
          "initial lead run did not settle after successful handoff",
          "10 seconds",
        )
        yield* awaitWithTimeout(
          Deferred.await(continuationFinalized),
          "retired handoff did not run its queued continuation",
          "10 seconds",
        )

        expect(initial.parts.some((part) => part.type === "text" && part.text === "initial finalization")).toBe(true)
        expect(yield* llm.calls).toBe(2)
        const continuationInput = JSON.stringify((yield* llm.inputs)[1])
        expect(continuationInput).toContain("lead input after successful handoff")
        expect(continuationInput).toContain("daemon mail after successful handoff")
        expect(
          (yield* sessions.messages({ sessionID: lead.id }))
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text" && part.text.includes("daemon mail after successful handoff")),
        ).toHaveLength(1)
        expect(yield* team.getPendingMessages(lead.id, info.id)).toHaveLength(0)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "a normal prompt after successful handoff returns the continuation assistant",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, lead } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
          lifecycle: "daemon",
          daemonState: "running",
        })
        const barrier = yield* instrumentFinalizationParks()
        const promptScope = yield* Scope.make()
        const ensureRunningAttached = yield* Latch.make()
        const mutableRun = barrier.run as Mutable<SessionRunState.Interface>
        const originalEnsureRunning = barrier.run.ensureRunning
        let normalPrompt: Fiber.Fiber<SessionV1.WithParts, Image.Error | Runner.Suspended> | undefined
        yield* Effect.addFinalizer(() =>
          Scope.close(promptScope, Exit.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                mutableRun.ensureRunning = originalEnsureRunning
              }),
            ),
          ),
        )

        yield* barrier.afterNextHandoff(
          Effect.gen(function* () {
            // Hold the handoff hook until Runner opens the latch from its locked state transition,
            // proving the nested normal prompt attached to the signalled retirement.
            mutableRun.ensureRunning = ((sessionID, onInterrupt, work) =>
              originalEnsureRunning(
                sessionID,
                onInterrupt,
                work,
                ensureRunningAttached,
              )) as SessionRunState.Interface["ensureRunning"]
            normalPrompt = yield* prompt
              .prompt({
                sessionID: lead.id,
                agent: "build",
                model: ref,
                parts: [{ type: "text", text: "normal input after successful handoff" }],
              })
              .pipe(Effect.forkIn(promptScope))
            yield* awaitWithTimeout(
              ensureRunningAttached.await,
              "normal prompt did not attach to the retiring run",
              "5 seconds",
            )
          }).pipe(Effect.orDie),
        )

        yield* llm.text("old assistant")
        yield* llm.text("continuation assistant")
        const initial = yield* awaitWithTimeout(
          prompt.loop({ sessionID: lead.id }),
          "initial lead run did not settle",
          "10 seconds",
        )
        if (!normalPrompt) throw new Error("normal prompt did not start after handoff")
        const result = yield* awaitWithTimeout(
          Fiber.join(normalPrompt),
          "normal prompt did not return its continuation result",
          "10 seconds",
        )

        expect(initial.parts).toContainEqual(expect.objectContaining({ type: "text", text: "old assistant" }))
        expect(result.parts).toContainEqual(expect.objectContaining({ type: "text", text: "continuation assistant" }))
        expect(result.parts).not.toContainEqual(expect.objectContaining({ type: "text", text: "old assistant" }))
        expect(yield* llm.calls).toBe(2)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "real barrier uses direct material wakes without fallback events or idle model and tool calls",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
        })
        const barrier = yield* instrumentFinalizationParks()
        const mailClaimed = yield* Deferred.make<void>()
        const mutableTeam = team as Mutable<Team.Interface>
        const originalClaimPendingMessages = team.claimPendingMessages
        mutableTeam.claimPendingMessages = ((recipientSession, teamID) =>
          originalClaimPendingMessages(recipientSession, teamID).pipe(
            Effect.tap((messages) =>
              messages.some((message) => message.body === "direct material wake")
                ? Deferred.succeed(mailClaimed, undefined)
                : Effect.void,
            ),
          )) as Team.Interface["claimPendingMessages"]
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mutableTeam.claimPendingMessages = originalClaimPendingMessages
          }),
        )
        const toolCalls = () =>
          sessions
            .messages({ sessionID: lead.id })
            .pipe(
              Effect.map(
                (messages) =>
                  messages.flatMap((message) => message.parts).filter((part) => part.type === "tool").length,
              ),
            )

        yield* llm.text("parked")
        yield* llm.text("mail handled")
        yield* llm.text("user handled")
        const loopFiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const initial = yield* barrier.next("initial barrier registration")
        const parked = yield* barrier.next("stable barrier registration")
        expect(initial.sessionID).toBe(lead.id)
        expect(parked.sessionID).toBe(lead.id)
        expect(barrier.activeFallbacks()).toBe(4)
        const parkedCalls = yield* llm.calls
        expect(parkedCalls).toBe(1)
        expect(yield* toolCalls()).toBe(0)

        // Durable teammate input and unrelated direct signals target only the teammate session.
        // The current lead park remains incomplete without any timing window or negative timeout.
        yield* prompt.prompt({
          sessionID: worker.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "teammate-only input" }],
        })
        expect(yield* barrier.run.signalPark(worker.id)).toBe(false)
        expect(yield* barrier.run.signalPark(worker.id)).toBe(false)
        expect(yield* Deferred.isDone(parked.signal)).toBe(false)
        expect((yield* llm.calls) - parkedCalls).toBe(0)
        expect(yield* toolCalls()).toBe(0)

        // Duplicate matching signals can trigger durable rechecks, but they cannot schedule a
        // model turn when no durable lead input changed.
        expect(yield* barrier.run.signalPark(lead.id)).toBe(true)
        expect(yield* barrier.run.signalPark(lead.id)).toBe(true)
        expect(yield* Deferred.isDone(parked.signal)).toBe(true)
        const reparked = yield* barrier.next("re-park after duplicate signals")
        expect(reparked.sessionID).toBe(lead.id)
        expect((yield* llm.calls) - parkedCalls).toBe(0)
        expect(yield* toolCalls()).toBe(0)

        // The fallback publish fails after durable team mail commits. Team's post-commit direct
        // signal must still complete the real barrier signal, deliver the mail, take exactly one
        // model turn, and re-park.
        yield* barrier.failPublish
        const message = yield* team.sendMessage({
          teamID: info.id,
          sender: worker.id,
          recipients: [lead.id],
          body: "direct material wake",
        })
        yield* barrier.restorePublish
        expect(yield* Deferred.isDone(reparked.signal)).toBe(true)
        yield* awaitWithTimeout(Deferred.await(mailClaimed), "directly signalled mail was not claimed", "5 seconds")
        yield* llm.wait(2)
        yield* barrier.next("mail decision replacement")
        yield* barrier.next("mail continuation barrier registration")
        yield* barrier.next("mail continuation re-park")
        expect(yield* llm.calls).toBe(2)
        expect(yield* toolCalls()).toBe(0)
        expect((yield* team.getPendingMessages(lead.id, info.id)).map((item) => item.id)).not.toContain(message.id)

        // Lead input is durable before its direct signal. It resumes one turn and reaches a fresh
        // stable registration while the finite teammate remains active.
        expect(yield* barrier.run.signalPark(lead.id)).toBe(true)
        const leadInputPark = yield* barrier.next("confirmed lead-input park")
        expect((yield* llm.calls) - 2).toBe(0)
        yield* prompt.prompt({
          sessionID: lead.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "lead material input" }],
        })
        expect(yield* Deferred.isDone(leadInputPark.signal)).toBe(true)
        yield* llm.wait(3)
        yield* barrier.next("lead-input continuation barrier registration")
        const afterLeadInput = yield* barrier.next("lead-input continuation re-park")
        expect(afterLeadInput.sessionID).toBe(lead.id)
        expect(yield* llm.calls).toBe(3)
        expect(yield* toolCalls()).toBe(0)
        expect(JSON.stringify((yield* llm.inputs)[2])).toContain("lead material input")
        expect(barrier.activeFallbacks()).toBe(4)

        // Interruption removes the current park registration and all fallback cleanup handles.
        yield* setLegacyTeamProtocol(info.id)
        yield* prompt.cancel(lead.id)
        yield* awaitWithTimeout(Fiber.join(loopFiber), "cancelled lead loop did not settle", "5 seconds")
        expect(yield* barrier.run.signalPark(lead.id)).toBe(false)
        expect(barrier.activeFallbacks()).toBe(0)
        expect(yield* llm.calls).toBe(3)
        expect(yield* toolCalls()).toBe(0)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "finalization barrier delivers mail that arrives after the initial mailbox check and resumes the lead",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info, member } = yield* parkLeadOnWorker({ llm })
        // Turn 1 (lead finalizes while the worker is nonterminal) and turn 2 (after the mail
        // continuation integrates the handoff).
        yield* llm.text("done")
        yield* llm.text("done again")
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        // Wait until turn 1's assistant message is committed, so the top-of-loop mailbox check of
        // the finalizing iteration has already run.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* sessions.messages({ sessionID: lead.id })
            const done = msgs.some(
              (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text === "done"),
            )
            return done ? (true as const) : undefined
          }),
          "turn 1 never completed",
          "5 seconds",
        )
        // Send mail after the initial mailbox check but before the lead finalizes; the barrier
        // (or the next loop pass) must deliver it and resume the model loop.
        yield* team.sendMessage({
          teamID: info.id,
          sender: worker.id,
          recipients: [lead.id],
          body: "Late progress",
        })
        // The continuation turn must be taken: the second assistant message ("done again")
        // appears after the mail is integrated.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* sessions.messages({ sessionID: lead.id })
            const doneAgain = msgs.some(
              (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text === "done again"),
            )
            return doneAgain ? (true as const) : undefined
          }),
          "lead did not take a continuation turn after mail delivery",
          "5 seconds",
        )
        // The worker is still nonterminal, so the lead parks again despite the progress.
        yield* assertLoopParked(fiber, "lead should park while the worker is nonterminal")
        // Completing the worker releases the barrier.
        yield* team.updateMemberStatus(member.id, "completed")
        const result = yield* awaitWithTimeout(
          Fiber.join(fiber),
          "lead did not exit after the worker completed",
          "5 seconds",
        )
        expect(result.info.role).toBe("assistant")
        const mailParts = (yield* sessions.messages({ sessionID: lead.id }))
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.TextPart => part.type === "text" && part.text.includes("Late progress"))
        expect(mailParts).toHaveLength(1)
        expect((yield* team.getPendingMessages(lead.id, info.id)).length).toBe(0)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "nonterminal task members park the lead; completion and cancellation release it",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        // `idle` is an anomalous status for a task member and must park like the finite statuses.
        const statuses: Team.MemberStatus[] = ["starting", "blocked", "active", "idle"]
        for (const memberStatus of statuses) {
          const { prompt, team, lead, info, member } = yield* parkLeadOnWorker({ llm, memberStatus })
          yield* llm.text("done")
          const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
          yield* assertLoopParked(fiber, `lead should park for task member status ${memberStatus}`)
          yield* team.updateMemberStatus(member.id, "completed")
          const result = yield* awaitWithTimeout(
            Fiber.join(fiber),
            `lead did not exit after completing ${memberStatus} member`,
            "5 seconds",
          )
          expect(result.info.role).toBe("assistant")
        }
        // Cancellation releases the barrier exactly like completion.
        const { prompt, team, lead, info, member } = yield* parkLeadOnWorker({ llm, memberStatus: "active" })
        yield* llm.text("done")
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        yield* assertLoopParked(fiber, "lead should park before cancellation")
        yield* team.updateMemberStatus(member.id, "cancelled")
        const result = yield* awaitWithTimeout(
          Fiber.join(fiber),
          "lead did not exit after cancelling the member",
          "5 seconds",
        )
        expect(result.info.role).toBe("assistant")
        expect((yield* team.getMembers(info.id))[0]?.status).toBe("cancelled")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  60_000,
)

it.live(
  "cancelling a dependency does not release the barrier while a dependent stays blocked",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, team, lead, info, member } = yield* parkLeadOnWorker({ llm, memberStatus: "blocked" })
        const dep = yield* team.createTask({ teamID: info.id, description: "dependency" })
        yield* team.createTask({
          teamID: info.id,
          description: "blocked by dependency",
          dependencyIDs: [dep.id],
        })
        yield* llm.text("done")
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        yield* assertLoopParked(fiber, "lead should park while the dependent is blocked")
        // Cancelling the dependency must NOT make the blocked dependent terminal.
        yield* team.updateTask(info.id, dep.id, { status: "cancelled" })
        yield* Effect.sleep("300 millis")
        yield* assertLoopParked(fiber, "lead must stay parked after the dependency is cancelled")
        // Cancelling the blocked dependent releases the barrier.
        yield* team.updateMemberStatus(member.id, "cancelled")
        const result = yield* awaitWithTimeout(
          Fiber.join(fiber),
          "lead did not exit after cancelling the dependent",
          "5 seconds",
        )
        expect(result.info.role).toBe("assistant")
        const depTask = yield* team.getTask(info.id, dep.id)
        if (Option.isSome(depTask)) expect(depTask.value.status).toBe("cancelled")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "pending mail from an already-terminal teammate resumes the loop at the barrier",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info, member } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
        })
        yield* llm.text("done")
        yield* llm.text("done again")
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        // The lead parks deterministically on the active worker before any mail is staged.
        yield* assertLoopParked(fiber, "lead should park before mail staging")
        // Stage mail from the worker, then complete it: when the barrier rechecks, the teammate
        // is terminal AND its mail is pending, so the deliver-before-member ordering must resume
        // the loop (continue) instead of permitting exit.
        yield* team.sendMessage({
          teamID: info.id,
          sender: worker.id,
          recipients: [lead.id],
          body: "Final handoff",
        })
        yield* team.updateMemberStatus(member.id, "completed")
        // The loop must take a continuation turn and then exit with the mail delivered.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* sessions.messages({ sessionID: lead.id })
            const delivered = msgs.some((m) =>
              m.parts.some((p) => p.type === "text" && p.text.includes("Final handoff")),
            )
            return delivered ? (true as const) : undefined
          }),
          "terminal teammate mail was never delivered",
          "5 seconds",
        )
        const result = yield* awaitWithTimeout(Fiber.join(fiber), "lead did not exit after terminal mail", "5 seconds")
        expect(result.info.role).toBe("assistant")
        const mailParts = (yield* sessions.messages({ sessionID: lead.id }))
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.TextPart => part.type === "text" && part.text.includes("Final handoff"))
        expect(mailParts).toHaveLength(1)
        expect((yield* team.getPendingMessages(lead.id, info.id)).length).toBe(0)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "progress mail while a teammate remains active resumes the loop and the lead parks again",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info, member } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
        })
        yield* llm.text("done")
        yield* llm.text("done again")
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* sessions.messages({ sessionID: lead.id })
            const done = msgs.some(
              (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text === "done"),
            )
            return done ? (true as const) : undefined
          }),
          "turn 1 never completed",
          "5 seconds",
        )
        yield* team.sendMessage({
          teamID: info.id,
          sender: worker.id,
          recipients: [lead.id],
          body: "Progress while active",
        })
        // The mail resumes the loop (continuation turn)...
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* sessions.messages({ sessionID: lead.id })
            const delivered = msgs.some((m) =>
              m.parts.some((p) => p.type === "text" && p.text.includes("Progress while active")),
            )
            return delivered ? (true as const) : undefined
          }),
          "progress mail was never delivered",
          "5 seconds",
        )
        // ...but the teammate is still active, so the loop parks again instead of exiting.
        yield* assertLoopParked(fiber, "lead should park again after progress mail")
        yield* team.updateMemberStatus(member.id, "completed")
        const result = yield* awaitWithTimeout(
          Fiber.join(fiber),
          "lead did not exit after the active teammate completed",
          "5 seconds",
        )
        expect(result.info.role).toBe("assistant")
        const mailParts = (yield* sessions.messages({ sessionID: lead.id }))
          .flatMap((message) => message.parts)
          .filter(
            (part): part is MessageV2.TextPart => part.type === "text" && part.text.includes("Progress while active"),
          )
        expect(mailParts).toHaveLength(1)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "closing the team releases a parked lead",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, team, lead, info } = yield* parkLeadOnWorker({ llm })
        yield* llm.text("done")
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* assertLoopParked(fiber, "lead should park before team closure")
        yield* setLegacyTeamProtocol(info.id)
        yield* team.shutdown({ teamID: info.id, sessionID: lead.id })
        const result = yield* awaitWithTimeout(Fiber.join(fiber), "lead did not exit after team closure", "5 seconds")
        expect(result.info.role).toBe("assistant")
        expect(Option.isNone(yield* team.getActive(lead.id))).toBe(true)
        const closed = yield* team.get(info.id)
        if (Option.isSome(closed)) expect(closed.value.status).toBe("closed")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "cancelling a parked team lead interrupts the loop before team closure releases it",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, team, lead, info } = yield* parkLeadOnWorker({ llm, memberStatus: "active" })
        const run = yield* SessionRunState.Service
        yield* llm.text("done")
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        // The loop is parked: neither exit condition holds (team active, member nonterminal), so
        // it would never finalize on its own. Only the lead cancellation can release it.
        yield* assertLoopParked(fiber, "lead should be parked before cancellation")
        yield* setLegacyTeamProtocol(info.id)
        yield* prompt.cancel(lead.id)
        const result = yield* awaitWithTimeout(
          Fiber.join(fiber),
          "lead loop did not terminate after cancellation",
          "5 seconds",
        )
        // The exit is the interrupted last assistant turn, not a barrier-permitted finalization:
        // the team is closed only because the cancel ran shutdown, and the loop produced no
        // continuation turn after parking.
        expect(result.info.role).toBe("assistant")
        expect(Option.isNone(yield* team.getActive(lead.id))).toBe(true)
        const closed = yield* team.get(info.id)
        if (Option.isSome(closed)) expect(closed.value.status).toBe("closed")
        expect((yield* team.getMembers(info.id))[0]?.status).toBe("cancelled")
        expect(yield* run.signalPark(lead.id)).toBe(false)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "daemon members never block finalization in active or idle status",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, info, member } = yield* parkLeadOnWorker({
          llm,
          lifecycle: "daemon",
          memberStatus: "active",
          daemonState: "running",
        })
        const sentinelSession = yield* sessions.create({ parentID: lead.id, title: "Sentinel" })
        const daemonIdle = yield* team.addMember({
          teamID: info.id,
          sessionID: sentinelSession.id,
          name: "sentinel",
          agentType: "build",
          rolePrompt: "Watch and report",
          lifecycle: "daemon",
          daemonState: "idle",
        })
        yield* team.updateMemberStatus(daemonIdle.id, "idle", { daemonState: "idle" })
        yield* llm.text("done")
        // No parking: both daemon members are nonterminal but never block the lead.
        const result = yield* awaitWithTimeout(
          prompt.loop({ sessionID: lead.id }),
          "lead finalization was blocked by a daemon member",
          "5 seconds",
        )
        expect(result.info.role).toBe("assistant")
        expect(Option.isSome(yield* team.getActive(lead.id))).toBe(true)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "a new user message wakes a parked lead, the lead processes it, then re-parks while the teammate stays nonterminal",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info, member } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
        })
        yield* llm.text("done")
        yield* llm.text("acknowledged")
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        // The lead parks deterministically on the nonterminal worker.
        yield* assertLoopParked(fiber, "lead should park before user input")
        // A mid-park user message is admitted via promptAsync and must wake the parked barrier
        // (SessionEvent.Prompted is published inside createUserMessage).
        const promptFiber = yield* prompt
          .prompt({
            sessionID: lead.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "new user message" }],
          })
          .pipe(Effect.forkChild)
        // The wake produces a new assistant turn that addresses the new message.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* sessions.messages({ sessionID: lead.id })
            const ack = msgs.some(
              (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text === "acknowledged"),
            )
            const prompt = msgs.some(
              (m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "new user message"),
            )
            return ack && prompt ? (true as const) : undefined
          }),
          "lead did not process the new user message",
          "5 seconds",
        )
        // The teammate is still nonterminal, so the lead parks again after processing.
        yield* assertLoopParked(fiber, "lead should re-park after processing the user message")
        // Completing the worker releases the barrier; both fibers settle.
        yield* team.updateMemberStatus(member.id, "completed")
        const result = yield* awaitWithTimeout(
          Fiber.join(fiber),
          "lead did not exit after the worker completed",
          "5 seconds",
        )
        yield* Fiber.join(promptFiber)
        expect(result.info.role).toBe("assistant")
        // Two model calls prove the lead took a turn for the mid-park user message (turn 1 was
        // the initial prompt; a stale-park bug would never produce the second turn).
        expect((yield* llm.calls) >= 2).toBe(true)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "a teammate's prompt does not wake the lead's parked barrier; only the lead's own prompt does",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info, member } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
        })
        const events = yield* EventV2Bridge.Service
        yield* llm.text("done")
        yield* llm.text("acknowledged")
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        yield* assertLoopParked(fiber, "lead should park before the teammate prompt")
        // Publish exactly what a teammate's createUserMessage would publish for ITS session. The
        // lead's barrier must filter it out by sessionID and take no additional turn.
        const publishWorkerPrompt = () =>
          events.publish(SessionEvent.Prompted, {
            sessionID: worker.id,
            messageID: SessionMessage.ID.create(),
            timestamp: DateTime.makeUnsafe(Date.now()),
            delivery: "steer",
            prompt: new Prompt({ text: "teammate followup" }),
          })
        yield* publishWorkerPrompt()
        yield* publishWorkerPrompt()
        yield* assertLoopParked(fiber, "lead should stay parked after the teammate prompt")
        // A real lead prompt (durable message + Prompted event on the lead's session) still wakes
        // the barrier and produces a new assistant turn.
        yield* user(lead.id, "lead followup")
        yield* events.publish(SessionEvent.Prompted, {
          sessionID: lead.id,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(Date.now()),
          delivery: "steer",
          prompt: new Prompt({ text: "lead followup" }),
        })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* sessions.messages({ sessionID: lead.id })
            return msgs.some(
              (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text === "acknowledged"),
            )
              ? (true as const)
              : undefined
          }),
          "lead did not process its own followup",
          "5 seconds",
        )
        yield* assertLoopParked(fiber, "lead should re-park after its own followup")
        // The teammate prompts never produced a lead turn: before the worker completes, the
        // lead's assistant history contains only the two expected responses.
        const assistantTexts = (yield* sessions.messages({ sessionID: lead.id }))
          .filter((m) => m.info.role === "assistant")
          .flatMap((m) => m.parts)
          .filter((p): p is MessageV2.TextPart => p.type === "text")
          .map((p) => p.text)
        expect(assistantTexts).toEqual(["done", "acknowledged"])
        yield* team.updateMemberStatus(member.id, "completed")
        const result = yield* awaitWithTimeout(
          Fiber.join(fiber),
          "lead did not exit after the worker completed",
          "5 seconds",
        )
        expect(result.info.role).toBe("assistant")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "team mail delivered while parked is unaffected by the Prompted subscription",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info, member } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
        })
        // Settle the worker to terminal BEFORE the lead's loop starts. The canonical completion
        // notification is committed as pending lead mail before any barrier exists, so it is
        // guaranteed to be pending when the lead enters the barrier: a terminal commit can no
        // longer land between the barrier's deliver() and exitPermitted() checks (the pre-existing
        // race that could leave the notification undelivered after the lead exited).
        yield* team.updateMemberStatus(member.id, "completed")
        // Hold turn 1 so the loop is demonstrably parked while the mail is staged. Releasing the
        // gate lets the barrier deliver the staged mail through the same durable read a parked
        // lead uses; the Prompted subscription stays registered and does not disturb delivery.
        const gate = yield* Deferred.make<void>()
        yield* llm.hold("done", deferredAsPromise(gate))
        yield* llm.text("done again")
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        // The turn is in flight once the provider dispatch hits the server (the stream is held).
        // A titled session skips the title request, so this is the turn's own dispatch.
        yield* llm.wait(1)
        yield* assertLoopParked(fiber, "lead should stay parked before mail staging")
        yield* team.sendMessage({
          teamID: info.id,
          sender: worker.id,
          recipients: [lead.id],
          body: "Mail while parked",
        })
        // Mail is claimed and delivered exactly as before the Prompted subscription existed.
        yield* Deferred.succeed(gate, void 0)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* sessions.messages({ sessionID: lead.id })
            return msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("Mail while parked")))
              ? (true as const)
              : undefined
          }),
          "mail while parked was never delivered",
          "5 seconds",
        )
        const result = yield* awaitWithTimeout(
          Fiber.join(fiber),
          "lead did not exit after the worker completed",
          "5 seconds",
        )
        expect(result.info.role).toBe("assistant")
        const mailParts = (yield* sessions.messages({ sessionID: lead.id }))
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.TextPart => part.type === "text" && part.text.includes("Mail while parked"))
        expect(mailParts).toHaveLength(1)
        expect((yield* team.getPendingMessages(lead.id, info.id)).length).toBe(0)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "a user message does not reorder pending team mail: mail is delivered before the resumed turn",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info, member } = yield* parkLeadOnWorker({
          llm,
          memberStatus: "active",
        })
        yield* llm.text("done")
        yield* llm.text("integrated")
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        yield* assertLoopParked(fiber, "lead should park before mail and user input")
        // Stage team mail AND a mid-park user message while the lead is parked.
        yield* team.sendMessage({
          teamID: info.id,
          sender: worker.id,
          recipients: [lead.id],
          body: "Ordered handoff",
        })
        const promptFiber = yield* prompt
          .prompt({
            sessionID: lead.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "mid-park user message" }],
          })
          .pipe(Effect.forkChild)
        // The mailbox rows are claimed and delivered before the user message is processed: by the
        // time the resumed turn completes, the synthetic mail message, the user message, and the
        // continuation response are all present, and the mail is delivered exactly once.
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* sessions.messages({ sessionID: lead.id })
            const mail = msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("Ordered handoff")))
            const userMsg = msgs.some(
              (m) =>
                m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.text === "mid-park user message"),
            )
            const resumed = msgs.some(
              (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text === "integrated"),
            )
            return mail && userMsg && resumed ? (true as const) : undefined
          }),
          "mail was not delivered before the resumed turn completed",
          "5 seconds",
        )
        yield* assertLoopParked(fiber, "lead should re-park while the worker stays nonterminal")
        yield* team.updateMemberStatus(member.id, "completed")
        const result = yield* awaitWithTimeout(
          Fiber.join(fiber),
          "lead did not exit after the worker completed",
          "5 seconds",
        )
        yield* Fiber.join(promptFiber)
        expect(result.info.role).toBe("assistant")
        const mailParts = (yield* sessions.messages({ sessionID: lead.id }))
          .flatMap((message) => message.parts)
          .filter((part): part is MessageV2.TextPart => part.type === "text" && part.text.includes("Ordered handoff"))
        expect(mailParts).toHaveLength(1)
        expect((yield* team.getPendingMessages(lead.id, info.id)).length).toBe(0)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "two-turn structured output discards the preliminary candidate when mail is pending",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, worker, info, member } = yield* parkLeadOnWorker({
          llm,
          leadPrompt: false,
        })
        yield* prompt.prompt({
          sessionID: lead.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "produce structured output" }],
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
            retryCount: 0,
          },
        })
        // Turn 1 produces a preliminary candidate while team mail is pending; the stream is held
        // open so the test can stage the mail before the turn completes.
        const turn1Gate = defer()
        yield* llm.push(reply().tool("StructuredOutput", { value: "first" }).wait(turn1Gate.promise))
        // Turn 2 produces the fresh candidate that must be committed.
        yield* llm.tool("StructuredOutput", { value: "second" })
        const fiber = yield* prompt.loop({ sessionID: lead.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        // Stage mail and make the teammate terminal while turn 1 is still in flight.
        yield* team.sendMessage({
          teamID: info.id,
          sender: worker.id,
          recipients: [lead.id],
          body: "Structured handoff mail",
        })
        yield* team.updateMemberStatus(member.id, "completed")
        turn1Gate.resolve(undefined)
        const result = yield* awaitWithTimeout(Fiber.join(fiber), "structured loop did not exit", "10 seconds")
        expect(result.info.role).toBe("assistant")
        // The committed structured value is the second candidate, proving the first was discarded
        // when the barrier required a continuation turn.
        const structured = result.info.role === "assistant" ? result.info.structured : undefined
        expect(structured).toEqual({ value: "second" })
        const mailParts = (yield* sessions.messages({ sessionID: lead.id }))
          .flatMap((message) => message.parts)
          .filter(
            (part): part is MessageV2.TextPart => part.type === "text" && part.text.includes("Structured handoff mail"),
          )
        expect(mailParts).toHaveLength(1)
        // Two model calls (turn 1 + turn 2) prove the loop continued after the mail handoff and
        // produced a fresh candidate. A stale-reuse bug would commit after the first turn.
        expect((yield* llm.calls) >= 2).toBe(true)
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.live(
  "a structured candidate followed by a rejected tool bypasses the finalization barrier",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const registry = yield* ToolRegistry.Service
        const sessions = yield* Session.Service
        const { read } = yield* registry.named()
        const originalRead = read.execute
        const originalUpdatePart = sessions.updatePart
        const mutableSessions = sessions as Mutable<Session.Interface>
        const candidateCompleted = yield* Deferred.make<void>()

        // Hold the failing tool until the StructuredOutput tool has completed. Its success callback
        // has captured the candidate by then, so this is one deterministic candidate-then-failure
        // turn rather than a scheduler-order assumption.
        mutableSessions.updatePart = ((part) =>
          originalUpdatePart(part).pipe(
            Effect.tap(() =>
              part.type === "tool" && part.tool === "StructuredOutput" && part.state.status === "completed"
                ? Deferred.succeed(candidateCompleted, undefined)
                : Effect.void,
            ),
          )) as Session.Interface["updatePart"]
        read.execute = (() =>
          Deferred.await(candidateCompleted).pipe(
            Effect.andThen(Effect.fail(new Question.RejectedError())),
          )) as unknown as typeof read.execute
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            read.execute = originalRead
            mutableSessions.updatePart = originalUpdatePart
          }),
        )

        const { prompt, team, lead, info, member } = yield* parkLeadOnWorker({
          llm,
          leadPrompt: false,
          memberStatus: "active",
        })
        yield* prompt.prompt({
          sessionID: lead.id,
          agent: "build",
          model: ref,
          noReply: true,
          parts: [{ type: "text", text: "produce structured output and read a file" }],
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
            retryCount: 0,
          },
        })
        yield* llm.push(
          reply()
            .tool("StructuredOutput", { value: "candidate before failure" })
            .tool("read", { filePath: "/tmp/rejected" }),
        )

        const result = yield* awaitWithTimeout(
          prompt.loop({ sessionID: lead.id }),
          "lead parked after a structured candidate was followed by a rejected tool",
          "5 seconds",
        )

        expect(yield* Deferred.isDone(candidateCompleted)).toBe(true)
        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") expect(result.info.structured).toBeUndefined()
        const failedRead = (yield* sessions.messages({ sessionID: lead.id }))
          .flatMap((message) => message.parts)
          .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.tool === "read")
        expect(failedRead).toHaveLength(1)
        expect(failedRead[0]?.state.status).toBe("error")
        expect((yield* team.getMembers(info.id)).find((candidate) => candidate.id === member.id)?.status).toBe("active")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  30_000,
)

it.instance(
  "finished-assistant finalization still exits without a team",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.text("done")
      yield* user(chat.id, "hello")
      const result = yield* awaitWithTimeout(
        prompt.loop({ sessionID: chat.id }),
        "finished-assistant loop did not exit",
      )
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)
    }),
  10_000,
)

it.instance(
  "current-processor stop (rejected tool) still exits through the funnel without a team",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const original = read.execute
      // A rejected tool marks the processor as blocked (ctx.blocked), which yields "stop" and
      // exits through the funnel barrier.
      read.execute = (() => Effect.fail(new Question.RejectedError())) as unknown as typeof read.execute
      yield* Effect.addFinalizer(() => Effect.sync(() => void (read.execute = original)))

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.tool("read", { filePath: "/tmp/nonexistent" })
      yield* user(chat.id, "hello")
      const result = yield* awaitWithTimeout(prompt.loop({ sessionID: chat.id }), "processor-stop loop did not exit")
      expect(result.info.role).toBe("assistant")
      const failedParts = (yield* sessions.messages({ sessionID: chat.id }))
        .flatMap((message) => message.parts)
        .filter((part): part is SessionV1.ToolPart => part.type === "tool" && part.state.status === "error")
      expect(failedParts.length).toBeGreaterThan(0)
    }),
  10_000,
)

it.instance(
  "a processor-stop (rejected tool) finalization bypasses the barrier even while a finite teammate is nonterminal",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const registry = yield* ToolRegistry.Service
        const { read } = yield* registry.named()
        const original = read.execute
        // A rejected tool marks the processor as blocked (ctx.blocked), which yields "stop". The
        // finalization barrier must be bypassed: the lead finalizes immediately instead of
        // parking on the nonterminal worker.
        read.execute = (() => Effect.fail(new Question.RejectedError())) as unknown as typeof read.execute
        yield* Effect.addFinalizer(() => Effect.sync(() => void (read.execute = original)))

        const { prompt, team, lead, info, member } = yield* parkLeadOnWorker({ llm, memberStatus: "active" })
        yield* llm.tool("read", { filePath: "/tmp/nonexistent" })
        const result = yield* awaitWithTimeout(
          prompt.loop({ sessionID: lead.id }),
          "lead parked on a processor-stop finalization instead of bypassing the barrier",
          "5 seconds",
        )
        expect(result.info.role).toBe("assistant")
        const members = yield* team.getMembers(info.id)
        expect(members.find((candidate) => candidate.id === member.id)?.status).toBe("active")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  15_000,
)

it.live(
  "an errored assistant finalization bypasses the barrier even while a finite teammate is nonterminal",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const { prompt, sessions, team, lead, info, member } = yield* parkLeadOnWorker({ llm, memberStatus: "active" })
        // Seed an errored assistant message (finish "error" with an error object). On the next
        // bare wake there is no mail and no newer user message, so the loop reaches the
        // finished-assistant exit: an errored finalization must break immediately without calling
        // the model and without parking on the nonterminal worker.
        const lastUser = (yield* sessions.messages({ sessionID: lead.id })).findLast((m) => m.info.role === "user")
        if (!lastUser || lastUser.info.role !== "user") throw new Error("expected lead user message")
        const errored: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: lastUser.info.id,
          sessionID: lead.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "error",
          error: new NamedError.Unknown({ message: "provider exploded" }).toObject(),
        }
        yield* sessions.updateMessage(errored)

        const result = yield* awaitWithTimeout(
          prompt.loop({ sessionID: lead.id }),
          "lead parked on an errored finalization instead of bypassing the barrier",
          "5 seconds",
        )
        expect(result.info.role).toBe("assistant")
        if (result.info.role === "assistant") expect(result.info.finish).toBe("error")
        expect((yield* llm.inputs).length).toBe(0)
        const members = yield* team.getMembers(info.id)
        expect(members.find((candidate) => candidate.id === member.id)?.status).toBe("active")
      }),
      {
        git: true,
        config: (url) => ({
          ...providerCfg(url),
          experimental: { agent_teams: true },
        }),
      },
    ),
  15_000,
)

it.instance(
  "cancel finalizes subtask tool state",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const aborted = yield* Deferred.make<void>()
      const registry = yield* ToolRegistry.Service
      const { task } = yield* registry.named()
      const original = task.execute
      task.execute = (_args, ctx) =>
        Effect.callback<never>((_resume) => {
          ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
          if (ctx.abort.aborted) succeedVoid(aborted)
          succeedVoid(ready)
          return Effect.sync(() => succeedVoid(aborted))
        })
      yield* Effect.addFinalizer(() => Effect.sync(() => void (task.execute = original)))

      const { prompt, chat } = yield* boot()
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for task tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      yield* awaitWithTimeout(Deferred.await(aborted), "timed out waiting for task tool abort", "10 seconds")

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = toolPart(taskMsg.parts)
      expect(tool?.type).toBe("tool")
      if (!tool) return

      expect(tool.state.status).not.toBe("running")
      expect(taskMsg.info.time.completed).toBeDefined()
      expect(taskMsg.info.finish).toBeDefined()
    }),
  { config: cfg },
  30_000,
)

it.instance(
  "cancel propagates from slash command subtask to child session",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
      const sessionID = tool?.state.status === "running" ? tool.state.metadata?.sessionId : undefined
      expect(typeof sessionID).toBe("string")
      if (typeof sessionID !== "string") throw new Error("missing child session id")
      const childID = SessionID.make(sessionID)
      expect((yield* status.get(childID)).type).toBe("busy")

      yield* prompt.cancel(chat.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)

      expect((yield* status.get(chat.id)).type).toBe("idle")
      expect((yield* status.get(childID)).type).toBe("idle")
    }),
  10_000,
)

raceNoLLMServer.instance(
  "spawn command launches background child without parent handoff",
  () =>
    Effect.gen(function* () {
      const { directory } = yield* TestInstance
      yield* writeConfig(directory, { ...cfg, model: "test/test-model", small_model: "test/test-model" })
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const started = yield* Deferred.make<void>()
      processorCreateStarted.push(() => succeedVoid(started))
      const chat = yield* sessions.create({ title: "Pinned" })

      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "spawn",
        arguments: "look into the cache key path",
        agent: "build",
        model: "test/test-model",
      })

      expect(result.info.role).toBe("assistant")
      if (result.info.role !== "assistant") return
      expect(result.info.finish).toBe("stop")
      const tool = completedTool(result.parts)
      if (!tool) return
      expect(tool.metadata?.providerExecuted).toBe(true)
      expect(tool.state.output).toContain("will not inject results")

      const children = yield* sessions.children(chat.id)
      expect(children).toHaveLength(1)
      const child = children[0]
      if (!child) throw new Error("spawn child not found")
      expect(child.agent).toBe("build")
      expect(child.parentID).toBe(chat.id)
      expect((yield* jobs.get(child.id))?.status).toBe("running")
      yield* awaitWithTimeout(Deferred.await(started), "spawn child did not start")

      const messages = yield* MessageV2.filterCompactedEffect(chat.id)
      expect(messages.filter((msg) => msg.info.role === "user")).toHaveLength(1)
      expect(
        messages.some((msg) =>
          msg.parts.some((part) => part.type === "text" && part.text.includes("Summarize the task tool output")),
        ),
      ).toBe(false)

      yield* jobs.cancel(child.id)
    }),
  5_000,
)

it.instance(
  "cancel with queued callers resolves all cleanly",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hello")

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)
      const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(exitA)).toBe(true)
      expect(Exit.isSuccess(exitB)).toBe(true)
      if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
        expect(exitA.value.info.id).toBe(exitB.value.info.id)
      }
    }),
  { git: true },
  10_000,
)

// Queue semantics

noLLMServer.instance("concurrent loop callers get same result", () =>
  Effect.gen(function* () {
    const { prompt, run, chat } = yield* boot()
    yield* seed(chat.id, { finish: "stop" })

    const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
      concurrency: "unbounded",
    })

    expect(a.info.id).toBe(b.info.id)
    expect(a.info.role).toBe("assistant")
    yield* run.assertNotBusy(chat.id)
  }),
)

it.instance(
  "concurrent loop callers all receive same error result",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.fail("boom")
      yield* user(chat.id, "hello")

      const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
        concurrency: "unbounded",
      })
      expect(a.info.id).toBe(b.info.id)
      expect(a.info.role).toBe("assistant")
    }),
  3_000,
)

it.instance(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.hold("first", deferredAsPromise(gate))
      yield* llm.text("second")

      const a = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "first" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)

      const id = MessageID.ascending()
      const b = yield* prompt
        .prompt({
          sessionID: chat.id,
          messageID: id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "second" }],
        })
        .pipe(Effect.forkChild)

      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some((msg) => msg.info.role === "user" && msg.info.id === id) ? true : undefined,
            ),
          ),
        "timed out waiting for second prompt to save",
      )

      yield* Deferred.succeed(gate, void 0)

      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      expect(yield* llm.calls).toBe(2)

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      const assistants = msgs.filter((msg) => msg.info.role === "assistant")
      expect(assistants).toHaveLength(2)
      const last = assistants.at(-1)
      if (!last || last.info.role !== "assistant") throw new Error("expected second assistant")
      expect(last.info.parentID).toBe(id)
      expect(last.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)

      const inputs = yield* llm.inputs
      expect(inputs).toHaveLength(2)
      expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
    }),
  3_000,
)

it.instance(
  "pause mid-turn persists a running resume intent and start resumes the turn",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const gate = yield* Deferred.make<void>()
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const control = yield* SessionControl.Service
      const chat = yield* sessions.create({ title: "Pinned" })

      yield* llm.hold("first", deferredAsPromise(gate))
      yield* llm.text("second")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          model: ref,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.forkChild)

      // The turn is in flight once the provider dispatch hit the server (the stream is held).
      // A titled session skips the title request, so this is the turn's own dispatch.
      yield* llm.wait(1)

      // Pause mid-turn. The interrupter signals the live runner and persists a durable
      // "running" resume intent for the signalled session. The held first dispatch stays
      // blocked so the interrupted attempt can never complete.
      const paused = yield* control.pause({ rootSessionID: chat.id })
      expect(paused.interruptionSignalledSessionIDs).toContain(chat.id)

      // The interrupted caller observes the typed suspended error, not a defect.
      const callerExit = yield* Fiber.await(fiber).pipe(Effect.timeout("5 seconds"))
      expect(Exit.isFailure(callerExit)).toBe(true)
      if (Exit.isFailure(callerExit)) expect(Cause.squash(callerExit.cause)).toBeInstanceOf(Runner.Suspended)

      // Start: release reports the durable intent as a resumable running ticket.
      const released = yield* control.release(chat.id)
      expect(released.resumeTickets).toEqual([{ sessionID: chat.id, generation: 1, reason: "running" }])
      expect(released.resumableSessionIDs).toEqual([chat.id])

      // Wake the runner exactly like the start handler does: the interrupted turn resumes
      // without any new user prompt and dispatches to the provider exactly once more.
      yield* prompt.wake(chat.id)
      yield* pollWithTimeout(
        sessions
          .messages({ sessionID: chat.id })
          .pipe(
            Effect.map((msgs) =>
              msgs.some(
                (msg) =>
                  msg.info.role === "assistant" && msg.parts.some((p) => p.type === "text" && p.text === "second"),
              )
                ? true
                : undefined,
            ),
          ),
        "timed out waiting for the resumed turn to complete",
      )

      const msgs = yield* sessions.messages({ sessionID: chat.id })
      expect(msgs.filter((msg) => msg.info.role === "user")).toHaveLength(1)
      const assistants = msgs.filter((msg) => msg.info.role === "assistant")
      const finalAssistant = assistants.at(-1)
      expect(finalAssistant?.parts.some((p) => p.type === "text" && p.text === "second")).toBe(true)
      // Exactly two provider dispatches for the prompt: the interrupted attempt and the resumed one.
      const dispatches = (yield* llm.inputs).filter((body) => JSON.stringify(body).includes("hello"))
      expect(dispatches).toHaveLength(2)
    }),
  10_000,
)

it.instance(
  "assertNotBusy fails with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const run = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      yield* llm.hang

      const chat = yield* sessions.create({})
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  3_000,
)

noLLMServer.instance("assertNotBusy succeeds when idle", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessions = yield* Session.Service

    const chat = yield* sessions.create({})
    const exit = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

// Shell semantics

it.instance(
  "shell rejects with BusyError when loop running",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.hang
      yield* user(chat.id, "hi")

      const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)

      const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "SessionBusyError", sessionID: chat.id })
      }

      yield* prompt.cancel(chat.id)
      yield* Fiber.await(fiber)
    }),
  3_000,
)

unixNoLLMServer(
  "shell captures stdout and stderr in completed tool output",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "printf out && printf err >&2",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("out")
      expect(tool.state.output).toContain("err")
      expect(tool.state.metadata.output).toContain("out")
      expect(tool.state.metadata.output).toContain("err")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell completes a fast command on the preferred shell",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "pwd",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("pwd")
      expect(tool.state.output).toContain(dir)
      expect(tool.state.metadata.output).toContain(dir)
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return

        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "[[ 1 -eq 1 ]] && printf configured",
        })

        const tool = completedTool(result.parts)
        if (!tool) return
        expect(tool.state.output).toContain("configured")
      }),
    ),
  { config: { ...cfg, shell: "bash" } },
  30_000,
)

unixNoLLMServer(
  "shell commands can change directory after startup",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { directory: dir } = yield* TestInstance
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    ),
  { config: cfg },
)

unixNoLLMServer(
  "shell lists files from the project directory",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const { prompt, run, chat } = yield* boot()
      yield* writeText(path.join(dir, "README.md"), "# e2e\n")

      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command ls",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.input.command).toBe("command ls")
      expect(tool.state.output).toContain("README.md")
      expect(tool.state.metadata.output).toContain("README.md")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
)

unixNoLLMServer(
  "shell captures stderr from a failing command",
  () =>
    Effect.gen(function* () {
      const { prompt, run, chat } = yield* boot()
      const result = yield* prompt.shell({
        sessionID: chat.id,
        agent: "build",
        command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
      })

      expect(result.info.role).toBe("assistant")
      const tool = completedTool(result.parts)
      if (!tool) return

      expect(tool.state.output).toContain("not found")
      expect(tool.state.metadata.output).toContain("not found")
      yield* run.assertNotBusy(chat.id)
    }),
  { config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const fiber = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
          .pipe(Effect.forkChild)

        yield* pollWithTimeout(
          Effect.gen(function* () {
            const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
            const taskMsg = msgs.find((item) => item.info.role === "assistant")
            const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
            if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return true
          }),
          "timed out waiting for running shell metadata",
        )

        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    ),
  { config: cfg },
  30_000,
)

it.instance(
  "loop waits while shell runs and starts after shell exits",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("after-shell")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const exit = yield* Fiber.await(loop)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  30_000,
)

it.instance(
  "shell completion resumes queued loop callers",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* llm.text("done")

      const sh = yield* prompt
        .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
        .pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      expect(yield* llm.calls).toBe(0)

      yield* Fiber.await(sh)
      const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

      expect(Exit.isSuccess(ea)).toBe(true)
      expect(Exit.isSuccess(eb)).toBe(true)
      if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
        expect(ea.value.info.id).toBe(eb.value.info.id)
        expect(ea.value.info.role).toBe("assistant")
      }
      expect(yield* llm.calls).toBe(1)
    }),
  { git: true },
  30_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        if (!(yield* hasBash)) return
        const { llm } = yield* useServerConfig((url) => ({
          ...providerCfg(url),
          shell: "bash",
          command: {
            probe: {
              template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
            },
          },
        }))

        const { prompt, chat } = yield* boot()
        yield* llm.text("done")

        const result = yield* prompt.command({
          sessionID: chat.id,
          command: "probe",
          arguments: "",
        })

        expect(result.info.role).toBe("assistant")
        const inputs = yield* llm.inputs
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
      }),
    ),
  30_000,
)

it.instance(
  "local:fusion command renders prompt outside json input",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const { prompt, chat } = yield* boot()
      yield* llm.text("done")

      const result = yield* prompt.command({
        sessionID: chat.id,
        command: "local:fusion",
        arguments: "research-panel Review key=value behavior",
      })

      expect(result.info.role).toBe("assistant")
      const inputs = yield* llm.inputs
      const messages = JSON.stringify(inputs.at(-1)?.messages)
      expect(messages).toContain("`config`: `research-panel`")
      expect(messages).toContain("The current request provided in `Review key=value behavior`")
      expect(messages).toContain("`prompt`: the combined conversation context and current request described above")
      expect(messages).toContain("Do not pass `branches`, `judge`, or `synthesizer` when `config` is set.")
      expect(messages).not.toContain("```json")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        yield* prompt.cancel(chat.id)

        const status = yield* SessionStatus.Service
        expect((yield* status.get(chat.id)).type).toBe("idle")
        const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(busy)).toBe(true)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const { directory: dir } = yield* TestInstance
        const afs = yield* FSUtil.Service
        const ready = path.join(dir, ".trap-ready")

        const sh = yield* prompt
          .shell({
            sessionID: chat.id,
            agent: "build",
            // Touch marker AFTER trap installs so the test waits for the actual
            // ignore-TERM state before cancelling; otherwise SIGTERM can arrive
            // before `trap` runs and the escalation path is never exercised.
            command: `trap '' TERM; touch "${ready}"; sleep 30`,
          })
          .pipe(Effect.forkChild)

        yield* Effect.gen(function* () {
          while (!(yield* afs.existsSafe(ready))) {
            yield* Effect.sleep(Duration.millis(10))
          }
        }).pipe(Effect.timeout(Duration.seconds(5)))

        yield* prompt.cancel(chat.id)

        const exit = yield* Fiber.await(sh)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          const tool = completedTool(exit.value.parts)
          if (tool) {
            expect(tool.state.output).toContain("User aborted the command")
          }
        }
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    Effect.gen(function* () {
      const { dir, llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Interrupted bash truncation",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })

      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "run bash" }],
      })

      yield* llm.tool("bash", {
        command:
          'i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; printf truncation-ready; sleep 30',
        description: "Print many lines",
        timeout: 30_000,
        workdir: path.resolve(dir),
      })

      const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* llm.wait(1)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const assistant = msgs.findLast((item) => item.info.role === "assistant")
          const tool = assistant ? toolPart(assistant.parts) : undefined
          if (tool?.state.status === "running" && tool.state.metadata?.output.includes("truncation-ready")) return true
        }),
        "timed out waiting for truncated shell output",
      )
      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(run)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isFailure(exit)) return

      const tool = completedTool(exit.value.parts)
      if (!tool) return

      expect(tool.state.metadata.truncated).toBe(true)
      expect(typeof tool.state.metadata.outputPath).toBe("string")
      expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
      expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
      expect(tool.state.output).not.toContain("Tool execution aborted")
    }),
  { git: true },
  30_000,
)

unixNoLLMServer(
  "cancel interrupts loop queued behind shell",
  () =>
    Effect.gen(function* () {
      const { prompt, chat } = yield* boot()

      const sh = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "sleep 30" }).pipe(Effect.forkChild)
      yield* waitForBusy(chat.id)

      const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
      yield* Effect.sleep(50)

      yield* prompt.cancel(chat.id)

      const exit = yield* Fiber.await(loop)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        const tool = completedTool(exit.value.parts)
        expect(tool?.state.output).toContain("User aborted the command")
      }

      yield* Fiber.await(sh)
    }),
  { git: true, config: cfg },
  30_000,
)

unixNoLLMServer(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()

        const a = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
          .pipe(Effect.forkChild)
        yield* waitForBusy(chat.id)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(a)
      }),
    ),
  { git: true, config: cfg },
  30_000,
)

unix("shell captures stdout and stderr in completed tool output", () =>
  provideTmpdirInstance(
    (_dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf out && printf err >&2",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("out")
        expect(tool.state.output).toContain("err")
        expect(tool.state.metadata.output).toContain("out")
        expect(tool.state.metadata.output).toContain("err")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell completes a fast command on the preferred shell",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { prompt, run, chat } = yield* boot()
          const result = yield* prompt.shell({
            sessionID: chat.id,
            agent: "build",
            command: "pwd",
          })

          expect(result.info.role).toBe("assistant")
          const tool = completedTool(result.parts)
          if (!tool) return

          expect(tool.state.input.command).toBe("pwd")
          expect(tool.state.output).toContain(dir)
          expect(tool.state.metadata.output).toContain(dir)
          yield* run.assertNotBusy(chat.id)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell uses configured shell over env shell",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            if (!Bun.which("bash")) return

            const { prompt, chat } = yield* boot()
            const result = yield* prompt.shell({
              sessionID: chat.id,
              agent: "build",
              command: "[[ 1 -eq 1 ]] && printf configured",
            })

            const tool = completedTool(result.parts)
            if (!tool) return
            expect(tool.state.output).toContain("configured")
          }),
        { git: true, config: { ...cfg, shell: "bash" } },
      ),
    ),
  30_000,
)

unix("shell commands can change directory after startup", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        const parent = path.dirname(dir)
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "cd .. && pwd",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain(parent)
        expect(tool.state.metadata.output).toContain(parent)
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix("shell lists files from the project directory", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, run, chat } = yield* boot()
        yield* Effect.promise(() => Bun.write(path.join(dir, "README.md"), "# e2e\n"))

        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "command ls",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.input.command).toBe("command ls")
        expect(tool.state.output).toContain("README.md")
        expect(tool.state.metadata.output).toContain("README.md")
        yield* run.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

unix(
  "shell captures stderr from a failing command",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const { prompt, run, chat } = yield* boot()
          const result = yield* prompt.shell({
            sessionID: chat.id,
            agent: "build",
            command: "command -v __nonexistent_cmd_e2e__ || echo 'not found' >&2; exit 1",
          })

          expect(result.info.role).toBe("assistant")
          const tool = completedTool(result.parts)
          if (!tool) return

          expect(tool.state.output).toContain("not found")
          expect(tool.state.metadata.output).toContain("not found")
          yield* run.assertNotBusy(chat.id)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const fiber = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
              .pipe(Effect.forkChild)

            yield* pollWithTimeout(
              Effect.gen(function* () {
                const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
                const taskMsg = msgs.find((item) => item.info.role === "assistant")
                const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
                return tool?.state.status === "running" && tool.state.metadata?.output.includes("first")
                  ? true
                  : undefined
              }),
              "timed out waiting for running shell metadata",
            )

            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

it.live(
  "loop waits while shell runs and starts after shell exits",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("after-shell")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const exit = yield* Fiber.await(loop)

        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

it.live(
  "shell completion resumes queued loop callers",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
          expect(ea.value.info.id).toBe(eb.value.info.id)
          expect(ea.value.info.role).toBe("assistant")
        }
        expect(yield* llm.calls).toBe(1)
      }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

unix(
  "command ! expansion uses configured shell over env shell",
  () =>
    withSh(() =>
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            if (!Bun.which("bash")) return

            const { prompt, chat } = yield* boot()
            yield* llm.text("done")

            const result = yield* prompt.command({
              sessionID: chat.id,
              command: "probe",
              arguments: "",
            })

            expect(result.info.role).toBe("assistant")
            const inputs = yield* llm.inputs
            expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("configured")
          }),
        {
          git: true,
          config: (url) => ({
            ...providerCfg(url),
            shell: "bash",
            command: {
              probe: {
                template: "Probe: !`[[ 1 -eq 1 ]] && printf configured`",
              },
            },
          }),
        },
      ),
    ),
  30_000,
)

unix(
  "cancel aborts tracked command substitution",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const done = path.join(dir, "substitution-finished")
            yield* writeConfig(dir, {
              ...cfg,
              command: {
                slow: {
                  template: `Result: !\`sleep 30; touch "${done}"; printf late\``,
                },
              },
            })
            const { prompt, chat } = yield* boot()
            const command = yield* prompt
              .command({ sessionID: chat.id, command: "slow", arguments: "", agent: "build" })
              .pipe(Effect.forkChild)
            yield* waitForBusy(chat.id)

            yield* prompt.cancel(chat.id)

            expect(Exit.isFailure(yield* Fiber.await(command))).toBe(true)
            yield* Effect.sleep("100 millis")
            const fs = yield* FSUtil.Service
            expect(yield* fs.existsSafe(done)).toBe(false)
          }),
        { git: true, config: cfg },
      ),
    ),
  10_000,
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, run, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const status = yield* SessionStatus.Service
            expect((yield* status.get(chat.id)).type).toBe("idle")
            const busy = yield* run.assertNotBusy(chat.id).pipe(Effect.exit)
            expect(Exit.isSuccess(busy)).toBe(true)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (_dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "trap '' TERM; sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel finalizes interrupted bash tool output through normal truncation",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const fs = yield* FSUtil.Service
          const ready = path.join(dir, "truncated-output-ready")
          const chat = yield* sessions.create({
            title: "Interrupted bash truncation",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "run bash" }],
          })

          yield* llm.tool("bash", {
            command: `i=0; while [ "$i" -lt 4000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx %05d\\n" "$i"; i=$((i + 1)); done; touch "${ready}"; sleep 30`,
            description: "Print many lines",
            timeout: 30_000,
            workdir: path.resolve(dir),
          })

          const run = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* llm.wait(1)
          yield* pollWithTimeout(
            fs.existsSafe(ready).pipe(Effect.map((exists) => (exists ? (true as const) : undefined))),
            "shell output never reached truncation marker",
          )
          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(run)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isFailure(exit)) return

          const tool = completedTool(exit.value.parts)
          if (!tool) return

          expect(tool.state.metadata.truncated).toBe(true)
          expect(typeof tool.state.metadata.outputPath).toBe("string")
          expect(tool.state.output).toMatch(/\.\.\.output truncated\.\.\./)
          expect(tool.state.output).toMatch(/Full output saved to:\s+\S+/)
          expect(tool.state.output).not.toContain("Tool execution aborted")
        }),
      { git: true, config: providerCfg },
    ),
  30_000,
)

unix(
  "cancel interrupts loop queued behind shell",
  () =>
    provideTmpdirInstance(
      (_dir) =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(loop)
          expect(Exit.isSuccess(exit)).toBe(true)
          if (Exit.isSuccess(exit)) {
            const tool = completedTool(exit.value.parts)
            expect(tool?.state.output).toContain("User aborted the command")
          }

          yield* Fiber.await(sh)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

// Abort signal propagation tests for inline tool execution

function hangUntilAborted(tool: { execute: (...args: any[]) => any }) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const original = tool.execute
    tool.execute = (_args: any, ctx: any) => {
      ctx.abort.addEventListener("abort", () => succeedVoid(aborted), { once: true })
      if (ctx.abort.aborted) succeedVoid(aborted)
      succeedVoid(ready)
      return Effect.callback<never>(() => Effect.sync(() => succeedVoid(aborted)))
    }
    const restore = Effect.addFinalizer(() => Effect.sync(() => void (tool.execute = original)))
    return { ready, aborted, restore }
  })
}

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (text/plain)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const testFile = path.join(dir, "test.txt")
      yield* writeText(testFile, "hello world")

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${testFile}`, filename: "test.txt", mime: "text/plain" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

noLLMServer.instance(
  "interrupt propagates abort signal to read tool via file part (directory)",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const registry = yield* ToolRegistry.Service
      const { read } = yield* registry.named()
      const { ready, restore } = yield* hangUntilAborted(read)
      yield* restore

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Abort Test" })

      const fiber = yield* prompt
        .prompt({
          sessionID: chat.id,
          agent: "build",
          parts: [
            { type: "text", text: "read this" },
            { type: "file", url: `file://${dir}`, filename: "dir", mime: "application/x-directory" },
          ],
        })
        .pipe(Effect.forkChild)

      yield* awaitWithTimeout(Deferred.await(ready), "timed out waiting for read tool to start", "10 seconds")
      yield* prompt.cancel(chat.id)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  { config: cfg },
  30_000,
)

// Missing file handling

noLLMServer.instance(
  "does not fail the prompt when a file part is missing",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "does-not-exist.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          { type: "text", text: "please review @does-not-exist.ts" },
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "does-not-exist.ts",
          },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")
      const hasFailure = msg.parts.some(
        (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
      )
      expect(hasFailure).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps stored part order stable when file resolution is async",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const missing = path.join(dir, "still-missing.ts")
      const msg = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [
          {
            type: "file",
            mime: "text/plain",
            url: `file://${missing}`,
            filename: "still-missing.ts",
          },
          { type: "text", text: "after-file" },
        ],
      })

      if (msg.info.role !== "user") throw new Error("expected user message")

      const stored = yield* MessageV2.get({
        sessionID: session.id,
        messageID: msg.info.id,
      })
      const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

      expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
      expect(text[1]?.includes("Read tool failed to read")).toBe(true)
      expect(text[2]).toBe("after-file")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "keeps MCP resource parts exact below the aggregate bound",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const mcpService = yield* MCP.Service
      const truncate = yield* Truncate.Service
      const session = yield* sessions.create({})
      const mutableMcp = mcpService as Mutable<MCP.Interface>
      const mutableTruncate = truncate as Mutable<Truncate.Interface>
      const originalReadResource = mcpService.readResource
      const originalOutputStrict = truncate.outputStrict
      const readsReady = yield* Deferred.make<void>()
      const renderCalls: Array<{
        text: string
        options: Truncate.StrictOptions
        agent: AgentSvc.Info | undefined
      }> = []
      let activeReads = 0

      const readResource: MCP.Interface["readResource"] = (_clientName, uri) =>
        Effect.gen(function* () {
          activeReads++
          if (activeReads === 2) yield* Deferred.succeed(readsReady, void 0)
          yield* awaitWithTimeout(Deferred.await(readsReady), "MCP resource reads did not run concurrently").pipe(
            Effect.orDie,
          )
          return uri === "mcp://first"
            ? {
                contents: [
                  { uri, text: "first text" },
                  { uri, blob: "AA==", mimeType: "application/octet-stream" },
                ],
              }
            : { contents: [{ uri, text: "second text" }] }
        })
      mutableMcp.readResource = readResource
      mutableTruncate.outputStrict = ((text, options, agent) => {
        renderCalls.push({ text, options, agent })
        return originalOutputStrict(text, options, agent)
      }) as Truncate.Interface["outputStrict"]
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          mutableMcp.readResource = originalReadResource
          mutableTruncate.outputStrict = originalOutputStrict
        }),
      )

      const first = {
        type: "file" as const,
        mime: "text/plain",
        url: "mcp://first",
        filename: "first.txt",
        source: {
          type: "resource" as const,
          clientName: "server-a",
          uri: "mcp://first",
          text: { value: "@first", start: 0, end: 6 },
        },
      }
      const second = {
        type: "file" as const,
        mime: "text/markdown",
        url: "mcp://second",
        filename: "second.md",
        source: {
          type: "resource" as const,
          clientName: "server-b",
          uri: "mcp://second",
          text: { value: "@second", start: 20, end: 27 },
        },
      }
      const message = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [first, { type: "text", text: "between resources" }, second],
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })

      expect(renderCalls).toHaveLength(1)
      expect(renderCalls[0].text).toBe(
        "Reading MCP resource: first.txt (mcp://first)" +
          "first text" +
          "[Binary content: application/octet-stream]" +
          "Reading MCP resource: second.md (mcp://second)" +
          "second text",
      )
      expect(renderCalls[0].options).toEqual({ maxLines: Truncate.MAX_LINES, maxBytes: Truncate.MAX_BYTES })
      expect(renderCalls[0].agent?.name).toBe("build")
      expect(
        stored.parts.map((part) =>
          part.type === "text"
            ? { type: part.type, text: part.text, synthetic: part.synthetic }
            : part.type === "file"
              ? { type: part.type, mime: part.mime, url: part.url, filename: part.filename, source: part.source }
              : { type: part.type },
        ),
      ).toEqual([
        { type: "text", text: "Reading MCP resource: first.txt (mcp://first)", synthetic: true },
        { type: "text", text: "first text", synthetic: true },
        { type: "text", text: "[Binary content: application/octet-stream]", synthetic: true },
        first,
        { type: "text", text: "between resources", synthetic: undefined },
        { type: "text", text: "Reading MCP resource: second.md (mcp://second)", synthetic: true },
        { type: "text", text: "second text", synthetic: true },
        second,
      ])

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "bounds all MCP resource text once and preserves managed resource files",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const mcpService = yield* MCP.Service
      const truncate = yield* Truncate.Service
      const session = yield* sessions.create({})
      const mutableMcp = mcpService as Mutable<MCP.Interface>
      const mutableTruncate = truncate as Mutable<Truncate.Interface>
      const originalReadResource = mcpService.readResource
      const originalOutputStrict = truncate.outputStrict
      const calls: Array<{ text: string; agent: AgentSvc.Info | undefined }> = []
      const large = `large-start-${"界".repeat(Truncate.MAX_BYTES)}-large-end`
      const contents = new Map([
        ["mcp://early", "early body"],
        ["mcp://large", large],
        ["mcp://omitted", "omitted body"],
      ])

      const readResource: MCP.Interface["readResource"] = (_clientName, uri) =>
        Effect.succeed({ contents: [{ uri, text: contents.get(uri) ?? "" }] })
      mutableMcp.readResource = readResource
      mutableTruncate.outputStrict = ((text, options, agent) => {
        calls.push({ text, agent })
        return originalOutputStrict(text, options, agent)
      }) as Truncate.Interface["outputStrict"]
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          mutableMcp.readResource = originalReadResource
          mutableTruncate.outputStrict = originalOutputStrict
        }),
      )

      const resource = (name: string, uri: string, start: number) => ({
        type: "file" as const,
        mime: "text/plain",
        url: uri,
        filename: `${name}.txt`,
        source: {
          type: "resource" as const,
          clientName: "server",
          uri,
          text: { value: `@${name}`, start, end: start + name.length + 1 },
        },
      })
      const early = resource("early", "mcp://early", 0)
      const largeResource = resource("large", "mcp://large", 10)
      const omitted = resource("omitted", "mcp://omitted", 20)
      const expected =
        "Reading MCP resource: early.txt (mcp://early)" +
        "early body" +
        "Reading MCP resource: large.txt (mcp://large)" +
        large +
        "Reading MCP resource: omitted.txt (mcp://omitted)" +
        "omitted body"

      const message = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [early, { type: "text", text: "interleaved" }, largeResource, omitted],
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const synthetic = stored.parts.filter(
        (part): part is SessionV1.TextPart => part.type === "text" && part.synthetic === true,
      )
      const inserted = synthetic.map((part) => part.text).join("")
      const files = stored.parts.filter((part): part is SessionV1.FilePart => part.type === "file")

      expect(calls).toHaveLength(1)
      expect(calls[0].text).toBe(expected)
      expect(calls[0].agent?.name).toBe("build")
      expect(Buffer.byteLength(inserted, "utf-8")).toBeLessThanOrEqual(Truncate.MAX_BYTES)
      expect(inserted.split("\n").length).toBeLessThanOrEqual(Truncate.MAX_LINES)
      expect(inserted.match(/Full output saved to:/g)).toHaveLength(1)
      expect(inserted).toContain("Use the Task tool")
      expect(synthetic[0].text).toBe("Reading MCP resource: early.txt (mcp://early)")
      expect(synthetic[1].text).toBe("early body")
      expect(files.map(({ mime, url, filename, source }) => ({ mime, url, filename, source }))).toEqual(
        [early, largeResource, omitted].map(({ type: _type, ...part }) => part),
      )
      const fileIndexes = files.map((file) => stored.parts.indexOf(file))
      const interleaved = stored.parts.findIndex((part) => part.type === "text" && part.text === "interleaved")
      expect(fileIndexes[0]).toBeLessThan(interleaved)
      expect(interleaved).toBeLessThan(fileIndexes[1])
      expect(fileIndexes[1]).toBeLessThan(fileIndexes[2])

      const outputPath = inserted.match(/Full output saved to: ([^\n]+)/)?.[1]
      expect(typeof outputPath).toBe("string")
      if (!outputPath) throw new Error("expected managed MCP aggregate path")
      const artifact = yield* Effect.promise(() => Bun.file(outputPath).text())
      expect(artifact).toBe(expected)
      expect(artifact).toContain("Reading MCP resource: omitted.txt (mcp://omitted)")
      expect(artifact).toContain("omitted body")

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "retries MCP resource aggregation after one render failure",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const mcpService = yield* MCP.Service
      const truncate = yield* Truncate.Service
      const session = yield* sessions.create({})
      const mutableMcp = mcpService as Mutable<MCP.Interface>
      const mutableTruncate = truncate as Mutable<Truncate.Interface>
      const originalReadResource = mcpService.readResource
      const originalOutputStrict = truncate.outputStrict
      let reads = 0
      let renders = 0

      const readResource: MCP.Interface["readResource"] = (_clientName, uri) => {
        reads++
        return Effect.succeed({ contents: [{ uri, text: "retry body" }] })
      }
      mutableMcp.readResource = readResource
      mutableTruncate.outputStrict = ((...args) => {
        renders++
        return renders === 1
          ? Effect.die(new Error("simulated MCP aggregate render failure"))
          : originalOutputStrict(...args)
      }) as Truncate.Interface["outputStrict"]
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          mutableMcp.readResource = originalReadResource
          mutableTruncate.outputStrict = originalOutputStrict
        }),
      )

      const input = {
        sessionID: session.id,
        agent: "build",
        noReply: true as const,
        parts: [
          {
            type: "file" as const,
            mime: "text/plain",
            url: "mcp://retry",
            filename: "retry.txt",
            source: {
              type: "resource" as const,
              clientName: "server",
              uri: "mcp://retry",
              text: { value: "@retry", start: 0, end: 6 },
            },
          },
        ],
      }

      const failed = yield* prompt.prompt(input).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)

      const message = yield* prompt.prompt(input)
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      expect(renders).toBe(2)
      expect(reads).toBe(2)
      expect(stored.parts.some((part) => part.type === "text" && part.text === "retry body")).toBe(true)
      expect(stored.parts.some((part) => part.type === "file" && part.url === "mcp://retry")).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { config: cfg },
)

noLLMServer.instance(
  "resolves configured reference mentions to one root directory attachment",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(path.join(docs, "guide"))
      yield* ensureDir(path.join(dir, "docs"))
      yield* writeText(path.join(docs, "README.md"), "reference readme")
      yield* writeText(path.join(docs, "guide", "intro.md"), "reference intro")
      yield* writeText(path.join(dir, "docs", "README.md"), "workspace readme")

      const prompt = yield* SessionPrompt.Service
      const parts = yield* prompt.resolvePromptParts(
        "Use @docs and @docs/README.md and @docs/guide and @docs/missing.md and @docs/README.md and @build",
      )
      const files = parts.filter((part): part is SessionV1.FilePartInput => part.type === "file")
      const agents = parts.filter((part): part is SessionV1.AgentPartInput => part.type === "agent")
      const text = parts.find((part): part is SessionV1.TextPartInput => part.type === "text" && !part.synthetic)

      expect(text?.text).toContain("@docs")
      expect(files).toHaveLength(1)
      expect(files[0]).toMatchObject({
        filename: "docs",
        mime: "application/x-directory",
        source: { type: "file", path: "docs", text: { value: "@docs" } },
      })
      expect(fileURLToPath(files[0].url)).toBe(docs)
      expect(agents.map((agent) => agent.name)).toEqual(["build"])
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

noLLMServer.instance(
  "stores raw reference mentions alongside directory attachments",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      const docs = path.join(dir, "external-docs")
      yield* ensureDir(docs)

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const message = yield* prompt.prompt({
        sessionID: session.id,
        noReply: true,
        parts: [{ type: "text", text: "Use @docs for context" }],
      })

      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const synthetic = stored.parts.filter(
        (part): part is SessionV1.TextPart => part.type === "text" && part.synthetic === true,
      )
      const files = stored.parts.filter((part): part is SessionV1.FilePart => part.type === "file")
      const text = stored.parts.find((part): part is SessionV1.TextPart => part.type === "text" && !part.synthetic)

      expect(text?.text).toBe("Use @docs for context")
      expect(synthetic.some((part) => part.text.includes(JSON.stringify({ filePath: docs })))).toBe(true)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatchObject({
        filename: "docs",
        mime: "application/x-directory",
        source: { type: "file", path: "docs", text: { value: "@docs", start: 4, end: 9 } },
      })
      expect(fileURLToPath(files[0].url)).toBe(docs)

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      reference: {
        docs: "./external-docs",
      },
    },
  },
)

// Special characters in filenames

noLLMServer.instance(
  "handles filenames with # character",
  () =>
    Effect.gen(function* () {
      const { directory: dir } = yield* TestInstance
      yield* writeText(path.join(dir, "file#name.txt"), "special content\n")

      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const parts = yield* prompt.resolvePromptParts("Read @file#name.txt")
      const fileParts = parts.filter((part) => part.type === "file")

      expect(fileParts.length).toBe(1)
      expect(fileParts[0].filename).toBe("file#name.txt")
      expect(fileParts[0].url).toContain("%23")

      const decodedPath = fileURLToPath(fileParts[0].url)
      expect(decodedPath).toBe(path.join(dir, "file#name.txt"))

      const message = yield* prompt.prompt({
        sessionID: session.id,
        parts,
        noReply: true,
      })
      const stored = yield* MessageV2.get({ sessionID: session.id, messageID: message.info.id })
      const textParts = stored.parts.filter((part) => part.type === "text")
      const hasContent = textParts.some((part) => part.text.includes("special content"))
      expect(hasContent).toBe(true)

      yield* sessions.remove(session.id)
    }),
  { git: true, config: cfg },
)

// Regression: empty assistant turn loop

it.instance("does not loop empty assistant turns for a simple reply", () =>
  Effect.gen(function* () {
    const { llm } = yield* useServerConfig(providerCfg)
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "Prompt regression" })

    yield* llm.text("packages/opencode/src/session/processor.ts")

    const result = yield* prompt.prompt({
      sessionID: session.id,
      agent: "build",
      parts: [{ type: "text", text: "Where is SessionProcessor?" }],
    })

    expect(result.info.role).toBe("assistant")
    expect(result.parts.some((part) => part.type === "text" && part.text.includes("processor.ts"))).toBe(true)

    const msgs = yield* sessions.messages({ sessionID: session.id })
    expect(msgs.filter((msg) => msg.info.role === "assistant")).toHaveLength(1)
    expect(yield* llm.calls).toBe(1)
  }),
)

it.instance(
  "records aborted errors when prompt is cancelled mid-stream",
  () =>
    Effect.gen(function* () {
      const { llm } = yield* useServerConfig(providerCfg)
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Prompt cancel regression" })

      yield* llm.hang

      const fiber = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "build",
          parts: [{ type: "text", text: "Cancel me" }],
        })
        .pipe(Effect.forkChild)

      yield* llm.wait(1)
      yield* prompt.cancel(session.id)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.info.role).toBe("assistant")
        if (exit.value.info.role === "assistant") {
          expect(exit.value.info.error?.name).toBe("MessageAbortedError")
        }
      }

      const msgs = yield* sessions.messages({ sessionID: session.id })
      const last = msgs.findLast((msg) => msg.info.role === "assistant")
      expect(last?.info.role).toBe("assistant")
      if (last?.info.role === "assistant") {
        expect(last.info.error?.name).toBe("MessageAbortedError")
      }
    }),
  3_000,
)

// Agent variant

noLLMServer.instance(
  "applies agent variant only when using agent model",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})

      const other = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("opencode"), modelID: ModelV2.ID.make("kimi-k2.5-free") },
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      if (other.info.role !== "user") throw new Error("expected user message")
      expect(other.info.model.variant).toBeUndefined()

      const match = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello again" }],
      })
      if (match.info.role !== "user") throw new Error("expected user message")
      expect(match.info.model).toEqual({
        providerID: ProviderV2.ID.make("test"),
        modelID: ModelV2.ID.make("test-model"),
        variant: "xhigh",
      })
      expect(match.info.model.variant).toBe("xhigh")

      const override = yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        variant: "high",
        parts: [{ type: "text", text: "hello third" }],
      })
      if (override.info.role !== "user") throw new Error("expected user message")
      expect(override.info.model.variant).toBe("high")

      yield* sessions.remove(session.id)
    }),
  {
    config: {
      ...cfg,
      provider: {
        ...cfg.provider,
        test: {
          ...cfg.provider.test,
          models: {
            "test-model": {
              ...cfg.provider.test.models["test-model"],
              variants: { xhigh: {}, high: {} },
            },
          },
        },
      },
      agent: {
        build: {
          model: "test/test-model",
          variant: "xhigh",
        },
      },
    },
  },
)

// Agent / command resolution errors

noLLMServer.instance(
  "unknown agent throws typed error",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Agent not found: "nonexistent-agent-xyz"')
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown agent error includes available agent names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .prompt({
          sessionID: session.id,
          agent: "nonexistent-agent-xyz",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain("build")
        }
      }
    }),
  30_000,
)

noLLMServer.instance(
  "unknown command throws typed error with available names",
  () =>
    Effect.gen(function* () {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({})
      const exit = yield* prompt
        .command({
          sessionID: session.id,
          command: "nonexistent-command-xyz",
          arguments: "",
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err).not.toBeInstanceOf(TypeError)
        expect(NamedError.Unknown.isInstance(err)).toBe(true)
        if (NamedError.Unknown.isInstance(err)) {
          expect(err.data.message).toContain('Command not found: "nonexistent-command-xyz"')
          expect(err.data.message).toContain("init")
        }
      }
    }),
  30_000,
)
