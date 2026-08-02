import { Database } from "@oc2-ai/core/database/database"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { SessionControl } from "@oc2-ai/core/session/control"
import {
  MessageTable,
  PartTable,
  SessionPauseBlockerTable,
  SessionPauseCascadeTable,
  SessionTable,
} from "@oc2-ai/core/session/sql"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { TeamMemberTable, TeamMessageRecipientTable, TeamMessageTable, TeamTable } from "@/team/team.sql"
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schedule, Scope } from "effect"

import type { SessionPrompt } from "./prompt"

export interface PromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts, Runner.Suspended>
  /**
   * Non-blocking nudge. It returns once a loop iteration is scheduled and never reports a result,
   * so it must not be used to decide that a member or a background task finished.
   */
  wake(sessionID: SessionID): Effect.Effect<void, Runner.Suspended>
  /** Runs the session loop to completion and answers with its final assistant message. */
  run(sessionID: SessionID): Effect.Effect<SessionV1.WithParts, Runner.Suspended>
}

type BackgroundState = "running" | "completed" | "error" | "cancelled"

type BackgroundMetadata = {
  kind: "background-task"
  generation: number
  promptMessageID: string
  parentSessionID: string
  description: string
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  notifyParent: boolean
  state: BackgroundState
  output?: string
  error?: string
  notification: "none" | "pending" | "delivering" | "delivered"
  deliveryToken?: string
  /**
   * IDs of the parent notification message. They are allocated once inside the delivery claim and
   * reused by every retry, so a crash between claim and acknowledgement cannot inject the result
   * twice.
   */
  notificationMessageID?: string
  notificationPartID?: string
}

type MemberMetadata = {
  kind: "team-member"
  memberID: string
  promptMessageID: string
  state: "running" | "completed" | "idle" | "cancelled"
  output?: string
  error?: string
}

type State = {
  readonly projectID: SessionRow["project_id"]
  readonly runningMembers: Set<string>
  readonly launchingBackground: Set<string>
  readonly watchedBackground: Set<string>
  readonly scope: Scope.Scope
  readonly owner: string
  ops?: PromptOps
  started: boolean
  recovered: boolean
}

type TeamMemberRow = typeof TeamMemberTable.$inferSelect
type TeamRow = typeof TeamTable.$inferSelect
type SessionRow = typeof SessionTable.$inferSelect
type PartRow = typeof PartTable.$inferSelect
type DatabaseService = Database.Interface["db"]
type QueryDatabase = Pick<DatabaseService, "select">
type WriteDatabase = Pick<DatabaseService, "insert">

const metadataKey = "lifecycleReconciler"
const memberMetadataKey = "lifecycleTeamMember"
const terminalMemberStatuses = ["completed", "cancelled"] as const
// Reconciliation is poll driven so it also covers work that no live fiber owns after a restart.
// The interval is a deliberate trade-off between resume latency and idle query cost; see the
// "polling cost" note in the persistent-session-pause spec follow-ups.
const pollInterval = Duration.millis(500)

function chunk<A>(items: readonly A[], size = 500): A[][] {
  const chunks: A[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

const CommunicationGuidance = [
  "Proactive communication requirements:",
  '- Never ask the user questions directly. Route every question or clarification request to the lead with team_send_message recipient "lead".',
  "- If a child subagent needs user input, relay its question to the lead through team_send_message instead of asking the user directly.",
  '- Before doing substantial work, send a brief kickoff update to the lead with team_send_message recipient "lead".',
  "- Send concise progress updates to the lead after material findings, decisions, completed milestones, and before or after risky edits.",
  "- Message teammates directly when your work affects them, unblocks them, or gives them information they need.",
  "- Check team_get_messages at natural handoff points, after sending updates, and whenever you may have been unblocked or redirected.",
  "- Do not wait until your final answer to share useful status, blockers, or intermediate results.",
  "- When you send a message via team_send_message or team_broadcast, recipients are automatically woken. Do not poll team_get_messages in a loop — check once and continue working.",
  "- Do not claim that an issue is fixed, a feature is complete, or an action succeeded without supporting evidence.",
  "- Only report to me in ASD-STE100 Simplified Technical English.",
  "- Let perfect not be the enemy of good.",
].join("\n")

const DaemonGuidance = [
  "Daemon teammate guidance:",
  "- You are a daemon teammate.",
  "- Your assignment is long-lived and remains active until the team shuts down.",
  "- Do not treat the first response as final completion.",
  "- Work in cycles: inspect, act, report, then wait when there is no useful work.",
  "- Use team_send_message to alert the lead when your assignment discovers something actionable.",
  "- Use team_get_messages at natural boundaries, not in a polling loop.",
  "- If your assignment requires periodic or external triggers, explain what trigger you need instead of inventing an unbounded loop.",
  "- Never mark yourself done unless explicitly cancelled or told the daemon assignment is over.",
  "- Do not claim that an issue is fixed, a feature is complete, or an action succeeded without supporting evidence.",
  "- Only report to me in ASD-STE100 Simplified Technical English.",
  "- Let perfect not be the enemy of good.",
].join("\n")

const TaskCompletionGuidance =
  "When your assigned work is complete, put the concrete result in your final answer so it can be sent back to the lead automatically."

const MemberTools = [
  "Available team tools (use these to coordinate with the team):",
  "- team_send_message: Send a message to the lead (recipient 'lead') or a specific teammate by name/session ID. Recipients are woken automatically.",
  "- team_get_messages: Read pending team mailbox messages addressed to you. Do not poll — check once and continue working.",
  "- team_broadcast: Send a message to all team members (lead and active teammates) at once. Recipients are woken automatically.",
  "- team_task_create: Create a shared team task with an optional assignee and dependency task IDs.",
  "- team_task_list: List all shared team tasks with their statuses and assignees.",
  "- team_task_claim: Claim a pending task as your own.",
  "- team_task_update: Update a task's status or assignee.",
].join("\n")

const MemberToolsPlan =
  "- team_plan_submit: Submit your plan to the lead for approval. You must do this before doing any implementation work."

const NestedTeamTools = {
  team_create: false,
  team_spawn: false,
  local_fusion: false,
}

function backgroundMetadata(row: SessionRow): BackgroundMetadata | undefined {
  const value = row.metadata?.[metadataKey]
  if (typeof value !== "object" || value === null) return
  const item = value as Record<string, unknown>
  if (
    item.kind !== "background-task" ||
    typeof item.generation !== "number" ||
    typeof item.parentSessionID !== "string" ||
    typeof item.description !== "string" ||
    typeof item.agent !== "string" ||
    typeof item.model !== "object" ||
    item.model === null ||
    typeof (item.model as Record<string, unknown>).providerID !== "string" ||
    typeof (item.model as Record<string, unknown>).modelID !== "string" ||
    typeof item.notifyParent !== "boolean" ||
    !["running", "completed", "error", "cancelled"].includes(String(item.state)) ||
    typeof item.promptMessageID !== "string" ||
    !["none", "pending", "delivering", "delivered"].includes(String(item.notification))
  )
    return
  return item as BackgroundMetadata
}

function memberMetadata(row: SessionRow): MemberMetadata | undefined {
  const value = row.metadata?.[memberMetadataKey]
  if (typeof value !== "object" || value === null) return
  const item = value as Record<string, unknown>
  if (
    item.kind !== "team-member" ||
    typeof item.memberID !== "string" ||
    typeof item.promptMessageID !== "string" ||
    !["running", "completed", "idle", "cancelled"].includes(String(item.state))
  )
    return
  return item as MemberMetadata
}

function withBackgroundMetadata(row: SessionRow, lifecycle: BackgroundMetadata) {
  return { ...(row.metadata ?? {}), [metadataKey]: lifecycle }
}

function withMemberMetadata(row: SessionRow, lifecycle: MemberMetadata) {
  return { ...(row.metadata ?? {}), [memberMetadataKey]: lifecycle }
}

function backgroundWatchKey(sessionID: string, generation: number) {
  return `${sessionID}:${generation}`
}

function memberMessageID(memberID: string, kind: "started" | "completed" | "idle" | "cancelled") {
  return `lifecycle:member:${memberID}:${kind}`
}

function memberRecipientID(messageID: string, recipient: string) {
  return `lifecycle:recipient:${messageID}:${recipient}`
}

function renderTaskOutput(input: {
  sessionID: string
  state: "completed" | "error"
  description: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    `<summary>Background task ${input.state}: ${input.description}</summary>`,
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

function messageData(info: SessionV1.Info) {
  const { id: _, sessionID: __, ...data } = info
  return data
}

function partData(part: SessionV1.Part) {
  const { id: _, messageID: __, sessionID: ___, ...data } = part
  return data
}

function partRowToPart(part: PartRow): SessionV1.Part {
  return {
    ...part.data,
    id: part.id,
    messageID: part.message_id,
    sessionID: part.session_id,
  } as SessionV1.Part
}

function activePause(db: QueryDatabase, sessionIDs: readonly string[]) {
  if (sessionIDs.length === 0) return Effect.succeed(false)
  return db
    .select({ sessionID: SessionPauseBlockerTable.session_id })
    .from(SessionPauseBlockerTable)
    .innerJoin(SessionPauseCascadeTable, eq(SessionPauseCascadeTable.id, SessionPauseBlockerTable.cascade_id))
    .where(
      and(
        inArray(
          SessionPauseBlockerTable.session_id,
          sessionIDs.map((sessionID) => SessionID.make(sessionID)),
        ),
        isNull(SessionPauseCascadeTable.time_released),
      ),
    )
    .limit(1)
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row !== undefined),
    )
}

function latestAssistant(db: DatabaseService, sessionID: string, parentID: string) {
  return db
    .select()
    .from(MessageTable)
    .where(eq(MessageTable.session_id, SessionID.make(sessionID)))
    .orderBy(MessageTable.time_created, MessageTable.id)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        for (let index = rows.length - 1; index >= 0; index--) {
          const row = rows[index]
          if (!row) continue
          const info = { ...row.data, id: row.id, sessionID: row.session_id } as SessionV1.Info
          if (info.role === "assistant" && info.parentID === parentID) return info
        }
        return undefined
      }),
    )
}

/** True when the failure is a pause suspension rather than a real error. */
function isSuspension(cause: Cause.Cause<unknown>) {
  return Option.getOrUndefined(Cause.findErrorOption(cause)) instanceof Runner.Suspended
}

export type AssistantResult =
  | { state: "error"; messageID: MessageID; text: string }
  | { state: "completed"; messageID: MessageID; text: string; valid: boolean }

/**
 * Canonical terminal-result extractor shared by live settlement and restart reconciliation.
 *
 * Returns `undefined` for a nonterminal assistant turn: no info, a non-assistant role, no finish
 * and no error, or a "tool-calls"/"unknown" finish (matching prompt.ts). An assistant error is a
 * failed attempt and yields the error text. Otherwise the parts (caller-supplied, already ordered
 * by PartTable.id ASC) keep only non-synthetic, non-ignored text parts, joined with "\n" and
 * trimmed once; a blank value marks the completed result invalid.
 */
export function assistantResult(
  info: SessionV1.Info | undefined,
  parts: readonly SessionV1.Part[] = [],
): AssistantResult | undefined {
  if (!info || info.role !== "assistant" || (!info.finish && !info.error)) return
  if (info.finish === "tool-calls" || info.finish === "unknown") return
  if (info.error) {
    const errorText =
      info.error && "message" in info.error.data && typeof info.error.data.message === "string"
        ? info.error.data.message
        : info.error?.name
    return { state: "error", messageID: info.id, text: errorText }
  }
  const text = parts
    .filter(
      (part): part is SessionV1.TextPart =>
        part.type === "text" && part.synthetic !== true && part.ignored !== true,
    )
    .map((part) => part.text)
    .join("\n")
    .trim()
  return { state: "completed", messageID: info.id, text, valid: text !== "" }
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly attach: (ops: PromptOps) => Effect.Effect<void>
  readonly reconcile: Effect.Effect<void>
  readonly isPaused: (sessionIDs: readonly string[]) => Effect.Effect<boolean>
  readonly startMember: (input: { memberID: string; ops: PromptOps }) => Effect.Effect<string>
  readonly cancelMember: (input: { memberID: string; ops: PromptOps }) => Effect.Effect<boolean>
  readonly registerBackground: (input: {
    sessionID: string
    parentSessionID: string
    description: string
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
    notifyParent: boolean
    ops: PromptOps
  }) => Effect.Effect<{ generation: number; promptMessageID: MessageID }>
  readonly promoteBackground: (sessionID: string, generation: number, ops: PromptOps) => Effect.Effect<void>
  readonly settleBackground: (input: {
    sessionID: string
    generation: number
    state: "completed" | "error"
    text: string
    ops: PromptOps
  }) => Effect.Effect<void>
  readonly watchBackground: (
    sessionID: string,
    generation: number,
    wait: Effect.Effect<{ info?: { status: string; output?: string; error?: string } }>,
    ops: PromptOps,
  ) => Effect.Effect<void>
  readonly cancelBackground: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LifecycleReconciler") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database
    const control = yield* SessionControl.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("LifecycleReconciler.state")(function* (ctx) {
        return {
          projectID: ctx.project.id,
          runningMembers: new Set<string>(),
          launchingBackground: new Set<string>(),
          watchedBackground: new Set<string>(),
          scope: yield* Scope.Scope,
          owner: crypto.randomUUID(),
          started: false,
          recovered: false,
        }
      }),
    )

    const setIntent = (sessionID: string, reason: SessionControl.ResumeReason) =>
      control.setResumeIntent({ sessionID: SessionID.make(sessionID), reason }).pipe(
        Effect.map((generation) => ({ sessionID: SessionID.make(sessionID), generation })),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )

    const wakeWithIntent = Effect.fn("LifecycleReconciler.wakeWithIntent")(function* (
      ops: PromptOps | undefined,
      sessionID: string,
      reason: SessionControl.ResumeReason,
    ) {
      const intent = yield* setIntent(sessionID, reason)
      if (!ops || (yield* activePause(db, [sessionID]))) return false
      const exit = yield* ops.wake(SessionID.make(sessionID)).pipe(Effect.exit)
      if (intent && Exit.isSuccess(exit)) yield* control.clearResumeIntent(intent)
      return Exit.isSuccess(exit)
    })

    const sendMemberMessage = (
      tx: WriteDatabase,
      input: {
        team: TeamRow
        member: TeamMemberRow
        kind: "started" | "completed" | "idle" | "cancelled"
        body: string
      },
    ) => {
      const id = memberMessageID(input.member.id, input.kind)
      const now = Date.now()
      return Effect.gen(function* () {
        yield* tx
          .insert(TeamMessageTable)
          .values({
            id,
            team_id: input.team.id,
            sender: input.member.session_id,
            recipients: [input.team.lead_session_id],
            body: input.body,
            delivery_status: "pending",
            time_created: now,
            time_updated: now,
          })
          .onConflictDoNothing()
          .run()
        yield* tx
          .insert(TeamMessageRecipientTable)
          .values({
            id: memberRecipientID(id, input.team.lead_session_id),
            message_id: id,
            team_id: input.team.id,
            recipient: input.team.lead_session_id,
            delivery_status: "pending",
            time_created: now,
            time_updated: now,
          })
          .onConflictDoNothing()
          .run()
      })
    }

    const dependencyResults = (members: TeamMemberRow[], dependencies: string[]) => {
      if (dependencies.length === 0) return ""
      return [
        "Dependency results:",
        ...dependencies.map((dependency) => {
          const match = members.find((member) => member.session_id === dependency)
          return [`- ${match?.name ?? dependency} (${dependency})`, match?.result ?? "(completed with no result)"].join(
            "\n",
          )
        }),
      ].join("\n")
    }

    const memberPrompt = (team: TeamRow, member: TeamMemberRow, members: TeamMemberRow[]) => {
      const teammates = members
        .filter((candidate) => candidate.session_id !== member.session_id)
        .map(
          (candidate) =>
            `- ${candidate.name} (${candidate.agent_type}, ${candidate.status}, session ${candidate.session_id})`,
        )
      const planTools = member.plan_mode ? `\n${MemberToolsPlan}` : ""
      return [
        `You are teammate "${member.name}" in team "${team.name}".`,
        `Team goal: ${team.goal}`,
        `The lead session is ${team.lead_session_id}. Your session is ${member.session_id}.`,
        MemberTools + planTools,
        teammates.length > 0
          ? ["Current teammates:", ...teammates].join("\n")
          : "No other teammates are registered yet.",
        CommunicationGuidance,
        member.lifecycle === "daemon" ? DaemonGuidance : TaskCompletionGuidance,
        dependencyResults(members, member.dependency_ids ?? []),
        member.role_prompt,
      ]
        .filter(Boolean)
        .join("\n\n")
    }

    const claimReadyDependents = Effect.fn("LifecycleReconciler.claimReadyDependents")(function* (teamID: string) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const team = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, teamID)).get()
              if (!team || team.status !== "active") return []
              const members = yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.team_id, teamID)).all()
              const completed = new Set(
                members
                  .filter((member) => member.status === "completed" && member.lifecycle !== "daemon")
                  .map((member) => member.session_id),
              )
              const candidates = members.filter(
                (member) =>
                  member.status === "blocked" &&
                  (member.dependency_ids ?? []).every((dependency) => completed.has(dependency)),
              )
              const claimed: string[] = []
              for (const member of candidates) {
                if (yield* activePause(tx, [team.lead_session_id, member.session_id])) continue
                const row = yield* tx
                  .update(TeamMemberTable)
                  .set({ status: "starting", time_updated: Date.now() })
                  .where(and(eq(TeamMemberTable.id, member.id), eq(TeamMemberTable.status, "blocked")))
                  .returning({ id: TeamMemberTable.id })
                  .get()
                if (row) claimed.push(row.id)
              }
              return claimed
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const settleMember = Effect.fn("LifecycleReconciler.settleMember")(function* (input: {
      memberID: string
      state: "completed" | "idle" | "cancelled"
      output: string
      error?: string
      promptMessageID?: string
      allowWhilePaused?: boolean
    }) {
      const settled = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const member = yield* tx
                .select()
                .from(TeamMemberTable)
                .where(eq(TeamMemberTable.id, input.memberID))
                .get()
              if (!member || terminalMemberStatuses.includes(member.status as (typeof terminalMemberStatuses)[number]))
                return undefined
              const team = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, member.team_id)).get()
              if (!team || team.status !== "active") return undefined
              const session = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(member.session_id)))
                .get()
              if (!session) return undefined
              const persisted = memberMetadata(session)
              if (
                input.promptMessageID &&
                persisted &&
                (persisted.memberID !== member.id || persisted.promptMessageID !== input.promptMessageID)
              )
                return undefined
              if (!input.allowWhilePaused && (yield* activePause(tx, [team.lead_session_id, member.session_id]))) {
                const promptMessageID = input.promptMessageID ?? persisted?.promptMessageID
                if (!promptMessageID) return undefined
                yield* tx
                  .update(SessionTable)
                  .set({
                    metadata: withMemberMetadata(session, {
                      kind: "team-member",
                      memberID: member.id,
                      promptMessageID,
                      state: input.state,
                      output: input.output,
                      ...(input.error ? { error: input.error } : {}),
                    }),
                    time_updated: Date.now(),
                  })
                  .where(eq(SessionTable.id, session.id))
                  .run()
                return { paused: true as const, team, member }
              }
              const now = Date.now()
              const update = yield* tx
                .update(TeamMemberTable)
                .set({
                  status: input.state,
                  result: input.state === "completed" ? input.output : member.result,
                  time_updated: now,
                  ...(member.lifecycle === "daemon"
                    ? {
                        daemon_state:
                          input.state === "idle"
                            ? ("idle" as const)
                            : input.error === "cancelled"
                              ? ("cancelled" as const)
                              : ("error" as const),
                        daemon_last_active: now,
                        daemon_error: input.error ?? null,
                      }
                    : {}),
                })
                .where(
                  and(
                    eq(TeamMemberTable.id, member.id),
                    notInArray(TeamMemberTable.status, [...terminalMemberStatuses]),
                  ),
                )
                .returning({ id: TeamMemberTable.id })
                .get()
              if (!update) return undefined
              const promptMessageID = input.promptMessageID ?? persisted?.promptMessageID
              if (promptMessageID) {
                yield* tx
                  .update(SessionTable)
                  .set({
                    metadata: withMemberMetadata(session, {
                      kind: "team-member",
                      memberID: member.id,
                      promptMessageID,
                      state: input.state,
                      output: input.output,
                      ...(input.error ? { error: input.error } : {}),
                    }),
                    time_updated: now,
                  })
                  .where(eq(SessionTable.id, session.id))
                  .run()
              }
              const kind = input.state
              const body =
                input.state === "completed"
                  ? [
                      `Teammate ${member.name} (${member.agent_type}) completed and returned this result:`,
                      "",
                      "<teammate_result>",
                      input.output || "(no text result)",
                      "</teammate_result>",
                    ].join("\n")
                  : input.state === "idle"
                    ? `Daemon teammate ${member.name} (${member.agent_type}) initialized and is idle.`
                    : `Teammate ${member.name} (${member.agent_type}) stopped before completing: ${input.error ?? "cancelled"}`
              yield* sendMemberMessage(tx, { team, member, kind, body })
              return { paused: false as const, team, member }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (!settled) return false
      if (settled.paused) {
        yield* setIntent(settled.team.lead_session_id, "team-wake")
        return false
      }
      const current = yield* InstanceState.get(state)
      if (input.state === "completed") {
        const claimed = yield* claimReadyDependents(settled.team.id)
        if (current.ops) {
          yield* Effect.forEach(
            claimed,
            (memberID) => startMember({ memberID, ops: current.ops! }).pipe(Effect.forkIn(current.scope)),
            { discard: true },
          )
        }
      }
      yield* wakeWithIntent(current.ops, settled.team.lead_session_id, "team-wake")
      return true
    })

    const prepareMember = Effect.fn("LifecycleReconciler.prepareMember")(function* (memberID: string) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const member = yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.id, memberID)).get()
              if (!member || terminalMemberStatuses.includes(member.status as (typeof terminalMemberStatuses)[number]))
                return { action: "terminal" as const }
              const team = yield* tx.select().from(TeamTable).where(eq(TeamTable.id, member.team_id)).get()
              if (!team || team.status !== "active") return { action: "terminal" as const }
              if (yield* activePause(tx, [team.lead_session_id, member.session_id])) {
                return { action: "paused" as const, member, team }
              }
              const members = yield* tx.select().from(TeamMemberTable).where(eq(TeamMemberTable.team_id, team.id)).all()
              const dependencies = member.dependency_ids ?? []
              const ready = dependencies.every((dependency) =>
                members.some(
                  (candidate) =>
                    candidate.session_id === dependency &&
                    candidate.status === "completed" &&
                    candidate.lifecycle !== "daemon",
                ),
              )
              if (!ready) {
                if (member.status !== "blocked") {
                  yield* tx
                    .update(TeamMemberTable)
                    .set({ status: "blocked", time_updated: Date.now() })
                    .where(eq(TeamMemberTable.id, member.id))
                    .run()
                }
                return { action: "blocked" as const }
              }
              const session = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(member.session_id)))
                .get()
              if (!session) return { action: "terminal" as const }
              const persisted = memberMetadata(session)
              if (persisted?.memberID === member.id && persisted.state !== "running") {
                return { action: "settle" as const, member, lifecycle: persisted }
              }
              if (member.status === "blocked") {
                const claim = yield* tx
                  .update(TeamMemberTable)
                  .set({ status: "starting", time_updated: Date.now() })
                  .where(and(eq(TeamMemberTable.id, member.id), eq(TeamMemberTable.status, "blocked")))
                  .returning({ id: TeamMemberTable.id })
                  .get()
                if (!claim) return { action: "terminal" as const }
              }
              const promptID =
                persisted?.memberID === member.id && persisted.promptMessageID
                  ? MessageID.make(persisted.promptMessageID)
                  : // Message IDs must stay monotonic; restart safety comes from persisting the
                    // generated ID in session metadata below.
                    MessageID.ascending()
              const existing = yield* tx
                .select({ id: MessageTable.id })
                .from(MessageTable)
                .where(
                  and(eq(MessageTable.id, promptID), eq(MessageTable.session_id, SessionID.make(member.session_id))),
                )
                .get()

              const activated = yield* tx
                .update(TeamMemberTable)
                .set({
                  status: "active",
                  time_updated: Date.now(),
                  ...(member.lifecycle === "daemon"
                    ? { daemon_state: "running" as const, daemon_last_active: Date.now(), daemon_error: null }
                    : {}),
                })
                .where(
                  and(
                    eq(TeamMemberTable.id, member.id),
                    notInArray(TeamMemberTable.status, [...terminalMemberStatuses]),
                  ),
                )
                .returning({ id: TeamMemberTable.id })
                .get()
              if (!activated) return { action: "terminal" as const }
              yield* tx
                .update(SessionTable)
                .set({
                  metadata: withMemberMetadata(session, {
                    kind: "team-member",
                    memberID: member.id,
                    promptMessageID: promptID,
                    state: "running",
                  }),
                  time_updated: Date.now(),
                })
                .where(eq(SessionTable.id, session.id))
                .run()
              yield* sendMemberMessage(tx, {
                team,
                member,
                kind: "started",
                body: [
                  `Teammate ${member.name} (${member.agent_type}) started.`,
                  "",
                  "Assignment:",
                  member.role_prompt,
                  ...(dependencies.length > 0
                    ? ["", "Dependency context was provided in this teammate's prompt."]
                    : []),
                ].join("\n"),
              })
              return {
                action: existing ? ("resume" as const) : ("prompt" as const),
                member,
                team,
                members,
                promptMessageID: promptID,
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const startMember: Interface["startMember"] = Effect.fn("LifecycleReconciler.startMember")(function* (input) {
      const current = yield* InstanceState.get(state)
      current.ops = input.ops
      if (current.runningMembers.has(input.memberID)) return "Teammate is already running."
      current.runningMembers.add(input.memberID)
      return yield* Effect.gen(function* () {
        const prepared = yield* prepareMember(input.memberID)
        if (prepared.action === "terminal") return "Teammate is already in a terminal state."
        if (prepared.action === "blocked") return "Teammate is waiting for dependencies."
        if (prepared.action === "settle") {
          yield* settleMember({
            memberID: prepared.member.id,
            state: prepared.lifecycle.state as Exclude<MemberMetadata["state"], "running">,
            output: prepared.lifecycle.output ?? "",
            error: prepared.lifecycle.error,
            promptMessageID: prepared.lifecycle.promptMessageID,
          })
          return prepared.lifecycle.output ?? prepared.lifecycle.error ?? "Teammate settlement restored."
        }
        if (prepared.action === "paused") {
          yield* setIntent(prepared.member.session_id, "team-wake")
          return "Teammate is suspended and will resume after the pause is released."
        }
        if (!prepared.member.model) {
          yield* settleMember({
            memberID: prepared.member.id,
            state: "cancelled",
            output: "",
            error: "missing persisted model",
            promptMessageID: prepared.promptMessageID,
          })
          return "Teammate stopped before starting: missing persisted model."
        }
        const model = prepared.member.model
        const result = yield* Effect.gen(function* () {
          // `run` awaits the loop. `wake` must never be used here: it returns as soon as work is
          // scheduled, so its value would settle the member against a stale turn.
          if (prepared.action === "resume") return yield* input.ops.run(SessionID.make(prepared.member.session_id))
          const parts = yield* input.ops.resolvePromptParts(
            memberPrompt(prepared.team, prepared.member, prepared.members),
          )
          return yield* input.ops.prompt({
            messageID: prepared.promptMessageID,
            sessionID: SessionID.make(prepared.member.session_id),
            model: {
              providerID: ProviderV2.ID.make(model.providerID),
              modelID: ModelV2.ID.make(model.modelID),
            },
            variant: model.variant,
            agent: prepared.member.agent_type,
            tools: {
              ...NestedTeamTools,
              ...(prepared.member.plan_mode ? { bash: false, write: false, edit: false, apply_patch: false } : {}),
            },
            parts,
          })
        }).pipe(Effect.exit)
        if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause)) return yield* Effect.interrupt
        // Suspension is not an outcome. The member keeps its status and its durable resume intent,
        // so a later start resumes it instead of finding a cancelled teammate.
        if (Exit.isFailure(result) && isSuspension(result.cause)) {
          yield* setIntent(prepared.member.session_id, "running")
          return "Teammate is suspended and will resume after the pause is released."
        }
        if (Exit.isFailure(result)) {
          const error = Cause.squash(result.cause)
          const message = error instanceof Error ? error.message : String(error)
          yield* settleMember({
            memberID: prepared.member.id,
            state: "cancelled",
            output: "",
            error: message,
            promptMessageID: prepared.promptMessageID,
          })
          return message
        }
        const terminal = assistantResult(result.value.info, result.value.parts)
        // A nonterminal turn (for example a "tool-calls" finish) is not a fact to settle on; the
        // member keeps its active status so a later reconcile resumes the run.
        if (!terminal) return "Teammate did not finish."
        const output = terminal.text
        yield* settleMember({
          memberID: prepared.member.id,
          state: terminal.state === "error" ? "cancelled" : prepared.member.lifecycle === "daemon" ? "idle" : "completed",
          output,
          error: terminal.state === "error" ? output : undefined,
          promptMessageID: prepared.promptMessageID,
        })

        return output || (prepared.member.lifecycle === "daemon" ? "Daemon teammate initialized." : "(no text result)")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            current.runningMembers.delete(input.memberID)
          }),
        ),
      )
    })

    const registerBackground: Interface["registerBackground"] = Effect.fn("LifecycleReconciler.registerBackground")(
      function* (input) {
        const current = yield* InstanceState.get(state)
        current.ops = input.ops
        const registration = yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .select()
                  .from(SessionTable)
                  .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
                  .get()
                if (!row) return yield* Effect.die(new Error(`Background session not found: ${input.sessionID}`))
                const previous = backgroundMetadata(row)
                const generation = (previous?.generation ?? 0) + 1
                // Message IDs must stay monotonic, because the prompt loop and the latest-user
                // lookup both order messages by ID. Restart safety comes from persisting the
                // generated ID in session metadata, not from a derived constant ID.
                const promptMessageID = MessageID.ascending()

                const lifecycle: BackgroundMetadata = {
                  kind: "background-task",
                  generation,
                  promptMessageID,
                  parentSessionID: input.parentSessionID,
                  description: input.description,
                  agent: input.agent,
                  model: input.model,
                  ...(input.variant ? { variant: input.variant } : {}),
                  notifyParent:
                    previous?.state === "running" ? previous.notifyParent || input.notifyParent : input.notifyParent,
                  state: "running",
                  notification: "none",
                }
                yield* tx
                  .update(SessionTable)
                  .set({ metadata: withBackgroundMetadata(row, lifecycle), time_updated: Date.now() })
                  .where(eq(SessionTable.id, row.id))
                  .run()
                return { generation, promptMessageID }
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        current.launchingBackground.add(backgroundWatchKey(input.sessionID, registration.generation))
        return registration
      },
    )

    const promoteBackground: Interface["promoteBackground"] = Effect.fn("LifecycleReconciler.promoteBackground")(
      function* (sessionID, generation, ops) {
        const current = yield* InstanceState.get(state)
        current.ops = ops
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .select()
                  .from(SessionTable)
                  .where(eq(SessionTable.id, SessionID.make(sessionID)))
                  .get()
                if (!row) return
                const lifecycle = backgroundMetadata(row)
                if (
                  !lifecycle ||
                  lifecycle.generation !== generation ||
                  lifecycle.state !== "running" ||
                  lifecycle.notifyParent
                )
                  return
                yield* tx
                  .update(SessionTable)
                  .set({
                    metadata: withBackgroundMetadata(row, { ...lifecycle, notifyParent: true }),
                    time_updated: Date.now(),
                  })
                  .where(eq(SessionTable.id, row.id))
                  .run()
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      },
    )

    const deliverBackgroundNotification = Effect.fn("LifecycleReconciler.deliverBackgroundNotification")(function* (
      sessionID: string,
      generation: number,
      ops?: PromptOps,
    ) {
      const current = yield* InstanceState.get(state)
      const token = `${current.owner}:${crypto.randomUUID()}`
      const claimed = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(sessionID)))
                .get()
              if (!row) return
              const lifecycle = backgroundMetadata(row)
              if (
                !lifecycle ||
                lifecycle.generation !== generation ||
                lifecycle.notification !== "pending" ||
                (lifecycle.state !== "completed" && lifecycle.state !== "error")
              )
                return
              if (yield* activePause(tx, [row.id, lifecycle.parentSessionID])) return { paused: lifecycle }
              const parent = yield* tx
                .select({ id: SessionTable.id })
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(lifecycle.parentSessionID)))
                .get()
              if (!parent) return
              // Allocate the notification IDs once and keep them. A retry after a crash reuses them,
              // so the conflict-free insert below can never duplicate the injected result.
              const messageID = lifecycle.notificationMessageID
                ? MessageID.make(lifecycle.notificationMessageID)
                : MessageID.ascending()
              const partID = lifecycle.notificationPartID
                ? PartID.make(lifecycle.notificationPartID)
                : PartID.ascending()
              const next: BackgroundMetadata = {
                ...lifecycle,
                notification: "delivering",
                deliveryToken: token,
                notificationMessageID: messageID,
                notificationPartID: partID,
              }
              // Claim first. Only the transaction that wins this compare-and-set may write the
              // notification message, so concurrent reconcilers cannot inject a duplicate result.
              const update = yield* tx
                .update(SessionTable)
                .set({ metadata: withBackgroundMetadata(row, next), time_updated: Date.now() })
                .where(
                  and(
                    eq(SessionTable.id, row.id),
                    sql`json_extract(${SessionTable.metadata}, '$.${sql.raw(metadataKey)}.notification') = 'pending'`,
                    sql`json_extract(${SessionTable.metadata}, '$.${sql.raw(metadataKey)}.generation') = ${generation}`,
                  ),
                )
                .returning({ id: SessionTable.id })
                .get()
              if (!update) return
              const message: SessionV1.User = {
                id: messageID,
                sessionID: SessionID.make(lifecycle.parentSessionID),
                role: "user",
                time: { created: Date.now() },
                agent: lifecycle.agent,
                model: {
                  providerID: ProviderV2.ID.make(lifecycle.model.providerID),
                  modelID: ModelV2.ID.make(lifecycle.model.modelID),
                  ...(lifecycle.variant ? { variant: lifecycle.variant } : {}),
                },
              }
              const text = lifecycle.state === "completed" ? (lifecycle.output ?? "") : (lifecycle.error ?? "")
              const part: SessionV1.TextPart = {
                id: partID,
                messageID,
                sessionID: message.sessionID,
                type: "text",
                synthetic: true,
                text: renderTaskOutput({
                  sessionID: row.id,
                  state: lifecycle.state,
                  description: lifecycle.description,
                  text,
                }),
              }

              yield* tx
                .insert(MessageTable)
                .values({
                  id: message.id,
                  session_id: message.sessionID,
                  time_created: message.time.created,
                  data: messageData(message),
                })
                .onConflictDoNothing()
                .run()
              yield* tx
                .insert(PartTable)
                .values({
                  id: part.id,
                  message_id: part.messageID,
                  session_id: part.sessionID,
                  time_created: Date.now(),
                  data: partData(part),
                })
                .onConflictDoNothing()
                .run()
              return { lifecycle: next }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (claimed?.paused) {
        yield* setIntent(claimed.paused.parentSessionID, "background-result")
        return false
      }
      if (!claimed?.lifecycle) return false
      const delivered = yield* wakeWithIntent(ops, claimed.lifecycle.parentSessionID, "background-result")
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(sessionID)))
                .get()
              if (!row) return
              const lifecycle = backgroundMetadata(row)
              if (
                !lifecycle ||
                lifecycle.generation !== generation ||
                lifecycle.notification !== "delivering" ||
                lifecycle.deliveryToken !== token
              )
                return
              const { deliveryToken: _, ...withoutToken } = lifecycle
              yield* tx
                .update(SessionTable)
                .set({
                  metadata: withBackgroundMetadata(row, {
                    ...withoutToken,
                    notification: delivered ? "delivered" : "pending",
                  }),
                  time_updated: Date.now(),
                })
                .where(eq(SessionTable.id, row.id))
                .run()
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      return delivered
    })

    const settleBackgroundOnce = Effect.fn("LifecycleReconciler.settleBackgroundOnce")(function* (input: {
      sessionID: string
      generation: number
      state: "completed" | "error"
      text: string
      ops?: PromptOps
    }) {
      const settled = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.id, SessionID.make(input.sessionID)))
                .get()
              if (!row) return { state: "missing" as const }
              const lifecycle = backgroundMetadata(row)
              if (!lifecycle) return { state: "missing" as const }
              if (lifecycle.generation !== input.generation) return { state: "stale" as const }
              if (lifecycle.state !== "running") return { state: "terminal" as const, lifecycle }
              const next: BackgroundMetadata = {
                ...lifecycle,
                state: input.state,
                ...(input.state === "completed" ? { output: input.text } : { error: input.text }),
                notification: lifecycle.notifyParent ? "pending" : "none",
              }
              yield* tx
                .update(SessionTable)
                .set({ metadata: withBackgroundMetadata(row, next), time_updated: Date.now() })
                .where(eq(SessionTable.id, row.id))
                .run()
              return { state: "settled" as const, lifecycle: next }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      if (settled.state === "settled" && settled.lifecycle.notifyParent)
        yield* deliverBackgroundNotification(input.sessionID, input.generation, input.ops)
      return "settled" as const
    })

    const settleBackground: Interface["settleBackground"] = Effect.fn("LifecycleReconciler.settleBackground")(
      function* (input) {
        const current = yield* InstanceState.get(state)
        current.ops = input.ops
        yield* settleBackgroundOnce(input)
      },
    )

    const cancelBackground: Interface["cancelBackground"] = Effect.fn("LifecycleReconciler.cancelBackground")(
      function* (sessionID) {
        if (!sessionID.startsWith("ses")) return
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const row = yield* tx
                  .select()
                  .from(SessionTable)
                  .where(eq(SessionTable.id, SessionID.make(sessionID)))
                  .get()
                if (!row) return
                const lifecycle = backgroundMetadata(row)
                if (!lifecycle || lifecycle.state !== "running") return
                yield* tx
                  .update(SessionTable)
                  .set({
                    metadata: withBackgroundMetadata(row, { ...lifecycle, state: "cancelled", notification: "none" }),
                    time_updated: Date.now(),
                  })
                  .where(eq(SessionTable.id, row.id))
                  .run()
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
      },
    )

    const watchBackground: Interface["watchBackground"] = Effect.fn("LifecycleReconciler.watchBackground")(
      function* (sessionID, generation, wait, ops) {
        const current = yield* InstanceState.get(state)
        current.ops = ops
        const key = backgroundWatchKey(sessionID, generation)
        current.launchingBackground.delete(key)
        if (current.watchedBackground.has(key)) return
        current.watchedBackground.add(key)
        yield* wait.pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") {
              return settleBackground({
                sessionID,
                generation,
                state: "completed",
                text: result.info.output ?? "",
                ops,
              })
            }
            if (result.info?.status === "error") {
              return settleBackground({
                sessionID,
                generation,
                state: "error",
                text: result.info.error ?? "Background task failed",
                ops,
              })
            }
            return Effect.void
          }),
          Effect.ensuring(
            Effect.sync(() => {
              current.watchedBackground.delete(key)
            }),
          ),
          Effect.forkIn(current.scope, { startImmediately: true }),
        )
      },
    )

    const cancelMember: Interface["cancelMember"] = Effect.fn("LifecycleReconciler.cancelMember")(function* (input) {
      const member = yield* db
        .select()
        .from(TeamMemberTable)
        .where(eq(TeamMemberTable.id, input.memberID))
        .get()
        .pipe(Effect.orDie)
      if (!member) return false
      const settled = yield* settleMember({
        memberID: member.id,
        state: "cancelled",
        output: "",
        error: "cancelled",
        allowWhilePaused: true,
      })
      if (settled) yield* input.ops.cancel(SessionID.make(member.session_id)).pipe(Effect.ignore)
      return settled
    })

    const reconcile: Interface["reconcile"] = Effect.gen(function* () {
      const current = yield* InstanceState.get(state)
      const sessions = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.project_id, current.projectID))
        .all()
        .pipe(Effect.orDie)
      const sessionIDs = new Set(sessions.map((session) => session.id))
      const sessionsByID = new Map(sessions.map((session) => [session.id, session]))
      const members = (yield* db.select().from(TeamMemberTable).all().pipe(Effect.orDie)).filter((member) =>
        sessionIDs.has(SessionID.make(member.session_id)),
      )
      for (const member of members) {
        if (terminalMemberStatuses.includes(member.status as (typeof terminalMemberStatuses)[number])) continue
        const persisted = sessionsByID.get(SessionID.make(member.session_id))
        const fact = persisted ? memberMetadata(persisted) : undefined
        if (fact?.memberID === member.id && fact.state !== "running") {
          yield* settleMember({
            memberID: member.id,
            state: fact.state,
            output: fact.output ?? "",
            error: fact.error,
            promptMessageID: fact.promptMessageID,
          })
          continue
        }
        const promptMessageID = fact?.promptMessageID
        const info = promptMessageID ? yield* latestAssistant(db, member.session_id, promptMessageID) : undefined
        const terminal = info ? assistantResult(info) : undefined
        if (terminal && member.status === "active") {
          const parts = yield* db
            .select()
            .from(PartTable)
            .where(eq(PartTable.message_id, terminal.messageID))
            .orderBy(PartTable.id)
            .all()
            .pipe(Effect.orDie, Effect.map((rows) => rows.map(partRowToPart)))
          const text = assistantResult(info, parts)?.text ?? ""
          yield* settleMember({
            memberID: member.id,
            state: terminal.state === "error" ? "cancelled" : member.lifecycle === "daemon" ? "idle" : "completed",
            output: text,
            error: terminal.state === "error" ? text : undefined,
            promptMessageID,
          })
          continue
        }
        if (
          (member.status === "starting" || member.status === "blocked" || member.status === "active") &&
          current.ops
        ) {
          yield* startMember({ memberID: member.id, ops: current.ops }).pipe(Effect.forkIn(current.scope))
        }
      }
      for (const session of sessions) {
        const lifecycle = backgroundMetadata(session)
        if (!lifecycle) continue
        if (lifecycle.state === "running") {
          const info = yield* latestAssistant(db, session.id, lifecycle.promptMessageID)
          const terminal = info ? assistantResult(info) : undefined
          if (terminal) {
            const parts = yield* db
              .select()
              .from(PartTable)
              .where(eq(PartTable.message_id, terminal.messageID))
              .orderBy(PartTable.id)
              .all()
              .pipe(Effect.orDie, Effect.map((rows) => rows.map(partRowToPart)))
            const text = assistantResult(info, parts)?.text ?? ""
            yield* settleBackgroundOnce({
              sessionID: session.id,
              generation: lifecycle.generation,
              state: terminal.state,
              text,
              ops: current.ops,
            })
          } else if (
            current.ops &&
            !current.launchingBackground.has(backgroundWatchKey(session.id, lifecycle.generation)) &&
            !current.watchedBackground.has(backgroundWatchKey(session.id, lifecycle.generation))
          ) {
            // A paused background task must keep its running state and a durable resume intent.
            // Without this gate the resume attempt fails with suspension and marks the task errored.
            if (yield* activePause(db, [session.id, lifecycle.parentSessionID])) {
              yield* setIntent(session.id, "running")
              continue
            }
            const ops = current.ops
            const key = backgroundWatchKey(session.id, lifecycle.generation)
            current.watchedBackground.add(key)
            yield* ops.run(SessionID.make(session.id)).pipe(
              Effect.flatMap((result) =>
                settleBackground({
                  sessionID: session.id,
                  generation: lifecycle.generation,
                  state: "completed",
                  text: assistantResult(result.info, result.parts)?.text ?? "",
                  ops,
                }),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause) || isSuspension(cause)
                  ? setIntent(session.id, "running").pipe(Effect.asVoid)
                  : settleBackground({
                      sessionID: session.id,
                      generation: lifecycle.generation,
                      state: "error",
                      text: (() => {
                        const error = Cause.squash(cause)
                        return error instanceof Error ? error.message : String(error)
                      })(),
                      ops,
                    }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  current.watchedBackground.delete(key)
                }),
              ),
              Effect.forkIn(current.scope, { startImmediately: true }),
            )
          }

          continue
        }
        if (lifecycle.notification === "pending")
          yield* deliverBackgroundNotification(session.id, lifecycle.generation, current.ops)
      }
    }).pipe(Effect.withSpan("LifecycleReconciler.reconcile"))

    const recoverDeliveries = Effect.fn("LifecycleReconciler.recoverDeliveries")(function* () {
      const current = yield* InstanceState.get(state)
      if (current.recovered) return
      yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const sessions = yield* tx
                .select()
                .from(SessionTable)
                .where(eq(SessionTable.project_id, current.projectID))
                .all()
              for (const session of sessions) {
                const lifecycle = backgroundMetadata(session)
                if (lifecycle?.notification !== "delivering") continue
                const { deliveryToken: _, ...withoutToken } = lifecycle
                yield* tx
                  .update(SessionTable)
                  .set({
                    metadata: withBackgroundMetadata(session, { ...withoutToken, notification: "pending" }),
                    time_updated: Date.now(),
                  })
                  .where(eq(SessionTable.id, session.id))
                  .run()
              }
              // A mailbox row moves to "read" while it is claimed but not yet acknowledged inside a
              // prompt turn. A crash between the claim and the acknowledgement would strand the row
              // forever, so every claim left over from a previous process returns to "pending".
              const recipients = sessions.map((session) => String(session.id))
              for (const batch of chunk(recipients)) {
                yield* tx
                  .update(TeamMessageRecipientTable)
                  .set({ delivery_status: "pending", time_updated: Date.now() })
                  .where(
                    and(
                      inArray(TeamMessageRecipientTable.recipient, batch),
                      eq(TeamMessageRecipientTable.delivery_status, "read"),
                    ),
                  )
                  .run()
              }
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      current.recovered = true
    })

    const init: Interface["init"] = Effect.fn("LifecycleReconciler.init")(function* () {
      const current = yield* InstanceState.get(state)
      if (current.started) return
      yield* recoverDeliveries()
      current.started = true
      yield* reconcile.pipe(
        Effect.catchCause((cause) => Effect.logWarning("lifecycle reconciliation failed", { cause })),
        Effect.repeat(Schedule.spaced(pollInterval)),
        Effect.forkIn(current.scope, { startImmediately: true }),
      )
    })

    const attach: Interface["attach"] = Effect.fn("LifecycleReconciler.attach")(function* (ops) {
      const current = yield* InstanceState.get(state)
      current.ops = ops
      yield* init()
      yield* reconcile.pipe(Effect.ignore, Effect.forkIn(current.scope, { startImmediately: true }))
    })

    return Service.of({
      init,
      attach,
      reconcile,
      isPaused: (sessionIDs) => activePause(db, sessionIDs),
      startMember,
      cancelMember,
      registerBackground,
      promoteBackground,
      settleBackground,
      watchBackground,
      cancelBackground,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionControl.defaultLayer), Layer.provide(Database.defaultLayer))

export * as LifecycleReconciler from "./lifecycle-reconciler"
