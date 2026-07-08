import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@oc2-ai/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@oc2-ai/core/session/sql"
import { ProjectTable } from "@oc2-ai/core/project/sql"
import { ProjectV2 } from "@oc2-ai/core/project"
import { AbsolutePath } from "@oc2-ai/core/schema"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { aggregateSessionStats } from "@/cli/cmd/stats"
import { MessageID, PartID, SessionID } from "@/session/schema"
import * as Log from "@oc2-ai/core/util/log"
import { testEffect } from "../../lib/effect"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(Database.layerFromPath(":memory:")))

const projectID = (id: string) => ProjectV2.ID.make(id)
const sessionID = (id: string) => SessionID.descending(`ses_${id}`)
const messageID = (id: string) => MessageID.ascending(`msg_${id}`)
const partID = (id: string) => PartID.ascending(`prt_${id}`)
const providerID = (id: string) => ProviderV2.ID.make(id)
const modelID = (id: string) => ModelV2.ID.make(id)

const seedProject = (id: ProjectV2.ID) =>
  Database.Service.use(({ db }) =>
    db
      .insert(ProjectTable)
      .values({
        id,
        worktree: AbsolutePath.make("/tmp/stats-test"),
        time_created: 1,
        time_updated: 1,
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )

const seedSession = (input: {
  id: SessionID
  projectID: ProjectV2.ID
  cost?: number
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  created?: number
  updated?: number
}) =>
  Database.Service.use(({ db }) =>
    db
      .insert(SessionTable)
      .values({
        id: input.id,
        project_id: input.projectID,
        slug: input.id,
        directory: "/tmp/stats-test",
        title: "test",
        version: "0.0.0-test",
        time_created: input.created ?? 1,
        time_updated: input.updated ?? 1,
        cost: input.cost ?? 0,
        tokens_input: input.input ?? 0,
        tokens_output: input.output ?? 0,
        tokens_reasoning: input.reasoning ?? 0,
        tokens_cache_read: input.cacheRead ?? 0,
        tokens_cache_write: input.cacheWrite ?? 0,
      })
      .run()
      .pipe(Effect.orDie),
  )

const seedAssistantMessage = (input: {
  id: MessageID
  sessionID: SessionID
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  cost?: number
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}) => {
  const data: Omit<SessionV1.Assistant, "id" | "sessionID"> = {
    role: "assistant",
    time: { created: 1 },
    parentID: messageID(`${input.id}-parent`),
    providerID: input.providerID,
    modelID: input.modelID,
    mode: "build",
    agent: "default",
    path: { cwd: "/tmp/stats-test", root: "/tmp/stats-test" },
    cost: input.cost ?? 0,
    tokens: {
      input: input.input ?? 0,
      output: input.output ?? 0,
      reasoning: input.reasoning ?? 0,
      cache: { read: input.cacheRead ?? 0, write: input.cacheWrite ?? 0 },
    },
  }

  return Database.Service.use(({ db }) =>
    db
      .insert(MessageTable)
      .values({
        id: input.id,
        session_id: input.sessionID,
        time_created: 1,
        time_updated: 1,
        data,
      })
      .run()
      .pipe(Effect.orDie),
  )
}

const seedToolPart = (input: { id: PartID; sessionID: SessionID; messageID: MessageID; tool: string }) => {
  const data: Omit<SessionV1.ToolPart, "id" | "sessionID" | "messageID"> = {
    type: "tool",
    callID: input.id,
    tool: input.tool,
    state: { status: "pending", input: {}, raw: "{}" },
  }

  return Database.Service.use(({ db }) =>
    db
      .insert(PartTable)
      .values({
        id: input.id,
        session_id: input.sessionID,
        message_id: input.messageID,
        time_created: 1,
        time_updated: 1,
        data,
      })
      .run()
      .pipe(Effect.orDie),
  )
}

describe("stats aggregate", () => {
  it.live("aggregates multiple sessions, models, and tools", () =>
    Effect.gen(function* () {
      const project = projectID("project-stats-multi")
      const sessionA = sessionID("stats_multi_a")
      const sessionB = sessionID("stats_multi_b")
      const messageA1 = messageID("stats_multi_a1")
      const messageA2 = messageID("stats_multi_a2")
      const messageB1 = messageID("stats_multi_b1")
      const messageB2 = messageID("stats_multi_b2")

      yield* seedProject(project)
      yield* seedSession({
        id: sessionA,
        projectID: project,
        cost: 0.01,
        input: 100,
        output: 200,
        reasoning: 10,
        cacheRead: 20,
        cacheWrite: 5,
      })
      yield* seedAssistantMessage({
        id: messageA1,
        sessionID: sessionA,
        providerID: providerID("p1"),
        modelID: modelID("m1"),
        cost: 0.005,
        input: 50,
        output: 100,
        reasoning: 5,
        cacheRead: 10,
        cacheWrite: 2,
      })
      yield* seedAssistantMessage({
        id: messageA2,
        sessionID: sessionA,
        providerID: providerID("p1"),
        modelID: modelID("m1"),
        cost: 0.003,
        input: 30,
        output: 60,
        reasoning: 3,
      })
      yield* seedToolPart({ id: partID("stats_multi_a1"), sessionID: sessionA, messageID: messageA1, tool: "bash" })
      yield* seedToolPart({ id: partID("stats_multi_a2"), sessionID: sessionA, messageID: messageA1, tool: "read" })

      yield* seedSession({
        id: sessionB,
        projectID: project,
        cost: 0.02,
        input: 200,
        output: 300,
        reasoning: 20,
        cacheRead: 5,
      })
      yield* seedAssistantMessage({
        id: messageB1,
        sessionID: sessionB,
        providerID: providerID("p2"),
        modelID: modelID("m2"),
        cost: 0.01,
        input: 100,
        output: 150,
        reasoning: 10,
      })
      yield* seedAssistantMessage({
        id: messageB2,
        sessionID: sessionB,
        providerID: providerID("p1"),
        modelID: modelID("m1"),
        cost: 0.004,
        input: 40,
        output: 80,
        reasoning: 2,
      })
      yield* seedToolPart({ id: partID("stats_multi_b1"), sessionID: sessionB, messageID: messageB1, tool: "bash" })
      yield* seedToolPart({ id: partID("stats_multi_b2"), sessionID: sessionB, messageID: messageB2, tool: "bash" })
      yield* seedToolPart({ id: partID("stats_multi_b3"), sessionID: sessionB, messageID: messageB2, tool: "edit" })

      const stats = yield* aggregateSessionStats()

      expect(stats.totalSessions).toBe(2)
      expect(stats.totalMessages).toBe(4)
      expect(stats.totalCost).toBeCloseTo(0.03)
      expect(stats.totalTokens).toEqual({
        input: 300,
        output: 500,
        reasoning: 30,
        cache: { read: 25, write: 5 },
      })
      expect(stats.tokensPerSession).toBe(430)
      expect(stats.medianTokensPerSession).toBe(430)
      expect(Object.keys(stats.modelUsage).sort()).toEqual(["p1/m1", "p2/m2"])
      expect(stats.modelUsage["p1/m1"]).toEqual({
        messages: 3,
        tokens: { input: 120, output: 250, cache: { read: 10, write: 2 } },
        cost: 0.012,
      })
      expect(stats.modelUsage["p2/m2"]).toEqual({
        messages: 1,
        tokens: { input: 100, output: 160, cache: { read: 0, write: 0 } },
        cost: 0.01,
      })
      expect(stats.toolUsage).toEqual({ bash: 3, read: 1, edit: 1 })
    }),
  )

  it.live("counts empty and no-tool sessions", () =>
    Effect.gen(function* () {
      const project = projectID("project-stats-empty")
      const emptySession = sessionID("stats_empty")
      const noToolSession = sessionID("stats_no_tool")

      yield* seedProject(project)
      yield* seedSession({ id: emptySession, projectID: project })
      yield* seedSession({ id: noToolSession, projectID: project, input: 10, output: 20 })
      yield* seedAssistantMessage({
        id: messageID("stats_no_tool"),
        sessionID: noToolSession,
        providerID: providerID("p3"),
        modelID: modelID("m3"),
        cost: 0.001,
        input: 10,
        output: 20,
      })

      const stats = yield* aggregateSessionStats()

      expect(stats.totalSessions).toBe(2)
      expect(stats.totalMessages).toBe(1)
      expect(stats.modelUsage["p3/m3"]?.messages).toBe(1)
      expect(stats.toolUsage).toEqual({})
      expect(stats.medianTokensPerSession).toBe(15)
    }),
  )

  it.live("filters by explicit project", () =>
    Effect.gen(function* () {
      const projectA = projectID("project-stats-a")
      const projectB = projectID("project-stats-b")
      const sessionA = sessionID("stats_project_a")
      const sessionB = sessionID("stats_project_b")

      yield* seedProject(projectA)
      yield* seedProject(projectB)
      yield* seedSession({ id: sessionA, projectID: projectA, cost: 1 })
      yield* seedAssistantMessage({
        id: messageID("stats_project_a"),
        sessionID: sessionA,
        providerID: providerID("p"),
        modelID: modelID("m"),
        cost: 0.5,
      })
      yield* seedSession({ id: sessionB, projectID: projectB, cost: 2 })
      yield* seedAssistantMessage({
        id: messageID("stats_project_b"),
        sessionID: sessionB,
        providerID: providerID("p"),
        modelID: modelID("m"),
        cost: 1.5,
      })

      const stats = yield* aggregateSessionStats(undefined, projectA)

      expect(stats.totalSessions).toBe(1)
      expect(stats.totalMessages).toBe(1)
      expect(stats.totalCost).toBe(1)
      expect(stats.modelUsage["p/m"]?.cost).toBe(0.5)
    }),
  )

  it.live("filters by current project for empty project filter", () =>
    Effect.gen(function* () {
      const projectA = projectID("project-stats-current-a")
      const projectB = projectID("project-stats-current-b")

      yield* seedProject(projectA)
      yield* seedProject(projectB)
      yield* seedSession({ id: sessionID("stats_current_a"), projectID: projectA, cost: 1 })
      yield* seedSession({ id: sessionID("stats_current_b"), projectID: projectB, cost: 2 })

      const stats = yield* aggregateSessionStats(undefined, "", {
        id: projectB,
        worktree: "/tmp/stats-test",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      })

      expect(stats.totalSessions).toBe(1)
      expect(stats.totalCost).toBe(2)
    }),
  )

  it.live("filters by days using session update time", () =>
    Effect.gen(function* () {
      const project = projectID("project-stats-days")
      const now = Date.now()
      const oldSession = sessionID("stats_days_old")
      const recentSession = sessionID("stats_days_recent")

      yield* seedProject(project)
      yield* seedSession({ id: oldSession, projectID: project, updated: now - 10 * 24 * 60 * 60 * 1000, cost: 1 })
      yield* seedSession({ id: recentSession, projectID: project, updated: now, cost: 2 })
      yield* seedAssistantMessage({
        id: messageID("stats_days_old"),
        sessionID: oldSession,
        providerID: providerID("p"),
        modelID: modelID("m"),
        cost: 0.2,
      })
      yield* seedAssistantMessage({
        id: messageID("stats_days_recent"),
        sessionID: recentSession,
        providerID: providerID("p"),
        modelID: modelID("m"),
        cost: 0.3,
      })

      const stats = yield* aggregateSessionStats(5)

      expect(stats.totalSessions).toBe(1)
      expect(stats.totalMessages).toBe(1)
      expect(stats.totalCost).toBe(2)
      expect(stats.days).toBe(5)
      expect(stats.dateRange.earliest).toBe(now)
    }),
  )
})
