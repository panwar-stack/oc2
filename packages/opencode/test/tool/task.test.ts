import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Database } from "@oc2-ai/core/database/database"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { ModelV2 } from "@oc2-ai/core/model"
import { MessageV2 } from "@/session/message-v2"
import { SessionControl } from "@oc2-ai/core/session/control"
import { SessionTable } from "@oc2-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { LifecycleReconciler } from "@/session/lifecycle-reconciler"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    EventV2Bridge.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Database.defaultLayer,
    RuntimeFlags.layer(flags),
    SessionControl.defaultLayer,
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
    wake: (sessionID) =>
      Effect.sync(() => reply({ sessionID, agent: "general", model: ref, parts: [] }, opts?.text ?? "done")),
    run: (sessionID) =>
      Effect.sync(() => reply({ sessionID, agent: "general", model: ref, parts: [] }, opts?.text ?? "done")),
  }
}

// The reconciler injects the parent notification with a normal ascending message ID, so the
// notification is identified by its synthetic rendered task output instead of an ID prefix.
function isBackgroundNotification(message: SessionV1.WithParts) {
  return (
    message.info.role === "user" &&
    message.parts.some((part) => part.type === "text" && part.synthetic === true && part.text.startsWith("<task id="))
  )
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)
        expect(first).toContain("subagent_type")
        expect(first).toContain("When NOT to use the Task tool")
        expect(first).toContain("task_id")
        expect(first).toContain("do not duplicate")
        expect(first).toContain("Trust agent results")
        expect(first).toContain("specify exactly what information the agent should return")
        expect(first).toContain("whether you expect it to write code or just to do research")
        expect(first).toContain("Available agent types and the tools they have access to:")
        expect(first).not.toContain("code-reviewer")
        expect(first).not.toContain("greeting-responder")
        expect(first).not.toContain("Please write a function that checks if a number is prime")
        expect(first).not.toContain("function isPrime")
        expect(first).not.toContain('user: "Hello"')

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
        wake: (sessionID) => Effect.sync(() => reply({ sessionID, agent: "general", model: ref, parts: [] }, "looped")),
        run: (sessionID) => Effect.sync(() => reply({ sessionID, agent: "general", model: ref, parts: [] }, "looped")),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        yield* sessions.setPermission({
          sessionID: chat.id,
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "question",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "team_create",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "team_spawn",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "allow",
          },
          {
            permission: "read",
            pattern: "*",
            action: "allow",
          },
        ])
        expect(seen?.tools).toEqual({
          todowrite: false,
          team_create: false,
          team_spawn: false,
          local_fusion: false,
          bash: false,
          read: false,
          question: false,
        })
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read", "question"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("internal background context skips public flag and parent injection", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let parentPrompts = 0

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            background: true,
            notify: false,
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) => {
                if (input.sessionID === chat.id) {
                  parentPrompts++
                  return Effect.succeed(reply(input, "injected"))
                }
                return Effect.succeed(reply(input, "background done"))
              },
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("will not inject results")
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(parentPrompts).toBe(0)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const woken = yield* Deferred.make<SessionID>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
        wake: (sessionID) =>
          Deferred.succeed(woken, sessionID).pipe(
            Effect.as(reply({ sessionID, agent: "general", model: ref, parts: [] }, "background done")),
          ),
        run: (sessionID) =>
          Deferred.succeed(woken, sessionID).pipe(
            Effect.as(reply({ sessionID, agent: "general", model: ref, parts: [] }, "background done")),
          ),
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect(yield* Deferred.await(woken)).toBe(chat.id)
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const woken = defer<SessionID>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
        wake: (sessionID) => {
          woken.resolve(sessionID)
          return Effect.succeed(reply({ sessionID, agent: "general", model: ref, parts: [] }, "done"))
        },
        run: (sessionID) => {
          woken.resolve(sessionID)
          return Effect.succeed(reply({ sessionID, agent: "general", model: ref, parts: [] }, "done"))
        },
      }
      const context = {
        sessionID: chat.id,
        messageID: assistant.id,
        agent: "build",
        abort: new AbortController().signal,
        extra: { promptOps },
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      expect(yield* Effect.promise(() => woken.promise)).toBe(chat.id)
      const notification = (yield* MessageV2.stream(chat.id)).find((message) =>
        message.parts.some((part) => part.type === "text" && part.text.includes("second done")),
      )
      expect(notification?.info.role).toBe("user")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("keeps paused background completion durable and delivers it exactly once after release", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const lifecycle = yield* LifecycleReconciler.Service
      const control = yield* SessionControl.Service
      const database = yield* Database.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let wakes = 0
      const promptOps: TaskPromptOps = {
        ...stubOps({ text: "restart-safe result" }),
        wake: (sessionID) =>
          Effect.sync(() => {
            wakes++
            return reply({ sessionID, agent: "general", model: ref, parts: [] }, "woke")
          }),
        run: (sessionID) =>
          Effect.sync(() => {
            wakes++
            return reply({ sessionID, agent: "general", model: ref, parts: [] }, "woke")
          }),
      }

      yield* control.pause({ rootSessionID: chat.id })
      const result = yield* def.execute(
        {
          description: "inspect restart",
          prompt: "produce a durable result",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      yield* Effect.sleep("20 millis")

      const paused = yield* database.db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, result.metadata.sessionId))
        .get()
        .pipe(Effect.orDie)
      expect(paused?.metadata?.lifecycleReconciler as { state?: string; output?: string } | undefined).toMatchObject({
        state: "completed",
        output: "restart-safe result",
      })
      expect(wakes).toBe(0)
      expect((yield* MessageV2.stream(chat.id)).filter(isBackgroundNotification)).toHaveLength(0)

      yield* control.release(chat.id)
      yield* pollWithTimeout(
        Effect.gen(function* () {
          const notifications = (yield* MessageV2.stream(chat.id)).filter(isBackgroundNotification)
          return notifications.length === 1 && wakes === 1 ? notifications : undefined
        }),
        "Timed out waiting for durable background notification",
      )
      yield* lifecycle.reconcile
      yield* lifecycle.reconcile

      const notifications = (yield* MessageV2.stream(chat.id)).filter(isBackgroundNotification)
      expect(notifications).toHaveLength(1)
      expect(notifications[0]?.parts).toHaveLength(1)
      expect(notifications[0]?.parts[0]?.type === "text" && notifications[0].parts[0].synthetic).toBe(true)
      expect(notifications[0]?.parts[0]?.type).toBe("text")
      if (notifications[0]?.parts[0]?.type === "text") {
        expect(notifications[0].parts[0].text).toContain("restart-safe result")
      }
      expect(wakes).toBe(1)
    }),
  )

  background.instance("does not cancel the background job when a foreground task is suspended", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const control = yield* SessionControl.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const started = yield* Deferred.make<void>()
      const complete = yield* Deferred.make<void>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(complete)),
            Effect.as(reply(input, "completed after release")),
          ),
      }
      const fiber = yield* def
        .execute(
          { description: "suspend foreground", prompt: "wait", subagent_type: "general" },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const job = (yield* jobs.list()).find((item) => item.metadata?.parentSessionId === chat.id)
      expect(job?.status).toBe("running")

      yield* control.pause({ rootSessionID: chat.id })
      yield* Fiber.interrupt(fiber)

      expect((yield* jobs.get(job!.id))?.status).toBe("running")
      yield* Deferred.succeed(complete, undefined)
      expect((yield* jobs.wait({ id: job!.id, timeout: 1_000 })).info?.status).toBe("completed")
      yield* control.release(chat.id)
    }),
  )

  background.instance("rebuilds the lifecycle layer and delivers a persisted paused error once", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* SessionControl.Service
      const database = yield* Database.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "restart child" })
      let wakes = 0
      const ops: TaskPromptOps = {
        ...stubOps(),
        wake: (sessionID) =>
          Effect.sync(() => {
            wakes++
            return reply({ sessionID, agent: "general", model: ref, parts: [] }, "woke")
          }),
        run: (sessionID) =>
          Effect.sync(() => {
            wakes++
            return reply({ sessionID, agent: "general", model: ref, parts: [] }, "woke")
          }),
      }

      yield* control.pause({ rootSessionID: chat.id })
      yield* Effect.gen(function* () {
        const lifecycle = yield* LifecycleReconciler.Service
        yield* lifecycle.attach(ops)
        const registration = yield* lifecycle.registerBackground({
          sessionID: child.id,
          parentSessionID: chat.id,
          description: "restart error delivery",
          agent: "build",
          model: ref,
          notifyParent: true,
          ops,
        })
        yield* lifecycle.settleBackground({
          sessionID: child.id,
          generation: registration.generation,
          state: "error",
          text: "failed before dispose",
          ops,
        })
      }).pipe(Effect.provide(Layer.fresh(LifecycleReconciler.layer)))

      const before = yield* database.db
        .select({ metadata: SessionTable.metadata })
        .from(SessionTable)
        .where(eq(SessionTable.id, child.id))
        .get()
        .pipe(Effect.orDie)
      expect(before?.metadata?.lifecycleReconciler).toMatchObject({
        state: "error",
        error: "failed before dispose",
        notification: "pending",
      })
      expect(wakes).toBe(0)

      yield* control.release(chat.id)
      yield* Effect.gen(function* () {
        const lifecycle = yield* LifecycleReconciler.Service
        yield* lifecycle.attach(ops)
        yield* Effect.all([lifecycle.reconcile, lifecycle.reconcile, lifecycle.reconcile], {
          concurrency: "unbounded",
          discard: true,
        })
      }).pipe(Effect.provide(Layer.fresh(LifecycleReconciler.layer)))

      const notifications = (yield* MessageV2.stream(chat.id)).filter(isBackgroundNotification)
      expect(notifications).toHaveLength(1)
      expect(
        notifications[0]?.parts.some((part) => part.type === "text" && part.text.includes("failed before dispose")),
      ).toBe(true)
      expect(wakes).toBe(1)
    }),
  )

  background.instance("ignores stale background generations and keeps explicit paused cancellation terminal", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const control = yield* SessionControl.Service
      const database = yield* Database.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "generation child" })
      const ops = stubOps()

      yield* Effect.gen(function* () {
        const lifecycle = yield* LifecycleReconciler.Service
        const first = yield* lifecycle.registerBackground({
          sessionID: child.id,
          parentSessionID: chat.id,
          description: "first generation",
          agent: "build",
          model: ref,
          notifyParent: true,
          ops,
        })
        yield* lifecycle.cancelBackground(child.id)
        const second = yield* lifecycle.registerBackground({
          sessionID: child.id,
          parentSessionID: chat.id,
          description: "second generation",
          agent: "build",
          model: ref,
          notifyParent: true,
          ops,
        })
        expect(second.generation).toBe(first.generation + 1)

        const stale = reply(
          {
            sessionID: child.id,
            messageID: first.promptMessageID,
            agent: "build",
            model: ref,
            parts: [],
          },
          "stale first generation",
        )
        yield* sessions.updateMessage(stale.info)
        for (const part of stale.parts) yield* sessions.updatePart(part)
        yield* lifecycle.reconcile
        yield* lifecycle.settleBackground({
          sessionID: child.id,
          generation: first.generation,
          state: "completed",
          text: "late watcher output",
          ops,
        })

        let row = yield* database.db
          .select({ metadata: SessionTable.metadata })
          .from(SessionTable)
          .where(eq(SessionTable.id, child.id))
          .get()
          .pipe(Effect.orDie)
        expect(row?.metadata?.lifecycleReconciler).toMatchObject({
          generation: second.generation,
          promptMessageID: second.promptMessageID,
          state: "running",
        })

        yield* control.pause({ rootSessionID: chat.id })
        yield* lifecycle.cancelBackground(child.id)
        yield* lifecycle.settleBackground({
          sessionID: child.id,
          generation: second.generation,
          state: "completed",
          text: "late after cancel",
          ops,
        })
        yield* control.release(chat.id)
        yield* lifecycle.reconcile

        row = yield* database.db
          .select({ metadata: SessionTable.metadata })
          .from(SessionTable)
          .where(eq(SessionTable.id, child.id))
          .get()
          .pipe(Effect.orDie)
        expect(row?.metadata?.lifecycleReconciler).toMatchObject({
          generation: second.generation,
          state: "cancelled",
          notification: "none",
        })
      }).pipe(Effect.provide(Layer.fresh(LifecycleReconciler.layer)))
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})
