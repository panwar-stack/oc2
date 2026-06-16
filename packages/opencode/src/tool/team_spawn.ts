import * as Tool from "./tool"
import DESCRIPTION from "./team_spawn.txt"
import { Team } from "@/team/team"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import type { TaskPromptOps } from "./task"
import { wakeTeamSession } from "./team_wake"
import { EffectBridge } from "@/effect/bridge"
import { SessionID } from "@/session/schema"
import { Cause, Effect, Exit, Schema, Scope, Option } from "effect"
import { Database } from "@opencode-ai/core/database/database"

const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "Name for this teammate" }),
  agent_type: Schema.String.annotate({ description: "The type of agent to use" }),
  role_prompt: Schema.String.annotate({ description: "The task/prompt for this teammate" }),
  depends_on: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional teammate names or session IDs that must complete before this teammate starts",
  }),
  wait_for: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Alias for depends_on",
  }),
  plan_mode: Schema.optional(Schema.Boolean).annotate({ description: "Start in plan mode requiring lead approval" }),
  variant: Schema.optional(Schema.String).annotate({
    description: "Optional variant of the teammate's effective model, selected by the lead for this task's complexity",
  }),
  lifecycle: Schema.optional(Schema.Literals(["task", "daemon"])).annotate({
    description: "Whether this teammate is a finite task worker or a long-lived daemon teammate",
  }),
})

type Metadata = {
  memberID?: string
  sessionID?: string
  dependencyIDs?: string[]
}

const CommunicationGuidance = [
  "Proactive communication requirements:",
  '- Before doing substantial work, send a brief kickoff update to the lead with team_send_message recipient "lead".',
  "- Send concise progress updates to the lead after material findings, decisions, completed milestones, and before or after risky edits.",
  "- Message teammates directly when your work affects them, unblocks them, or gives them information they need.",
  "- Check team_get_messages at natural handoff points, after sending updates, and whenever you may have been unblocked or redirected.",
  "- Do not wait until your final answer to share useful status, blockers, or intermediate results.",
  "- When you send a message via team_send_message or team_broadcast, recipients are automatically woken. Do not poll team_get_messages in a loop — check once and continue working.",
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

const MemberToolsPlan = [
  "- team_plan_submit: Submit your plan to the lead for approval. You must do this before doing any implementation work.",
].join("\n")

const NestedTeamTools = {
  team_create: false,
  team_spawn: false,
  local_fusion: false,
}

export const TeamSpawnTool = Tool.define(
  "team_spawn",
  Effect.gen(function* () {
    const team = yield* Team.Service
    const sessions = yield* Session.Service
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          if (!cfg.experimental?.agent_teams) {
            return { title: "Team Spawn", output: "Agent teams are not enabled.", metadata: {} as Metadata }
          }

          const callerMember = yield* team.getMemberBySession(ctx.sessionID)
          if (Option.isSome(callerMember)) {
            const memberTeam = yield* team.get(callerMember.value.team_id)
            if (Option.isSome(memberTeam) && memberTeam.value.status === "active") {
              return {
                title: "Team Spawn Failed",
                output: "Team members cannot spawn nested teammates.",
                metadata: {} as Metadata,
              }
            }
          }
          const parent = yield* sessions.get(ctx.sessionID)
          if (parent.parentID) {
            return {
              title: "Team Spawn Failed",
              output: "Child sessions cannot spawn teammates.",
              metadata: {} as Metadata,
            }
          }

          const activeTeam = yield* team.getActive(ctx.sessionID)
          if (Option.isNone(activeTeam)) {
            return { title: "Team Spawn Failed", output: "No active team found.", metadata: {} as Metadata }
          }
          const teamID = activeTeam.value.id
          const lifecycle = params.lifecycle ?? "task"

          const ag = yield* agent.get(params.agent_type)
          if (!ag) {
            return {
              title: "Team Spawn Failed",
              output: `Unknown agent type: ${params.agent_type}`,
              metadata: {} as Metadata,
            }
          }

          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops) {
            return {
              title: "Team Spawn Failed",
              output: "Cannot start teammate because prompt operations are unavailable.",
              metadata: {} as Metadata,
            }
          }

          const leadMessage = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.orDie,
          )
          if (leadMessage.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
          const leadVariant = leadMessage.info.variant === "default" ? undefined : leadMessage.info.variant
          const inheritsLeadModel = !ag.model
          const model = ag.model ?? {
            providerID: leadMessage.info.providerID,
            modelID: leadMessage.info.modelID,
          }

          const modelExit =
            params.variant || (!inheritsLeadModel && ag.variant)
              ? yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.exit)
              : undefined
          if (params.variant) {
            const requestedModelExit = modelExit
            if (!requestedModelExit) return yield* Effect.die(new Error("Model lookup did not run for requested variant"))
            if (Exit.isFailure(requestedModelExit)) {
              const error = Cause.squash(requestedModelExit.cause)
              const hint = Provider.ModelNotFoundError.isInstance(error)
                ? error.suggestions?.length
                  ? ` Did you mean: ${error.suggestions.join(", ")}?`
                  : ""
                : ""
              return {
                title: "Team Spawn Failed",
                output: `Model not found: ${model.providerID}/${model.modelID}.${hint}`,
                metadata: {} as Metadata,
              }
            }
            const variants = Object.keys(requestedModelExit.value.variants ?? {})
            if (variants.length === 0) {
              return {
                title: "Team Spawn Failed",
                output: `Model ${model.providerID}/${model.modelID} exposes no teammate variants. Omit team_spawn.variant for default behavior.`,
                metadata: {} as Metadata,
              }
            }
            if (params.variant === "default" || !variants.includes(params.variant)) {
              return {
                title: "Team Spawn Failed",
                output: `Invalid teammate variant "${params.variant}" for ${model.providerID}/${model.modelID}. Available variants: ${variants.join(", ")}. Omit team_spawn.variant for default behavior.`,
                metadata: {} as Metadata,
              }
            }
          }
          const agentVariant =
            !params.variant && !inheritsLeadModel && ag.variant && modelExit && Exit.isSuccess(modelExit)
              ? modelExit.value.variants?.[ag.variant]
                ? ag.variant
                : undefined
              : undefined
          const effectiveVariant = params.variant ?? (inheritsLeadModel ? leadVariant : agentVariant)

          const existingMembers = yield* team.getMembers(teamID)
          if (existingMembers.some((member) => member.name === params.name)) {
            return {
              title: "Team Spawn Failed",
              output: `A teammate named '${params.name}' already exists. Choose a unique teammate name.`,
              metadata: {} as Metadata,
            }
          }
          const requestedDependencies = [...new Set([...(params.depends_on ?? []), ...(params.wait_for ?? [])])]
          const resolvedDependencies = requestedDependencies.map((dependency) => {
            const sessionMatch = existingMembers.find((member) => member.session_id === dependency)
            if (sessionMatch) return { dependency, sessionID: sessionMatch.session_id }
            const nameMatches = existingMembers.filter((member) => member.name === dependency)
            if (nameMatches.length === 1) return { dependency, sessionID: nameMatches[0]?.session_id }
            return { dependency, ambiguous: nameMatches.length > 1 }
          })
          const ambiguousDependencies = resolvedDependencies
            .filter((dependency) => dependency.ambiguous)
            .map((dependency) => dependency.dependency)
          if (ambiguousDependencies.length > 0) {
            return {
              title: "Team Spawn Failed",
              output: `Dependency teammate name(s) are ambiguous; use session IDs instead: ${ambiguousDependencies.join(", ")}`,
              metadata: {} as Metadata,
            }
          }
          const missingDependencies = resolvedDependencies
            .filter((dependency) => dependency.sessionID === undefined)
            .map((dependency) => dependency.dependency)
          if (missingDependencies.length > 0) {
            return {
              title: "Team Spawn Failed",
              output: `Dependency teammate(s) not found: ${missingDependencies.join(", ")}`,
              metadata: {} as Metadata,
            }
          }
          const dependencyIDs = resolvedDependencies
            .map((dependency) => dependency.sessionID)
            .filter((dependency): dependency is string => dependency !== undefined)

          const requirePlanApproval = params.plan_mode ?? false
          const permissionRules = [
            ...(parent.permission ?? []).filter(
              (rule) => rule.permission === "external_directory" || rule.action === "deny",
            ),
          ]
          if (requirePlanApproval) {
            permissionRules.push(
              { permission: "bash" as const, pattern: "*" as const, action: "deny" as const },
              { permission: "write" as const, pattern: "*" as const, action: "deny" as const },
              { permission: "edit" as const, pattern: "*" as const, action: "deny" as const },
              { permission: "apply_patch" as const, pattern: "*" as const, action: "deny" as const },
            )
          }

          const childVariant = inheritsLeadModel ? effectiveVariant : leadVariant
          const childSession = yield* sessions.create({
            parentID: ctx.sessionID,
            title: `${params.name} (@${ag.name} teammate)`,
            model: {
              id: leadMessage.info.modelID,
              providerID: leadMessage.info.providerID,
              ...(childVariant ? { variant: childVariant } : {}),
            },
            permission: permissionRules,
          })

          const member = yield* team.addMember({
            teamID,
            sessionID: childSession.id,
            name: params.name,
            agentType: params.agent_type,
            model: {
              providerID: model.providerID,
              modelID: model.modelID,
              ...((params.variant || inheritsLeadModel) && effectiveVariant ? { variant: effectiveVariant } : {}),
            },
            rolePrompt: params.role_prompt,
            planMode: requirePlanApproval,
            workMode: requirePlanApproval ? "plan" : "implement",
            dependencyIDs,
            lifecycle,
            daemonState: lifecycle === "daemon" ? "initializing" : null,
            daemonLastActive: lifecycle === "daemon" ? Date.now() : null,
          })

          const dependencyResults = (members: any[], dependencies: string[]) => {
            if (dependencies.length === 0) return ""
            return [
              "Dependency results:",
              ...dependencies.map((dependency) => {
                const match = members.find((m) => m.session_id === dependency)
                return [
                  `- ${match?.name ?? dependency} (${dependency})`,
                  match?.result ?? "(completed with no result)",
                ].join("\n")
              }),
            ].join("\n")
          }

          const notifySessions = (sender: string, recipients: string[], body: string) =>
            Effect.gen(function* () {
              const uniqueRecipients = [...new Set(recipients)]
              if (uniqueRecipients.length === 0) return
              yield* team.sendMessage({
                teamID,
                sender,
                recipients: uniqueRecipients,
                body,
              })
              yield* Effect.forEach(
                uniqueRecipients.filter((recipient) => recipient !== sender),
                (recipient) => wakeTeamSession(ops, recipient).pipe(Effect.ignore, Effect.forkIn(scope)),
                { discard: true },
              )
            })

          const notifyLead = (sender: string, body: string) =>
            notifySessions(sender, [activeTeam.value.lead_session_id], body)

          const notifyActiveDependencies = (members: any[]) =>
            Effect.gen(function* () {
              const recipients = members
                .filter(
                  (member) =>
                    dependencyIDs.includes(member.session_id) &&
                    (member.status === "active" || member.status === "starting" || member.status === "idle"),
                )
                .map((member) => member.session_id)
              if (recipients.length === 0) return
              yield* notifySessions(
                activeTeam.value.lead_session_id,
                recipients,
                [
                  `Teammate ${member.name} (${member.agent_type}) has been added and is waiting on your work.`,
                  "",
                  "Please send proactive progress updates and make your final result a clear handoff for this teammate.",
                ].join("\n"),
              )
            })

          let startMember: (member: any, extraPrompt: string) => Effect.Effect<string>
          const startReadyBlockedMembers = (completedSessionID: string): Effect.Effect<void> =>
            Effect.gen(function* () {
              const members = yield* team.getMembers(teamID)
              const ready = members.filter((member) => {
                const dependencies = member.dependency_ids ?? []
                if (member.status !== "blocked" || !dependencies.includes(completedSessionID)) return false
                return dependencies.every((dependency: string) =>
                  members.some(
                    (candidate) =>
                      candidate.session_id === dependency &&
                      candidate.status === "completed" &&
                      candidate.lifecycle !== "daemon",
                  ),
                )
              })
              yield* Effect.forEach(
                ready,
                (member) => startMember(member, dependencyResults(members, member.dependency_ids ?? [])),
                { concurrency: "unbounded", discard: true },
              )
            })

          startMember = (member: any, extraPrompt: string): Effect.Effect<string> =>
            Effect.gen(function* () {
              const nextAgent = yield* agent.get(member.agent_type)
              if (!nextAgent) {
                yield* team.updateMemberStatus(member.id, "cancelled")
                yield* notifyLead(
                  member.session_id,
                  `Teammate ${member.name} (${member.agent_type}) stopped before starting: unknown agent type.`,
                )
                return "Teammate stopped before starting: unknown agent type."
              }
              const members = yield* team.getMembers(teamID)
              const teammates = members
                .filter((candidate) => candidate.session_id !== member.session_id)
                .map(
                  (candidate) =>
                    `- ${candidate.name} (${candidate.agent_type}, ${candidate.status}, session ${candidate.session_id})`,
                )
              const planTools = member.plan_mode ? "\n" + MemberToolsPlan : ""
              const parts = yield* ops.resolvePromptParts(
                [
                  `You are teammate "${member.name}" in team "${activeTeam.value.name}".`,
                  `Team goal: ${activeTeam.value.goal}`,
                  `The lead session is ${activeTeam.value.lead_session_id}. Your session is ${member.session_id}.`,
                  MemberTools + planTools,
                  teammates.length > 0
                    ? ["Current teammates:", ...teammates].join("\n")
                    : "No other teammates are registered yet.",
                  CommunicationGuidance,
                  member.lifecycle === "daemon" ? DaemonGuidance : TaskCompletionGuidance,
                  extraPrompt,
                  member.role_prompt,
                ].join("\n\n"),
              )
              return yield* Effect.gen(function* () {
                const currentTeam = yield* team.get(teamID)
                if (Option.isNone(currentTeam) || currentTeam.value.status !== "active") {
                  return "Teammate did not start because the team is no longer active."
                }

                yield* team.updateMemberStatus(
                  member.id,
                  "active",
                  member.lifecycle === "daemon"
                    ? { daemonState: "running", daemonLastActive: Date.now(), daemonError: null }
                    : undefined,
                )
                yield* notifyLead(
                  member.session_id,
                  [
                    `Teammate ${member.name} (${member.agent_type}) started.`,
                    "",
                    "Assignment:",
                    member.role_prompt,
                    ...(extraPrompt ? ["", "Dependency context was provided in this teammate's prompt."] : []),
                  ].join("\n"),
                )
                const result = yield* ops.prompt({
                  sessionID: member.session_id,
                  model: member.model
                    ? { providerID: member.model.providerID, modelID: member.model.modelID }
                    : undefined,
                  variant: member.model?.variant,
                  agent: nextAgent.name,
                  tools: {
                    ...NestedTeamTools,
                    ...(member.plan_mode ? { bash: false, write: false, edit: false, apply_patch: false } : {}),
                  },
                  parts,
                })
                const current = yield* team.getMemberBySession(member.session_id)
                const latestTeam = yield* team.get(teamID)
                if (
                  Option.isNone(current) ||
                  current.value.status === "cancelled" ||
                  Option.isNone(latestTeam) ||
                  latestTeam.value.status !== "active"
                ) {
                  return "Teammate stopped before completing."
                }
                const output = result.parts.findLast((part) => part.type === "text")?.text ?? ""
                if (member.lifecycle === "daemon") {
                  yield* team.updateMemberStatus(member.id, "idle", {
                    daemonState: "idle",
                    daemonLastActive: Date.now(),
                    daemonError: null,
                  })
                  return output || "Daemon teammate initialized."
                }
                yield* team.updateMemberStatus(member.id, "completed", output)
                yield* notifyLead(
                  member.session_id,
                  [
                    `Teammate ${member.name} (${member.agent_type}) completed and returned this result:`,
                    "",
                    "<teammate_result>",
                    output || "(no text result)",
                    "</teammate_result>",
                  ].join("\n"),
                )
                yield* startReadyBlockedMembers(member.session_id)
                return output || "(no text result)"
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    if (Cause.hasInterruptsOnly(cause)) return yield* Effect.interrupt
                    const error = Cause.squash(cause)
                    yield* team.updateMemberStatus(
                      member.id,
                      "cancelled",
                      member.lifecycle === "daemon"
                        ? {
                            daemonState: "error",
                            daemonLastActive: Date.now(),
                            daemonError: error instanceof Error ? error.message : String(error),
                          }
                        : undefined,
                    )
                    const latestTeam = yield* team.get(teamID)
                    const message = `Teammate ${member.name} (${member.agent_type}) stopped before completing: ${error instanceof Error ? error.message : String(error)}`
                    if (Option.isNone(latestTeam) || latestTeam.value.status !== "active") return message
                    yield* notifyLead(member.session_id, message)
                    return message
                  }),
                ),
              )
            })

          const latestMembers = yield* team.getMembers(teamID)
          yield* notifyActiveDependencies(latestMembers)
          const blocked = dependencyIDs.some(
            (dependency) =>
              !latestMembers.some(
                (candidate) =>
                  candidate.session_id === dependency &&
                  candidate.status === "completed" &&
                  candidate.lifecycle !== "daemon",
              ),
          )
          if (blocked) {
            yield* team.updateMemberStatus(member.id, "blocked")
            yield* notifyLead(
              member.session_id,
              [
                `Teammate ${member.name} (${member.agent_type}) is waiting on dependency teammate(s):`,
                ...dependencyIDs.map((dependency) => {
                  const match = latestMembers.find((candidate) => candidate.session_id === dependency)
                  return `- ${match?.name ?? dependency} (${dependency})`
                }),
              ].join("\n"),
            )
            return {
              title: "Teammate Spawned",
              output: `Teammate spawned: ${member.name} (${member.session_id}) [${member.agent_type}], waiting on ${dependencyIDs.length} dependency(ies)`,
              metadata: { memberID: member.id, sessionID: member.session_id, dependencyIDs } as Metadata,
            }
          }

          const runCancel = yield* EffectBridge.make()
          const cancelMember = Effect.gen(function* () {
            yield* team
              .updateMemberStatus(
                member.id,
                "cancelled",
                member.lifecycle === "daemon"
                  ? { daemonState: "cancelled", daemonLastActive: Date.now() }
                  : undefined,
              )
              .pipe(Effect.ignore)
            yield* ops.cancel(SessionID.make(member.session_id)).pipe(Effect.ignore)
          })
          function onAbort() {
            runCancel.fork(cancelMember)
          }

          return yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              ctx.abort.addEventListener("abort", onAbort)
              if (ctx.abort.aborted) onAbort()
            }),
            () =>
              Effect.gen(function* () {
                const result = yield* startMember(member, dependencyResults(latestMembers, dependencyIDs))
                const current = yield* team.getMemberBySession(member.session_id)
                if (member.lifecycle === "daemon") {
                  const failed = Option.isSome(current) && current.value.daemon_state === "error"
                  return {
                    title: failed ? "Daemon Teammate Initialization Failed" : "Daemon Teammate Initialized",
                    output: [
                      failed
                        ? `Daemon teammate initialization failed: ${member.name} (${member.session_id}) [${member.agent_type}]`
                        : `Daemon teammate initialized: ${member.name} (${member.session_id}) [${member.agent_type}]`,
                      "",
                      "<teammate_result>",
                      result,
                      "</teammate_result>",
                    ].join("\n"),
                    metadata: { memberID: member.id, sessionID: member.session_id, dependencyIDs } as Metadata,
                  }
                }
                return {
                  title: "Teammate Completed",
                  output: [
                    `Teammate completed: ${member.name} (${member.session_id}) [${member.agent_type}]`,
                    "",
                    "<teammate_result>",
                    result,
                    "</teammate_result>",
                  ].join("\n"),
                  metadata: { memberID: member.id, sessionID: member.session_id, dependencyIDs } as Metadata,
                }
              }),
            (_, exit) =>
              Effect.gen(function* () {
                if (Exit.hasInterrupts(exit)) yield* cancelMember
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.abort.removeEventListener("abort", onAbort)
                  }),
                ),
              ),
          )
        }).pipe(Effect.orDie),
    }
  }),
)
