import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { Team } from "@/team/team"
import { TeamRemote } from "@/team/remote"
import { TeamMessageTable, TeamTable, TeamTaskTable } from "@/team/team.sql"
import { TeamGetMessagesTool } from "@/tool/team_get_messages"
import { TeamSendMessageTool } from "@/tool/team_send_message"
import { TeamBroadcastTool } from "@/tool/team_broadcast"
import { TeamPlanSubmitTool } from "@/tool/team_plan_submit"
import { TeamPlanDecideTool } from "@/tool/team_plan_decide"
import { TeamTaskClaimTool } from "@/tool/team_task_claim"
import { TeamTaskUpdateTool } from "@/tool/team_task_update"
import { TeamTaskListTool } from "@/tool/team_task_list"
import type { TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { Database } from "@oc2-ai/core/database/database"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { ModelID, ProviderID } from "@/provider/schema"
import { FetchHttpClient } from "effect/unstable/http"
import { Server } from "../../src/server/server"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

// ---------------------------------------------------------------------------
// PR 3: remote-backed tool equality
//
// Every scenario runs the SAME member-actor tool handler twice:
//   1. LOCAL  - the handler's Team.Service is the in-process Team.Service the
//               shared test layer built (the same instance the existing tool
//               tests seed and execute against).
//   2. REMOTE - the handler's Team.Service is TeamRemote.remoteLayer, whose
//               Effect HttpClient is pointed at "http://control-plane". A fetch
//               shim routes every request in-process to Server.Default().app,
//               so the client walks the real HttpApi middleware + handlers
//               against the same shared memoMap-backed services (and the same
//               DB) the local run used.
//
// The seed always uses the LOCAL Team.Service (sessions.create + team.create +
// team.addMember + updateMemberStatus), exactly like the existing tool tests.
// Scenarios that MUTATE (send/claim/complete) run local then remote on two
// FRESH equivalent seeds so each run mutates its own rows; those scenarios
// assert equality on the deterministic fields (title / output / count /
// revision delta / final DB rows) and tokenize session + message + task ids
// that legitimately differ between the two runs.
//
// Excluded by design: team_create, team_spawn, team_shutdown, team_report,
// team_plan_decide approve/reject (lead-only), team_task_create, and the
// wake-safety stubs. The remote createUsageEvent is a synthetic non-persisted
// no-op, so broadcast asserts OUTPUT equality only and documents that no usage
// row is created remotely.
// ---------------------------------------------------------------------------

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffectShared(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Database.defaultLayer,
    Session.defaultLayer,
    Team.defaultLayer,
    Truncate.defaultLayer,
    FSUtil.defaultLayer,
    Layer.succeed(FetchHttpClient.Fetch, controlPlaneFetch as typeof globalThis.fetch),
    FetchHttpClient.layer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

// ---------------------------------------------------------------------------
// In-process control-plane transport
// ---------------------------------------------------------------------------

async function controlPlaneFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const source = input instanceof Request ? input : new Request(input, init)
  const url = new URL(source.url)
  const request = new Request(new URL(`${url.pathname}${url.search}`, "http://localhost"), source)
  return Server.Default().app.fetch(request)
}

type MemberConfig = {
  teamID: string
  memberSessionID: string
  directory: string
}

/** Builds the remote Team.Service (TeamRemote.remoteLayer over the in-process
 * control plane). The caller provides it to a tool handler with
 * Effect.provideService(Team.Service, service). */
function remoteTeam(config: MemberConfig) {
  const full: TeamRemote.Info = {
    leadURL: "http://control-plane",
    secret: "test",
    ...config,
  }
  return Team.Service.pipe(
    Effect.provide(
      TeamRemote.remoteLayer.pipe(
        Layer.provide(TeamRemote.Config.layer(full)),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Seed helpers (identical in shape to team_messages.test.ts seed + context)
// ---------------------------------------------------------------------------

const seedLead = Effect.fn("TeamRemoteToolTest.seedLead")(function* () {
  const sessions = yield* Session.Service
  const lead = yield* sessions.create({ title: "Lead" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: lead.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: lead.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { lead, user, assistant }
})

/** Fresh team named `name` with a lead and one ACTIVE worker member. The worker
 * session becomes the member actor for both the local and the remote run. */
const seedTeam = Effect.fn("TeamRemoteToolTest.seedTeam")(function* (
  name: string,
  input?: { planMode?: boolean },
) {
  const sessions = yield* Session.Service
  const team = yield* Team.Service
  const { lead, user, assistant } = yield* seedLead()
  const info = yield* team.create({ name, goal: "Coordinate work", leadSessionID: lead.id })
  const worker = yield* sessions.create({ parentID: lead.id, title: "Worker" })
  const workerMember = yield* team.addMember({
    teamID: info.id,
    sessionID: worker.id,
    name: "worker",
    agentType: "general",
    rolePrompt: "Do the work",
    planMode: input?.planMode,
    workMode: input?.planMode ? "plan" : "implement",
  })
  yield* team.updateMemberStatus(workerMember.id, "active")
  return { lead, user, assistant, info, worker, workerMember }
})

/** Adds an ACTIVE second member named `other` (used by broadcast). */
const seedOtherMember = Effect.fn("TeamRemoteToolTest.seedOtherMember")(function* (input: {
  lead: Session.Info
  info: Team.Info
}) {
  const sessions = yield* Session.Service
  const team = yield* Team.Service
  const other = yield* sessions.create({ parentID: input.lead.id, title: "Other" })
  const otherMember = yield* team.addMember({
    teamID: input.info.id,
    sessionID: other.id,
    name: "other",
    agentType: "general",
    rolePrompt: "Do unrelated work",
  })
  yield* team.updateMemberStatus(otherMember.id, "active")
  return { other, otherMember }
})

/** Adds a terminal finite member named `doneMember`. */
const seedDoneMember = Effect.fn("TeamRemoteToolTest.seedDoneMember")(function* (input: {
  lead: Session.Info
  info: Team.Info
}) {
  const sessions = yield* Session.Service
  const team = yield* Team.Service
  const done = yield* sessions.create({ parentID: input.lead.id, title: "Done member" })
  const doneMember = yield* team.addMember({
    teamID: input.info.id,
    sessionID: done.id,
    name: "doneMember",
    agentType: "general",
    rolePrompt: "Finish",
  })
  yield* team.updateMemberStatus(doneMember.id, "completed", "done")
  return { done, doneMember }
})

const sendLeadToWorker = Effect.fn("TeamRemoteToolTest.sendLeadToWorker")(function* (input: {
  info: Team.Info
  worker: Session.Info
  body: string
}) {
  const team = yield* Team.Service
  yield* team.sendMessage({
    teamID: input.info.id,
    sender: input.info.lead_session_id,
    recipients: [input.worker.id],
    body: input.body,
  })
})

function context(input: {
  sessionID: Session.Info
  assistant: MessageV2.Assistant
  callID?: string
  messages?: MessageV2.WithParts[]
  extra?: { [key: string]: unknown }
}) {
  return {
    sessionID: input.sessionID.id,
    messageID: input.assistant.id,
    callID: input.callID,
    agent: "build",
    abort: new AbortController().signal,
    messages: input.messages ?? [],
    extra: input.extra,
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function promptOps(input: {
  response: SessionV1.WithParts
  wake?: () => Effect.Effect<SessionV1.WithParts>
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: () => Effect.succeed([]),
    prompt: () => Effect.succeed(input.response),
    wake: input.wake ?? (() => Effect.succeed(input.response)),
    run: input.wake ?? (() => Effect.succeed(input.response)),
  }
}

const responseFor = (assistant: MessageV2.Assistant): SessionV1.WithParts => ({ info: assistant, parts: [] })

// ---------------------------------------------------------------------------
// DB helpers (read the same shared database both runs wrote to)
// ---------------------------------------------------------------------------

const revisionOf = Effect.fn("TeamRemoteToolTest.revisionOf")(function* (teamID: string) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ revision: TeamTable.revision })
    .from(TeamTable)
    .where(eq(TeamTable.id, teamID))
    .get()
    .pipe(Effect.orDie)
  return row?.revision ?? -1
})

const countMessages = Effect.fn("TeamRemoteToolTest.countMessages")(function* (teamID: string) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({ id: TeamMessageTable.id })
    .from(TeamMessageTable)
    .where(eq(TeamMessageTable.team_id, teamID))
    .all()
    .pipe(Effect.orDie)
  return rows.length
})

// ---------------------------------------------------------------------------
// Equality helpers
// ---------------------------------------------------------------------------

/** Replaces each id (full value and its 8-char slice) with a stable token so
 * two fresh seeds with different generated ids produce comparable text. */
function tokenize(text: string, ids: Record<string, string>) {
  let result = text
  for (const [token, id] of Object.entries(ids)) {
    result = result.split(id).join(`<${token}>`)
    result = result.split(id.slice(0, 8)).join(`<${token}-8>`)
  }
  return result
}

type ToolOutcome = { title: string; output: string; metadata: Record<string, unknown> }

/** Compares two runs that legitimately carry different generated ids: each
 * output is tokenized against its own seed's ids first, then deep-compared. */
function expectEqualTitleAndTokenizedOutput(
  local: ToolOutcome,
  remote: ToolOutcome,
  localIds: Record<string, string>,
  remoteIds: Record<string, string>,
) {
  expect(local.title).toBe(remote.title)
  expect(tokenize(local.output, localIds)).toBe(tokenize(remote.output, remoteIds))
}

function expectEqualTitleAndOutput(local: ToolOutcome, remote: ToolOutcome) {
  expect(local.title).toBe(remote.title)
  expect(local.output).toBe(remote.output)
}

/** The tool wrapper annotates every result with `truncated` and the send/broadcast
 * tools add `messageID` (a fresh id per run). Strip the run-varying `messageID`
 * so two fresh-seed runs are compared on their deterministic metadata only. */
function comparableMetadata(metadata: unknown): Record<string, unknown> {
  const { messageID: _messageID, ...rest } = metadata as { messageID?: unknown }
  void _messageID
  return rest
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("member tool equality: local Team.Service vs TeamRemote.remoteLayer", () => {
  it.live("mailbox claim once: identical renders and both rows delivered", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          // ---- local run ----
          const local = yield* seedTeam("mailbox-once-local")
          yield* sendLeadToWorker({ info: local.info, worker: local.worker, body: "First update." })
          // Give the second send a distinct timestamp so the claim order is the
          // same deterministic insertion order on both sides.
          yield* Effect.sleep("2 millis")
          yield* sendLeadToWorker({ info: local.info, worker: local.worker, body: "Second update." })
          const localDef = yield* (yield* TeamGetMessagesTool).init()
          const localCtx = context({ sessionID: local.worker, assistant: local.assistant })
          const localFirst = yield* localDef.execute({}, localCtx)
          const localSecond = yield* localDef.execute({}, localCtx)

          // ---- remote run (fresh equivalent seed, same tool) ----
          const remote = yield* seedTeam("mailbox-once-remote")
          yield* sendLeadToWorker({ info: remote.info, worker: remote.worker, body: "First update." })
          yield* Effect.sleep("2 millis")
          yield* sendLeadToWorker({ info: remote.info, worker: remote.worker, body: "Second update." })
          const remoteSvc = yield* remoteTeam({
            teamID: remote.info.id,
            memberSessionID: remote.worker.id,
            directory,
          })
          const remoteTool = yield* TeamGetMessagesTool.pipe(Effect.provideService(Team.Service, remoteSvc))
          const remoteDef = yield* remoteTool.init()
          const remoteCtx = context({ sessionID: remote.worker, assistant: remote.assistant })
          const remoteFirst = yield* remoteDef.execute({}, remoteCtx)
          const remoteSecond = yield* remoteDef.execute({}, remoteCtx)

          // First claim delivers both messages on each side with the same render.
          expectEqualTitleAndTokenizedOutput(
            localFirst,
            remoteFirst,
            { lead: local.info.lead_session_id, worker: local.worker.id },
            { lead: remote.info.lead_session_id, worker: remote.worker.id },
          )
          expect(localFirst.title).toBe("Team Messages")
          expect(remoteFirst.title).toBe("Team Messages")
          expect(comparableMetadata(localFirst.metadata)).toEqual({ count: 2, repeated: false, truncated: false })
          expect(comparableMetadata(remoteFirst.metadata)).toEqual({ count: 2, repeated: false, truncated: false })

          // Second claim is empty on both sides with the same member empty render.
          expect(localSecond.title).toBe("Team Messages")
          expect(remoteSecond.title).toBe("Team Messages")
          expect(localSecond.output).toContain("No pending messages.")
          expect(remoteSecond.output).toContain("No pending messages.")
          expect(localSecond.metadata).toMatchObject({ count: 0, repeated: false })
          expect(remoteSecond.metadata).toMatchObject({ count: 0, repeated: false })
          expectEqualTitleAndTokenizedOutput(
            localSecond,
            remoteSecond,
            { worker: local.worker.id },
            { worker: remote.worker.id },
          )

          // Both runs ack every message: two delivered rows per team, zero pending.
          for (const info of [local.info, remote.info]) {
            const { db } = yield* Database.Service
            const rows = yield* db
              .select({ delivery_status: TeamMessageTable.delivery_status })
              .from(TeamMessageTable)
              .where(eq(TeamMessageTable.team_id, info.id))
              .all()
              .pipe(Effect.orDie)
            expect(rows).toHaveLength(2)
            expect(rows.every((row) => row.delivery_status === "delivered")).toBe(true)
          }
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("send to a completed finite member: identical rejection and no message row", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const local = yield* seedTeam("terminal-local")
          yield* seedDoneMember({ lead: local.lead, info: local.info })
          const localMessagesBefore = yield* countMessages(local.info.id)
          const localDef = yield* (yield* TeamSendMessageTool).init()
          const localResult = yield* localDef.execute(
            { recipient: "doneMember", body: "Hello" },
            context({
              sessionID: local.worker,
              assistant: local.assistant,
              extra: { promptOps: promptOps({ response: responseFor(local.assistant) }) },
            }),
          )

          const remote = yield* seedTeam("terminal-remote")
          yield* seedDoneMember({ lead: remote.lead, info: remote.info })
          const remoteMessagesBefore = yield* countMessages(remote.info.id)
          const remoteSvc = yield* remoteTeam({
            teamID: remote.info.id,
            memberSessionID: remote.worker.id,
            directory,
          })
          const remoteDef = yield* (yield* TeamSendMessageTool.pipe(Effect.provideService(Team.Service, remoteSvc))).init()
          const remoteResult = yield* remoteDef.execute(
            { recipient: "doneMember", body: "Hello" },
            context({
              sessionID: remote.worker,
              assistant: remote.assistant,
              extra: { promptOps: promptOps({ response: responseFor(remote.assistant) }) },
            }),
          )

          expectEqualTitleAndOutput(localResult, remoteResult)
          expect(localResult.title).toBe("Team Message")
          expect(localResult.output).toBe("Recipient 'doneMember' is completed and cannot receive messages.")
          expect(remoteResult.output).toBe(localResult.output)
          expect(comparableMetadata(localResult.metadata)).toEqual({ truncated: false })
          expect(comparableMetadata(remoteResult.metadata)).toEqual({ truncated: false })

          // The rejected send created no message row on either side. (Both teams
          // carry the terminal-notification row the seed's completion wrote.)
          expect(yield* countMessages(local.info.id)).toBe(localMessagesBefore)
          expect(yield* countMessages(remote.info.id)).toBe(remoteMessagesBefore)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("member->lead send: identical output, one revision bump, one row", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const local = yield* seedTeam("send-local")
          const localDef = yield* (yield* TeamSendMessageTool).init()
          const localBefore = yield* revisionOf(local.info.id)
          const localResult = yield* localDef.execute(
            { recipient: "lead", body: "Implementation complete." },
            context({ sessionID: local.worker, assistant: local.assistant }),
          )
          const localAfter = yield* revisionOf(local.info.id)

          const remote = yield* seedTeam("send-remote")
          const remoteSvc = yield* remoteTeam({
            teamID: remote.info.id,
            memberSessionID: remote.worker.id,
            directory,
          })
          const remoteDef = yield* (yield* TeamSendMessageTool.pipe(Effect.provideService(Team.Service, remoteSvc))).init()
          const remoteBefore = yield* revisionOf(remote.info.id)
          const remoteResult = yield* remoteDef.execute(
            { recipient: "lead", body: "Implementation complete." },
            context({ sessionID: remote.worker, assistant: remote.assistant }),
          )
          const remoteAfter = yield* revisionOf(remote.info.id)

          expect(localResult.title).toBe("Message Sent")
          expect(remoteResult.title).toBe("Message Sent")
          expectEqualTitleAndOutput(localResult, remoteResult)
          expect(localResult.output).toContain("Sent to 1 recipient(s).")
          expect(typeof localResult.metadata.messageID).toBe("string")
          expect(typeof remoteResult.metadata.messageID).toBe("string")

          // Fresh equivalent seeds start from the same revision, and the send
          // bumps each by exactly one, so the final revisions are identical.
          expect(localBefore).toBe(remoteBefore)
          expect(localAfter).toBe(localBefore + 1)
          expect(remoteAfter).toBe(remoteBefore + 1)
          expect(localAfter).toBe(remoteAfter)
          expect(yield* countMessages(local.info.id)).toBe(1)
          expect(yield* countMessages(remote.info.id)).toBe(1)

          // Claim + ack by the LEAD causes no further revision bump on either
          // side (mailbox delivery state is not a material team mutation).
          const localService = yield* Team.Service
          const remoteService = yield* Team.Service
          const localClaimed = yield* localService.claimPendingMessages(local.info.lead_session_id, local.info.id)
          const remoteClaimed = yield* remoteService.claimPendingMessages(remote.info.lead_session_id, remote.info.id)
          expect(localClaimed.length + remoteClaimed.length).toBeGreaterThanOrEqual(1)
          for (const message of localClaimed) yield* localService.markMessageDelivered(message.id, local.info.lead_session_id)
          for (const message of remoteClaimed) yield* remoteService.markMessageDelivered(message.id, remote.info.lead_session_id)
          // Identical final revision: the lead's claim/ack must not bump either.
          expect(yield* revisionOf(local.info.id)).toBe(localAfter)
          expect(yield* revisionOf(remote.info.id)).toBe(remoteAfter)
          expect(yield* revisionOf(local.info.id)).toBe(yield* revisionOf(remote.info.id))
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("send + own empty mailbox round trip from a member: identical renders", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const local = yield* seedTeam("roundtrip-local")
          const localSend = yield* (yield* TeamSendMessageTool).init()
          const localGet = yield* (yield* TeamGetMessagesTool).init()
          const localSent = yield* localSend.execute(
            { recipient: "lead", body: "Progress update." },
            context({ sessionID: local.worker, assistant: local.assistant }),
          )
          const localMailbox = yield* localGet.execute({}, context({ sessionID: local.worker, assistant: local.assistant }))

          const remote = yield* seedTeam("roundtrip-remote")
          const remoteSvc = yield* remoteTeam({
            teamID: remote.info.id,
            memberSessionID: remote.worker.id,
            directory,
          })
          const remoteSendTool = yield* TeamSendMessageTool.pipe(Effect.provideService(Team.Service, remoteSvc))
          const remoteGetTool = yield* TeamGetMessagesTool.pipe(Effect.provideService(Team.Service, remoteSvc))
          const remoteSent = yield* (yield* remoteSendTool.init()).execute(
            { recipient: "lead", body: "Progress update." },
            context({ sessionID: remote.worker, assistant: remote.assistant }),
          )
          const remoteMailbox = yield* (yield* remoteGetTool.init()).execute(
            {},
            context({ sessionID: remote.worker, assistant: remote.assistant }),
          )

          expectEqualTitleAndOutput(localSent, remoteSent)
          // The member's own mailbox is empty on both sides: it sent to the lead
          // and never delivered to itself. The member empty render must match.
          expectEqualTitleAndTokenizedOutput(
            localMailbox,
            remoteMailbox,
            { worker: local.worker.id },
            { worker: remote.worker.id },
          )
          expect(localMailbox.output).toContain("No pending messages.")
          expect(localMailbox.metadata).toMatchObject({ count: 0, repeated: false })
          expect(remoteMailbox.metadata).toMatchObject({ count: 0, repeated: false })

          // Both runs persist exactly one message row (the worker's send to the
          // lead). The worker never delivers to itself, so the member's own
          // get_messages saw an empty mailbox on both sides.
          expect(yield* countMessages(local.info.id)).toBe(1)
          expect(yield* countMessages(remote.info.id)).toBe(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("broadcast from a member: identical output (usage rows documented)", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const local = yield* seedTeam("broadcast-local")
          yield* seedOtherMember({ lead: local.lead, info: local.info })
          const localDef = yield* (yield* TeamBroadcastTool).init()
          const localResult = yield* localDef.execute(
            { body: "Review is ready." },
            context({ sessionID: local.worker, assistant: local.assistant }),
          )

          const remote = yield* seedTeam("broadcast-remote")
          yield* seedOtherMember({ lead: remote.lead, info: remote.info })
          const remoteSvc = yield* remoteTeam({
            teamID: remote.info.id,
            memberSessionID: remote.worker.id,
            directory,
          })
          const remoteDef = yield* (yield* TeamBroadcastTool.pipe(Effect.provideService(Team.Service, remoteSvc))).init()
          const remoteResult = yield* remoteDef.execute(
            { body: "Review is ready." },
            context({ sessionID: remote.worker, assistant: remote.assistant }),
          )

          expectEqualTitleAndOutput(localResult, remoteResult)
          expect(localResult.title).toBe("Broadcast Sent")
          expect(localResult.output).toContain("Sent to 2 recipient(s).")
          expect(localResult.output).toContain("Delivery is asynchronous.")
          expect(typeof localResult.metadata.messageID).toBe("string")
          expect(typeof remoteResult.metadata.messageID).toBe("string")

          // NOTE: the remote client's createUsageEvent is a synthetic
          // non-persisted no-op by design (the lead already audits the durable
          // send side), so this scenario asserts tool OUTPUT equality only and
          // never DB usage rows. Both runs must still persist exactly the one
          // broadcast message row.
          expect(yield* countMessages(local.info.id)).toBe(1)
          expect(yield* countMessages(remote.info.id)).toBe(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("plan submit from a plan-mode member: identical output and one plan message", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const local = yield* seedTeam("plan-submit-local", { planMode: true })
          const localDef = yield* (yield* TeamPlanSubmitTool).init()
          const localResult = yield* localDef.execute(
            { plan: "I will inspect then patch." },
            context({ sessionID: local.worker, assistant: local.assistant }),
          )

          const remote = yield* seedTeam("plan-submit-remote", { planMode: true })
          const remoteSvc = yield* remoteTeam({
            teamID: remote.info.id,
            memberSessionID: remote.worker.id,
            directory,
          })
          const remoteDef = yield* (yield* TeamPlanSubmitTool.pipe(Effect.provideService(Team.Service, remoteSvc))).init()
          const remoteResult = yield* remoteDef.execute(
            { plan: "I will inspect then patch." },
            context({ sessionID: remote.worker, assistant: remote.assistant }),
          )

          expectEqualTitleAndOutput(localResult, remoteResult)
          expect(localResult.title).toBe("Plan Submitted")
          expect(localResult.output).toBe("Plan submitted for lead review.")
          expect(localResult.metadata).toEqual({ truncated: false })
          expect(remoteResult.metadata).toEqual({ truncated: false })
          expect(yield* countMessages(local.info.id)).toBe(1)
          expect(yield* countMessages(remote.info.id)).toBe(1)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("plan decide from a member: identical no-active-team degenerate result", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const local = yield* seedTeam("plan-decide-local", { planMode: true })
          const localDef = yield* (yield* TeamPlanDecideTool).init()
          const localResult = yield* localDef.execute(
            { member_name: local.workerMember.name, decision: "approve", feedback: "Proceed." },
            context({ sessionID: local.worker, assistant: local.assistant }),
          )

          const remote = yield* seedTeam("plan-decide-remote", { planMode: true })
          const remoteSvc = yield* remoteTeam({
            teamID: remote.info.id,
            memberSessionID: remote.worker.id,
            directory,
          })
          const remoteDef = yield* (yield* TeamPlanDecideTool.pipe(Effect.provideService(Team.Service, remoteSvc))).init()
          const remoteResult = yield* remoteDef.execute(
            { member_name: remote.workerMember.name, decision: "approve", feedback: "Proceed." },
            context({ sessionID: remote.worker, assistant: remote.assistant }),
          )

          expectEqualTitleAndOutput(localResult, remoteResult)
          expect(localResult.title).toBe("Plan Decide Failed")
          expect(localResult.output).toBe("No active team.")
          expect(remoteResult.output).toBe("No active team.")
          expect(localResult.metadata).toEqual({ truncated: false })
          expect(remoteResult.metadata).toEqual({ truncated: false })
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )

  it.live("task claim/update/list by the assigned member: identical results and final DB state", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          // local
          const local = yield* seedTeam("task-local")
          const localTeam = yield* Team.Service
          const localTask = yield* localTeam.createTask({
            teamID: local.info.id,
            description: "Implement the task workflow",
            assignee: local.worker.id,
          })
          const localClaim = yield* (yield* TeamTaskClaimTool).init()
          const localUpdate = yield* (yield* TeamTaskUpdateTool).init()
          const localList = yield* (yield* TeamTaskListTool).init()
          const localCtx = context({ sessionID: local.worker, assistant: local.assistant })
          const localClaimed = yield* localClaim.execute({ task_id: localTask.id }, localCtx)
          const localUpdated = yield* localUpdate.execute(
            { task_id: localTask.id, status: "completed" },
            localCtx,
          )
          const localListed = yield* localList.execute({}, localCtx)

          // remote
          const remote = yield* seedTeam("task-remote")
          const remoteSvc = yield* remoteTeam({
            teamID: remote.info.id,
            memberSessionID: remote.worker.id,
            directory,
          })
          const remoteTask = yield* (yield* Team.Service).createTask({
            teamID: remote.info.id,
            description: "Implement the task workflow",
            assignee: remote.worker.id,
          })
          const remoteClaimDef = yield* (yield* TeamTaskClaimTool.pipe(Effect.provideService(Team.Service, remoteSvc))).init()
          const remoteUpdateDef = yield* (yield* TeamTaskUpdateTool.pipe(Effect.provideService(Team.Service, remoteSvc))).init()
          const remoteListDef = yield* (yield* TeamTaskListTool.pipe(Effect.provideService(Team.Service, remoteSvc))).init()
          const remoteCtx = context({ sessionID: remote.worker, assistant: remote.assistant })
          const remoteClaimed = yield* remoteClaimDef.execute({ task_id: remoteTask.id }, remoteCtx)
          const remoteUpdated = yield* remoteUpdateDef.execute(
            { task_id: remoteTask.id, status: "completed" },
            remoteCtx,
          )
          const remoteListed = yield* remoteListDef.execute({}, remoteCtx)

          expect(localClaimed.title).toBe("Task Claimed")
          expect(remoteClaimed.title).toBe("Task Claimed")
          expect(localUpdated.title).toBe("Task Updated")
          expect(remoteUpdated.title).toBe("Task Updated")
          expect(localUpdated.output.endsWith("→ completed")).toBe(true)
          expect(remoteUpdated.output.endsWith("→ completed")).toBe(true)
          // The claim/update outputs embed each run's own generated task id
          // prefix, so compare the deterministic list render instead.
          expect(localListed.title).toBe("Team Tasks")
          expect(remoteListed.title).toBe("Team Tasks")
          expect(tokenize(localListed.output, { task: localTask.id, worker: local.worker.id })).toBe(
            tokenize(remoteListed.output, { task: remoteTask.id, worker: remote.worker.id }),
          )

          const localRow = yield* readTask(localTask.id)
          const remoteRow = yield* readTask(remoteTask.id)
          expect(localRow?.status).toBe("completed")
          expect(remoteRow?.status).toBe("completed")
          expect(localRow?.assignee).toBe(local.worker.id)
          expect(remoteRow?.assignee).toBe(remote.worker.id)
        }),
      { config: { experimental: { agent_teams: true } } },
    ),
  )
})

const readTask = Effect.fn("TeamRemoteToolTest.readTask")(function* (taskID: string) {
  const { db } = yield* Database.Service
  return yield* db.select().from(TeamTaskTable).where(eq(TeamTaskTable.id, taskID)).get().pipe(Effect.orDie)
})
