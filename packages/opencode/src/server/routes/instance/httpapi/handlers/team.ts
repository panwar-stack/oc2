import { TeamEval } from "@/team/eval"
import { Team } from "@/team/team"
import { MemberProcessRegistry } from "@/team/member-process-registry"
import { TeamMemberTable } from "@/team/team.sql"
import { Session } from "@/session/session"
import { LifecycleReconciler } from "@/session/lifecycle-reconciler"
import { SessionID } from "@/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@oc2-ai/core/event"
import { Database } from "@oc2-ai/core/database/database"
import { Log } from "@oc2-ai/core/util/log"
import * as InstanceState from "@/effect/instance-state"
import { and, eq } from "drizzle-orm"
import { Effect, Option, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { InstanceHttpApi } from "../api"
import { ReplayPayload } from "../groups/sync"
import {
  TeamPlanPayload,
  TeamResultPayload,
  TeamSendMessagePayload,
  TeamTaskUpdatePayload,
  TeamTranscriptSyncResultSchema,
  TeamRequestError,
  TeamHeartbeatPayload,
  TeamHeartbeatResultSchema,
  TeamMemberResultSchema,
} from "../groups/team"

const log = Log.create({ service: "server.team" })

const teamRequestError = (message: string) =>
  new TeamRequestError({
    name: "TeamRequestError",
    data: { message },
  })

const toMemberModel = (model: Team.Member["model"]) =>
  model == null
    ? null
    : {
        provider_id: model.providerID,
        model_id: model.modelID,
        ...(model.variant != null ? { variant: model.variant } : {}),
      }

const toMember = (member: Team.Member) => ({
  id: member.id,
  team_id: member.team_id,
  session_id: member.session_id,
  name: member.name,
  agent_type: member.agent_type,
  model: toMemberModel(member.model),
  role_prompt: member.role_prompt,
  status: member.status,
  lifecycle: member.lifecycle,
  daemon_state: member.daemon_state,
  daemon_last_active: member.daemon_last_active,
  daemon_error: member.daemon_error,
  plan_mode: member.plan_mode,
  work_mode: member.work_mode,
  dependency_ids: member.dependency_ids ?? null,
  result: member.result ?? null,
  time_created: member.time_created,
  time_updated: member.time_updated,
})

const toTask = (task: Team.Task) => ({
  id: task.id,
  team_id: task.team_id,
  description: task.description,
  status: task.status,
  ...(task.assignee == null ? {} : { assignee: task.assignee }),
  ...(task.dependency_ids == null ? {} : { dependency_ids: [...task.dependency_ids] }),
  ...(task.metadata == null ? {} : { metadata: task.metadata }),
  owned_paths: task.owned_paths,
  handoff: task.handoff,
  time_created: task.time_created,
  time_updated: task.time_updated,
})

const toMessage = (message: Team.Message) => ({
  id: message.id,
  team_id: message.team_id,
  sender: message.sender,
  recipients: [...message.recipients],
  body: message.body,
  delivery_status: message.delivery_status,
  time_created: message.time_created,
  time_updated: message.time_updated,
})

export const teamHandlers = HttpApiBuilder.group(InstanceHttpApi, "team", (handlers) =>
  Effect.gen(function* () {
    const team = yield* Team.Service
    const session = yield* Session.Service
    const reconciler = yield* LifecycleReconciler.Service

    const getBySession = Effect.fn("TeamHttpApi.getBySession")(function* (ctx: { query: { sessionID: string } }) {
      const result = yield* team.getByLeadSession(ctx.query.sessionID)
      if (Option.isNone(result)) {
        return yield* new HttpApiError.BadRequest({})
      }
      return result.value
    })

    const requireTeamAccess = Effect.fn("TeamHttpApi.requireTeamAccess")(function* (teamID: string, sessionID: string) {
      const result = yield* team.get(teamID)
      if (Option.isNone(result)) {
        return yield* new HttpApiError.BadRequest({})
      }
      if (result.value.lead_session_id === sessionID) return result.value
      const members = yield* team.getMembers(teamID)
      if (members.some((member) => member.session_id === sessionID)) return result.value
      return yield* new HttpApiError.BadRequest({})
    })

    /** Loads a team and fails with the declared transport error when absent/inactive. */
    const requireActiveTeam = Effect.fn("TeamHttpApi.requireActiveTeam")(function* (teamID: string) {
      const result = yield* team.get(teamID)
      if (Option.isNone(result) || result.value.status !== "active") {
        return yield* teamRequestError(`Team not found or not active: ${teamID}`)
      }
      return result.value
    })

    /** Rejects a caller that is neither the team lead nor a member of the team. */
    const requireTeamParticipant = Effect.fn("TeamHttpApi.requireTeamParticipant")(function* (
      teamID: string,
      sessionID: string,
    ) {
      const result = yield* team.get(teamID)
      if (Option.isNone(result)) return yield* teamRequestError(`Team not found: ${teamID}`)
      if (result.value.lead_session_id === sessionID) return result.value
      const members = yield* team.getMembers(teamID)
      if (members.some((member) => member.session_id === sessionID)) return result.value
      return yield* teamRequestError(`Caller is not a participant of team ${teamID}`)
    })

    /** Loads a team member by session and fails when it is not in teamID. */
    const requireMemberOf = Effect.fn("TeamHttpApi.requireMemberOf")(function* (teamID: string, sessionID: string) {
      const member = yield* team.getMemberBySession(sessionID)
      if (Option.isNone(member)) return yield* teamRequestError(`No team member for session ${sessionID}`)
      if (member.value.team_id !== teamID) {
        return yield* teamRequestError(`Member ${sessionID} does not belong to team ${teamID}`)
      }
      return member.value
    })

    const getByTeam = Effect.fn("TeamHttpApi.getByTeam")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
    }) {
      const result = yield* requireTeamAccess(ctx.params.teamID, ctx.query.sessionID)
      return result
    })

    const getTasks = Effect.fn("TeamHttpApi.getTasks")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
    }) {
      yield* requireTeamAccess(ctx.params.teamID, ctx.query.sessionID)
      return (yield* team.getTasks(ctx.params.teamID)).map(toTask)
    })

    const getMessages = Effect.fn("TeamHttpApi.getMessages")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
    }) {
      yield* requireTeamAccess(ctx.params.teamID, ctx.query.sessionID)
      return (yield* team.getMessages(ctx.params.teamID)).map(toMessage)
    })

    const getEval = Effect.fn("TeamHttpApi.getEval")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
    }) {
      yield* requireTeamAccess(ctx.params.teamID, ctx.query.sessionID)
      return yield* TeamEval.build(ctx.params.teamID).pipe(
        Effect.catchTag("TeamEval.NotFoundError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
    })

    const shutdown = Effect.fn("TeamHttpApi.shutdown")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string; force?: string; reason?: string }
    }) {
      // Shutdown is lead-only. Unlike the read endpoints (requireTeamAccess), a member session
      // must not be able to close the team.
      const teamInfo = yield* team.get(ctx.params.teamID)
      if (Option.isNone(teamInfo) || teamInfo.value.lead_session_id !== ctx.query.sessionID) {
        return yield* new HttpApiError.BadRequest({})
      }
      // The Team.shutdown service terminates in-process member fibers through SessionRunState
      // cancel. Remote member OS processes additionally need a signal: this lead process tracks
      // the children it spawned in MemberProcessRegistry and best-effort terminates them after the
      // durable close commits. The registry is empty when the multi-process flag is off, so this
      // is a no-op by default. A member running on another VM has no local handle here and exits
      // through its `team.closed` SSE event; remote kill is intentionally not attempted.
      const result = yield* team
        .shutdown({
          teamID: ctx.params.teamID,
          sessionID: ctx.query.sessionID,
          force: ctx.query.force === "true",
          reason: ctx.query.reason,
        })
        .pipe(
          Effect.catch((error) => {
            if (
              error instanceof Team.ShutdownNotAuthorized ||
              error instanceof Team.ShutdownAlreadyClosed ||
              error instanceof Team.ShutdownFinalReportRequired ||
              error instanceof Team.ShutdownReasonRequired
            ) {
              return Effect.fail(new HttpApiError.BadRequest({}))
            }
            return Effect.die(error)
          }),
        )
      // After the durable close and the session-run cancellations succeed, signal the local
      // member children. Best-effort only: a failed kill leaves the child to observe team.closed.
      const members = yield* team.getMembers(ctx.params.teamID)
      // Best-effort kill is observable: the count tells the operator how many local children
      // received SIGTERM. Remote members are not counted because they have no local handle.
      const terminated = MemberProcessRegistry.terminateMany(members.map((member) => member.session_id))
      log.debug("team shutdown terminated local member processes", {
        teamID: ctx.params.teamID,
        terminated,
      })
      return {
        team_id: ctx.params.teamID,
        cancelled_members: result.cancelledMembers,
        cancelled_tasks: result.cancelledTasks,
        released_reservations: result.releasedReservations,
        session_cancellation_failures: result.sessionCancellationFailures,
      }
    })

    /** Reads the member session transcript. Returns messages strictly older than
     * `messageID` when given, otherwise the most recent messages in ascending order. */
    const loadTranscript = Effect.fn("TeamHttpApi.loadTranscript")(function* (
      sessionID: string,
      messageID: string | undefined,
    ) {
      const id = SessionID.make(sessionID)
      if (!messageID) {
        const tail = yield* session.messages({ sessionID: id, limit: 200 }).pipe(Effect.option)
        return Option.getOrElse(tail, () => [])
      }
      const all = yield* session.messages({ sessionID: id }).pipe(Effect.option)
      const messages = Option.getOrElse(all, () => [])
      const index = messages.findIndex((message) => String(message.info.id) === messageID)
      if (index === -1) return messages.slice(-200)
      return messages.slice(0, index)
    })

    const memberContext = Effect.fn("TeamHttpApi.memberContext")(function* (ctx: {
      params: { teamID: string; sessionID: string }
      query: { sessionID: string; messageID?: string }
    }) {
      const info = yield* requireActiveTeam(ctx.params.teamID)
      const member = yield* requireMemberOf(ctx.params.teamID, ctx.params.sessionID)
      // The lead and the owning member may fetch context; outsiders are rejected.
      if (info.lead_session_id !== ctx.query.sessionID && ctx.params.sessionID !== ctx.query.sessionID) {
        return yield* teamRequestError(`Caller is not authorized to view member ${ctx.params.sessionID}`)
      }
      const sessionInfo = yield* session.get(SessionID.make(member.session_id)).pipe(Effect.option)
      const messages = yield* loadTranscript(member.session_id, ctx.query.messageID)
      return {
        team: {
          id: info.id,
          name: info.name,
          goal: info.goal,
          lead_session_id: info.lead_session_id,
          status: info.status,
          time_created: info.time_created,
          time_updated: info.time_updated,
        },
        member: toMember(member),
        session: {
          id: member.session_id,
          ...(member.agent_type != null ? { agent: member.agent_type } : {}),
          ...(member.model != null ? { model: toMemberModel(member.model)! } : {}),
          ...(Option.isSome(sessionInfo) && sessionInfo.value.permission != null
            ? { permission: sessionInfo.value.permission }
            : {}),
        },
        messages,
      }
    })

    const runMember = Effect.fn("TeamHttpApi.runMember")(function* (ctx: {
      params: { teamID: string; sessionID: string }
      query: { sessionID: string }
      payload: { instruction: string; messageID?: string }
    }) {
      const info = yield* requireActiveTeam(ctx.params.teamID)
      if (info.lead_session_id !== ctx.query.sessionID) {
        return yield* teamRequestError("Only the team lead can deliver a run request")
      }
      const member = yield* requireMemberOf(ctx.params.teamID, ctx.params.sessionID)
      // Persist the run instruction as a mailbox message to the member and wake it. This reuses
      // the existing sendMessage transaction (one revision bump, one per-recipient delivery row)
      // and its wake/admit path unchanged. The member process reads the instruction from its next
      // mailbox claim after waking on the events stream.
      yield* team
        .sendMessage({
          teamID: ctx.params.teamID,
          sender: info.lead_session_id,
          recipients: [member.session_id],
          body: ctx.payload.instruction,
        })
        .pipe(
          Effect.catchTag("Team.MessageToClosedTeam", () =>
            Effect.fail(teamRequestError(`Team ${ctx.params.teamID} is not active`)),
          ),
          Effect.catchTag("Team.MessageToTerminalMember", (error) => Effect.fail(teamRequestError(error.message))),
        )
      return {
        member_id: member.id,
        session_id: member.session_id,
        status: member.status,
      } satisfies typeof TeamMemberResultSchema.Type
    })

    const memberResult = Effect.fn("TeamHttpApi.memberResult")(function* (ctx: {
      params: { teamID: string; sessionID: string }
      query: { sessionID: string }
      payload: typeof TeamResultPayload.Type
    }) {
      const info = yield* requireActiveTeam(ctx.params.teamID)
      // The member reports its own terminal result; the lead may also settle a member directly.
      if (info.lead_session_id !== ctx.query.sessionID && ctx.params.sessionID !== ctx.query.sessionID) {
        return yield* teamRequestError(`Caller is not authorized to settle member ${ctx.params.sessionID}`)
      }
      const member = yield* requireMemberOf(ctx.params.teamID, ctx.params.sessionID)
      // Settle through the lifecycle reconciler, which owns the durable member admission
      // (prompt identity, run generation) and the terminal-transition invariants: exactly one
      // canonical lead notification and one revision bump per settled generation. The previous
      // Team.updateMemberStatus path bypassed the member run lifecycle entirely, so a remote
      // member's completion could never advance dependents or wake the lead.
      const failure = ctx.payload.failure_code ?? undefined
      // An explicit result/error override lets a failed or cancelled member process report a
      // terminal outcome when the extractor finds no durable terminal assistant turn. A completed
      // report is always settled from the durable extracted transcript, so its result text is not
      // forwarded as an override.
      const error =
        ctx.payload.status === "failed" || ctx.payload.status === "cancelled"
          ? ctx.payload.result ?? undefined
          : undefined
      const settled = yield* reconciler
        .settleRemoteMember({
          memberID: member.id,
          state: ctx.payload.status,
          result: ctx.payload.result,
          failureCode: failure,
          error,
          transcriptEvents: undefined,
        })
        .pipe(
          Effect.catchTag("LifecycleReconciler.RemoteSettleRejected", (error) =>
            Effect.fail(teamRequestError(error.message)),
          ),
        )
      if (settled.kind === "missing") {
        return yield* teamRequestError(`Member ${ctx.params.sessionID} could not be settled`)
      }
      if (settled.kind === "extractor-miss") {
        return yield* teamRequestError("Teammate reported completion but no terminal assistant message was found")
      }
      // Every remaining outcome answers with the member's durable status. Re-reading after the
      // settlement is authoritative: "settled" carries the freshly committed terminal status,
      // "retry-admitted" leaves the member non-terminal on generation 2 (still active), and
      // "stale"/"terminal" mean a terminal fact was already committed elsewhere or the write lost
      // the generation race, so the durable row reports the true state.
      const current = yield* team.getMemberBySession(member.session_id)
      return {
        member_id: member.id,
        session_id: member.session_id,
        status: Option.isSome(current) ? current.value.status : member.status,
      } satisfies typeof TeamMemberResultSchema.Type
    })

    const memberHeartbeat = Effect.fn("TeamHttpApi.memberHeartbeat")(function* (ctx: {
      params: { teamID: string; sessionID: string }
      query: { sessionID: string }
      payload: typeof TeamHeartbeatPayload.Type
    }) {
      const info = yield* requireActiveTeam(ctx.params.teamID)
      if (ctx.params.sessionID !== ctx.query.sessionID) {
        return yield* teamRequestError("Only the member itself can send a heartbeat")
      }
      const member = yield* requireMemberOf(ctx.params.teamID, ctx.params.sessionID)
      if (member.status === "completed" || member.status === "cancelled" || member.status === "failed") {
        return yield* teamRequestError(`Member ${ctx.params.sessionID} is terminal and cannot heartbeat`)
      }
      // Refresh the durable liveness timestamp only. This intentionally bypasses
      // updateMemberStatus: a status write would bump the team revision and (for an
      // idle daemon) re-send the "became idle" lead notification on every beat.
      // Heartbeats are liveness transport, not status transitions, so the revision,
      // status, and member lifecycle semantics stay untouched. PR 4/5 may formalize
      // durable daemon liveness handling when remote members actually run.
      const { db } = yield* Database.Service
      const now = Date.now()
      yield* db
        .update(TeamMemberTable)
        .set({
          daemon_last_active: now,
          ...(member.lifecycle === "daemon" && ctx.payload.daemon_state !== undefined
            ? { daemon_state: ctx.payload.daemon_state }
            : {}),
          ...(member.lifecycle === "daemon" && ctx.payload.daemon_error !== undefined
            ? { daemon_error: ctx.payload.daemon_error }
            : {}),
        })
        .where(and(eq(TeamMemberTable.id, member.id), eq(TeamMemberTable.team_id, info.id)))
        .run()
        .pipe(Effect.orDie)
      return {
        member_id: member.id,
        session_id: member.session_id,
        daemon_last_active: now,
      } satisfies typeof TeamHeartbeatResultSchema.Type
    })

    const memberEvents = Effect.fn("TeamHttpApi.memberEvents")(function* (ctx: {
      params: { teamID: string; sessionID: string }
      query: { sessionID: string }
    }) {
      const info = yield* requireActiveTeam(ctx.params.teamID)
      if (info.lead_session_id !== ctx.query.sessionID && ctx.params.sessionID !== ctx.query.sessionID) {
        return yield* teamRequestError(`Caller is not authorized to view member ${ctx.params.sessionID}`)
      }
      const member = yield* requireMemberOf(ctx.params.teamID, ctx.params.sessionID)
      return yield* memberEventResponse(info.id, member.session_id, team)
    })

    const messagesSend = Effect.fn("TeamHttpApi.messagesSend")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
      payload: typeof TeamSendMessagePayload.Type
    }) {
      yield* requireTeamParticipant(ctx.params.teamID, ctx.query.sessionID)
      const message = yield* team
        .sendMessage({
          teamID: ctx.params.teamID,
          sender: ctx.query.sessionID,
          recipients: [...ctx.payload.recipients],
          body: ctx.payload.body,
        })
        .pipe(
          Effect.catchTag("Team.MessageToClosedTeam", () =>
            Effect.fail(teamRequestError(`Team ${ctx.params.teamID} is not active`)),
          ),
          Effect.catchTag("Team.MessageToTerminalMember", (error) => Effect.fail(teamRequestError(error.message))),
        )
      return toMessage(message)
    })

    const messagesClaim = Effect.fn("TeamHttpApi.messagesClaim")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
    }) {
      yield* requireTeamParticipant(ctx.params.teamID, ctx.query.sessionID)
      const messages = yield* team
        .claimPendingMessages(ctx.query.sessionID, ctx.params.teamID)
        .pipe(
          Effect.catchTag("RunnerSuspended", () =>
            Effect.fail(teamRequestError(`Session ${ctx.query.sessionID} is paused`)),
          ),
        )
      return messages.map(toMessage)
    })

    const messagesAck = Effect.fn("TeamHttpApi.messagesAck")(function* (ctx: {
      params: { teamID: string; messageID: string }
      query: { sessionID: string }
    }) {
      yield* requireTeamParticipant(ctx.params.teamID, ctx.query.sessionID)
      yield* team.markMessageDelivered(ctx.params.messageID, ctx.query.sessionID)
      return { acked: true }
    })

    const messagesRelease = Effect.fn("TeamHttpApi.messagesRelease")(function* (ctx: {
      params: { teamID: string; messageID: string }
      query: { sessionID: string }
    }) {
      yield* requireTeamParticipant(ctx.params.teamID, ctx.query.sessionID)
      yield* team.releaseClaimedMessages([ctx.params.messageID], ctx.query.sessionID)
      return { acked: true }
    })

    const taskClaim = Effect.fn("TeamHttpApi.taskClaim")(function* (ctx: {
      params: { teamID: string; taskID: string }
      query: { sessionID: string }
    }) {
      yield* requireTeamParticipant(ctx.params.teamID, ctx.query.sessionID)
      const result = yield* team.claimTask(ctx.params.teamID, ctx.params.taskID, ctx.query.sessionID).pipe(
        Effect.catchIf(
          (error): error is Error => error instanceof Error,
          (error) => Effect.fail(teamRequestError(error.message)),
        ),
      )
      if (Option.isNone(result)) return yield* teamRequestError("Cannot claim this task.")
      return toTask(result.value)
    })

    const taskUpdate = Effect.fn("TeamHttpApi.taskUpdate")(function* (ctx: {
      params: { teamID: string; taskID: string }
      query: { sessionID: string }
      payload: typeof TeamTaskUpdatePayload.Type
    }) {
      const info = yield* requireTeamParticipant(ctx.params.teamID, ctx.query.sessionID)
      const current = yield* team.getTask(ctx.params.teamID, ctx.params.taskID).pipe(
        Effect.catchIf(
          (error): error is Error => error instanceof Error,
          (error) => Effect.fail(teamRequestError(error.message)),
        ),
      )
      if (Option.isNone(current)) return yield* teamRequestError("Task not found.")
      if (info.lead_session_id !== ctx.query.sessionID && current.value.assignee !== ctx.query.sessionID) {
        return yield* teamRequestError("Only the lead or assigned teammate can update this task.")
      }
      const result = yield* team
        .updateTask(
          ctx.params.teamID,
          ctx.params.taskID,
          {
            ...(ctx.payload.status !== undefined ? { status: ctx.payload.status } : {}),
            ...(ctx.payload.assignee !== undefined ? { assignee: ctx.payload.assignee } : {}),
            ...(ctx.payload.handoff !== undefined
              ? {
                  handoff: {
                    summary: ctx.payload.handoff.summary,
                    changed_paths: [...ctx.payload.handoff.changed_paths],
                    verification: ctx.payload.handoff.verification.map((entry) => ({ ...entry })),
                    ...(ctx.payload.handoff.risks != null ? { risks: [...ctx.payload.handoff.risks] } : {}),
                  },
                }
              : {}),
            ...(ctx.payload.handoff_path_keys !== undefined
              ? { handoffPathKeys: [...ctx.payload.handoff_path_keys] }
              : {}),
          },
          { sessionID: ctx.query.sessionID, isLead: info.lead_session_id === ctx.query.sessionID },
        )
        .pipe(
          Effect.catchIf(
            (error): error is Error => error instanceof Error,
            (error) => Effect.fail(teamRequestError(error.message)),
          ),
        )
      if (Option.isNone(result)) return yield* teamRequestError("Task not found.")
      return toTask(result.value)
    })

    const memberPlan = Effect.fn("TeamHttpApi.memberPlan")(function* (ctx: {
      params: { teamID: string; sessionID: string; action: "submit" | "decide" }
      query: { sessionID: string }
      payload: typeof TeamPlanPayload.Type
    }) {
      const info = yield* requireActiveTeam(ctx.params.teamID)
      const member = yield* requireMemberOf(ctx.params.teamID, ctx.params.sessionID)
      if (ctx.params.action === "submit") {
        // Only the member itself submits its own plan for lead review.
        if (ctx.params.sessionID !== ctx.query.sessionID) {
          return yield* teamRequestError("Only the member can submit its own plan")
        }
        const plan = ctx.payload.plan
        if (typeof plan !== "string" || plan.trim() === "") {
          return yield* teamRequestError("Plan submission requires a nonblank plan")
        }
        yield* team
          .sendMessage({
            teamID: info.id,
            sender: member.session_id,
            recipients: [info.lead_session_id],
            body: `PLAN SUBMITTED by ${member.name}:\n\n${plan}`,
          })
          .pipe(
            Effect.catchTag("Team.MessageToClosedTeam", () =>
              Effect.fail(teamRequestError(`Team ${info.id} is not active`)),
            ),
            Effect.catchTag("Team.MessageToTerminalMember", (error) => Effect.fail(teamRequestError(error.message))),
          )
        return {
          decision: "submitted",
          member_id: member.id,
          session_id: member.session_id,
        }
      }
      // decide
      if (info.lead_session_id !== ctx.query.sessionID) {
        return yield* teamRequestError("Only the team lead can decide a member plan")
      }
      if (ctx.payload.decision === "approve") {
        const approved = yield* team.approveMemberPlan(member.id, {
          sender: info.lead_session_id,
          body: `PLAN APPROVED. Proceed with implementation.\n${ctx.payload.feedback ?? ""}`,
          usageMetadata: {
            target_session_id: member.session_id,
            feedback_provided: ctx.payload.feedback !== undefined,
          },
        })
        if (Option.isNone(approved)) {
          return yield* teamRequestError(`Member ${member.name} is no longer an active non-terminal plan-mode member.`)
        }
        return {
          decision: "approved",
          member_id: member.id,
          session_id: member.session_id,
        }
      }
      yield* team
        .sendMessage({
          teamID: info.id,
          sender: info.lead_session_id,
          recipients: [member.session_id],
          body: `PLAN REJECTED.\n${ctx.payload.feedback ?? "Please revise and resubmit."}`,
        })
        .pipe(
          Effect.catchTag("Team.MessageToClosedTeam", () =>
            Effect.fail(teamRequestError(`Team ${info.id} is not active`)),
          ),
          Effect.catchTag("Team.MessageToTerminalMember", (error) => Effect.fail(teamRequestError(error.message))),
        )
      yield* team.createUsageEvent({
        teamID: info.id,
        sessionID: info.lead_session_id,
        memberID: member.id,
        type: "plan_rejected",
        metadata: {
          target_session_id: member.session_id,
          feedback_provided: ctx.payload.feedback !== undefined,
        },
      })
      return {
        decision: "rejected",
        member_id: member.id,
        session_id: member.session_id,
      }
    })

    const transcriptSync = Effect.fn("TeamHttpApi.transcriptSync")(function* (ctx: {
      params: { teamID: string }
      query: { sessionID: string }
      payload: typeof ReplayPayload.Type
    }) {
      yield* requireActiveTeam(ctx.params.teamID)
      // Only a member may sync its own transcript; the lead has no member row and is
      // rejected by requireMemberOf.
      const member = yield* requireMemberOf(ctx.params.teamID, ctx.query.sessionID)
      const payloadEvents = ctx.payload.events
      const events = payloadEvents.map((event) => ({
        id: event.id,
        aggregateID: event.aggregateID,
        seq: event.seq,
        type: event.type,
        data: { ...event.data },
      }))
      if (events.some((event) => event.aggregateID !== member.session_id)) {
        return yield* teamRequestError("Transcript events must belong to the member session aggregate")
      }
      // Replay the member-local session events into the lead's event store, scoped to the member
      // session aggregate. This mirrors the existing /sync/replay handler: strict ownership keeps
      // one workspace from replaying events for an aggregate another workspace owns.
      const bridge = yield* EventV2Bridge.Service
      const ownerID = yield* InstanceState.workspaceID
      yield* bridge
        .replayAll(events, { ownerID, strictOwner: true })
        .pipe(
          Effect.catchDefect((error) =>
            error instanceof EventV2.InvalidSyncEventError
              ? Effect.fail(teamRequestError(`Transcript sync rejected: ${error.message}`))
              : Effect.die(error),
          ),
        )
      return {
        sessionID: member.session_id,
        events: events.length,
      } satisfies typeof TeamTranscriptSyncResultSchema.Type
    })

    return handlers
      .handle("getBySession", getBySession)
      .handle("getByTeam", getByTeam)
      .handle("getEval", getEval)
      .handle("getTasks", getTasks)
      .handle("getMessages", getMessages)
      .handle("shutdown", shutdown)
      .handle("memberContext", memberContext)
      .handle("runMember", runMember)
      .handle("memberResult", memberResult)
      .handle("memberHeartbeat", memberHeartbeat)
      .handle("memberEvents", memberEvents)
      .handle("messagesSend", messagesSend)
      .handle("messagesClaim", messagesClaim)
      .handle("messagesAck", messagesAck)
      .handle("messagesRelease", messagesRelease)
      .handle("taskClaim", taskClaim)
      .handle("taskUpdate", taskUpdate)
      .handle("memberPlan", memberPlan)
      .handle("transcriptSync", transcriptSync)
  }),
)

/**
 * SSE response for the member events channel. Delivers JSON events a member
 * process can act on: its own status transitions (team.member.updated), new
 * mail (team.mail, emitted when the member has pending mailbox rows), and team
 * close (team.closed, which also terminates the stream). A periodic
 * server.heartbeat keeps the connection alive; server.connected is emitted
 * first. Reuses the SSE pattern from handlers/event.ts.
 */
const memberEventResponse = Effect.fn("TeamHttpApi.memberEventResponse")(function* (
  teamID: string,
  sessionID: string,
  teamService: Team.Interface,
) {
  const events = yield* EventV2Bridge.Service
  const instance = yield* InstanceState.context
  const queue = yield* Queue.unbounded<{ id: string; type: string; properties: Record<string, unknown> }>()
  const unsubscribe = yield* events.listen((event) =>
    Effect.gen(function* () {
      if (event.location?.directory !== undefined && event.location.directory !== instance.directory) return
      const data = (event.data ?? {}) as Record<string, unknown>
      if (event.type === "team.member.updated") {
        if (data.sessionID !== sessionID) return
        Queue.offerUnsafe(queue, { id: event.id, type: event.type, properties: data })
        return
      }
      if (event.type === "team.message.received") {
        if (data.teamID !== teamID) return
        // The published event does not name recipients; a member mailbox probe decides whether
        // this message is actionable for the subscribed member.
        const pending = yield* teamService.hasPendingMailboxMessages(sessionID)
        if (!pending) return
        Queue.offerUnsafe(queue, {
          id: event.id,
          type: "team.mail",
          properties: { messageID: data.messageID, teamID: data.teamID },
        })
        return
      }
      if (event.type === "team.closed") {
        if (data.teamID !== teamID) return
        Queue.offerUnsafe(queue, { id: event.id, type: event.type, properties: data })
      }
    }),
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  // Seed a mail wake when the member connects with an already-nonempty mailbox
  // (for example a run instruction queued before the member process started).
  const pending = yield* teamService.hasPendingMailboxMessages(sessionID)
  const output = Stream.fromQueue(queue).pipe(Stream.takeUntil((event) => event.type === "team.closed"))
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ({ id: EventV2.ID.create(), type: "server.heartbeat", properties: {} })),
  )
  const initial = Stream.make(
    { id: EventV2.ID.create(), type: "server.connected", properties: {} },
    ...(pending ? [{ id: EventV2.ID.create(), type: "team.mail", properties: { teamID } }] : []),
  )
  return HttpServerResponse.stream(
    initial.pipe(
      Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
      Stream.map(eventData),
      Stream.pipeThroughChannel(Sse.encode()),
      Stream.encodeText,
    ),
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
})

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}
