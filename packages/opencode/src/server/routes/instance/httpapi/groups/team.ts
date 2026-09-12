import { PermissionV1 } from "@oc2-ai/core/v1/permission"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { ReplayPayload } from "./sync"
import { described } from "./metadata"

const TeamInfoSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  goal: Schema.String,
  lead_session_id: Schema.String,
  status: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "TeamInfo" })

const TeamMemberSchema = Schema.Struct({
  id: Schema.String,
  team_id: Schema.String,
  session_id: Schema.String,
  name: Schema.String,
  agent_type: Schema.String,
  role_prompt: Schema.String,
  status: Schema.String,
  lifecycle: Schema.String,
  daemon_state: Schema.NullOr(Schema.String),
  daemon_last_active: Schema.NullOr(Schema.Number),
  daemon_error: Schema.NullOr(Schema.String),
  plan_mode: Schema.Boolean,
  work_mode: Schema.String,
  dependency_ids: Schema.NullOr(Schema.Array(Schema.String)),
  result: Schema.NullOr(Schema.String),
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "TeamMember" })

const TeamTaskHandoffSchema = Schema.Struct({
  summary: Schema.String,
  changed_paths: Schema.Array(Schema.String),
  verification: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      status: Schema.Literals(["passed", "failed", "not_run"]),
      detail: Schema.optionalKey(Schema.String),
    }),
  ),
  risks: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "TeamTaskHandoff" })

const TeamTaskSchema = Schema.Struct({
  id: Schema.String,
  team_id: Schema.String,
  description: Schema.String,
  status: Schema.String,
  assignee: Schema.optionalKey(Schema.String),
  dependency_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  owned_paths: Schema.Array(Schema.String),
  handoff: Schema.NullOr(TeamTaskHandoffSchema),
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "TeamTask" })

const TeamMessageSchema = Schema.Struct({
  id: Schema.String,
  team_id: Schema.String,
  sender: Schema.String,
  recipients: Schema.Array(Schema.String),
  body: Schema.String,
  delivery_status: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "TeamMessage" })

const TeamEvalNodeTypeSchema = Schema.Literals([
  "team",
  "member",
  "task",
  "message",
  "session_step",
  "tool_call",
  "result",
])

const TeamEvalEdgeTypeSchema = Schema.Literals([
  "lead_to_member",
  "depends_on",
  "message_to",
  "produces",
  "contains",
  "session_event",
  "propagates_to",
])

const TeamEvalFindingSeveritySchema = Schema.Literals(["info", "warning", "error"])

const TeamEvalFindingCategorySchema = Schema.Literals([
  "planning.goal_or_decomposition",
  "planning.missing_or_wrong_dependency",
  "execution.unknown_agent",
  "execution.cancelled_member",
  "execution.failed_member",
  "execution.empty_result",
  "execution.stuck_or_blocked",
  "messaging.pending_delivery",
  "messaging.missing_progress",
  "integration.context_loss",
  "integration.premature_shutdown",
  "structure.unexpected_or_missing_edge",
  "member.ambiguous_name",
  "shallow_usage",
  "missing_task_list",
  "missing_final_report",
  "daemon_without_activity",
  "daemon_error",
  "daemon_left_active_on_shutdown",
  "daemon_used_for_finite_task",
])

const TeamEvalMetadataSchema = Schema.Record(Schema.String, Schema.Unknown)

const TeamEvalNodeSchema = Schema.Struct({
  id: Schema.String,
  type: TeamEvalNodeTypeSchema,
  ref: Schema.String,
  label: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  time_created: Schema.Number,
  time_updated: Schema.optionalKey(Schema.Number),
  metadata: Schema.optionalKey(TeamEvalMetadataSchema),
}).annotate({ identifier: "TeamEvalNode" })

const TeamEvalEdgeSchema = Schema.Struct({
  id: Schema.String,
  type: TeamEvalEdgeTypeSchema,
  from: Schema.String,
  to: Schema.String,
  metadata: Schema.optional(Schema.UndefinedOr(TeamEvalMetadataSchema)),
}).annotate({ identifier: "TeamEvalEdge" })

const TeamEvalFindingSchema = Schema.Struct({
  id: Schema.String,
  severity: TeamEvalFindingSeveritySchema,
  category: TeamEvalFindingCategorySchema,
  node_id: Schema.String,
  message: Schema.String,
  time_created: Schema.Number,
  root_cause: Schema.Boolean,
  propagated_from: Schema.optionalKey(Schema.String),
  metadata: Schema.optional(Schema.UndefinedOr(TeamEvalMetadataSchema)),
}).annotate({ identifier: "TeamEvalFinding" })

const TeamUsageMetricsSchema = Schema.Struct({
  work_item_count: Schema.Number,
  task_count: Schema.Number,
  member_count: Schema.Number,
  dependency_count: Schema.Number,
  plan_mode_member_count: Schema.Number,
  plan_approval_count: Schema.Number,
  broadcast_count: Schema.Number,
  final_report_generated: Schema.Boolean,
  shallow_usage: Schema.Boolean,
}).annotate({ identifier: "TeamUsageMetrics" })

const TeamEvalReportSchema = Schema.Struct({
  team_id: Schema.String,
  generated_at: Schema.Number,
  nodes: Schema.Array(TeamEvalNodeSchema),
  edges: Schema.Array(TeamEvalEdgeSchema),
  findings: Schema.Array(TeamEvalFindingSchema),
  summary: Schema.Struct({
    node_count: Schema.Number,
    edge_count: Schema.Number,
    root_cause_count: Schema.Number,
    propagated_failure_count: Schema.Number,
    structural_deviation_count: Schema.Number,
    longest_dependency_chain: Schema.Number,
    usage: TeamUsageMetricsSchema,
  }),
}).annotate({ identifier: "TeamEvalReport" })

export const TeamPaths = {
  root: "/team",
} as const

// PR 2 control-plane member transport paths. Members are headless teammate
// processes that reach team state only through these routes; see
// specs/multiprocess-agent-teams.md. All mutations reuse the existing
// Team.Service methods unchanged (transport only, no new business rules).
export const TeamMemberPaths = {
  context: `${TeamPaths.root}/:teamID/members/:sessionID/context`,
  run: `${TeamPaths.root}/:teamID/members/:sessionID/run`,
  result: `${TeamPaths.root}/:teamID/members/:sessionID/result`,
  heartbeat: `${TeamPaths.root}/:teamID/members/:sessionID/heartbeat`,
  events: `${TeamPaths.root}/:teamID/members/:sessionID/events`,
  plan: `${TeamPaths.root}/:teamID/members/:sessionID/plan/:action`,
} as const

export const TeamMessagePaths = {
  send: `${TeamPaths.root}/:teamID/messages`,
  claim: `${TeamPaths.root}/:teamID/messages/claim`,
  ack: `${TeamPaths.root}/:teamID/messages/:messageID/ack`,
  release: `${TeamPaths.root}/:teamID/messages/:messageID/release`,
} as const

export const TeamTaskPaths = {
  claim: `${TeamPaths.root}/:teamID/tasks/:taskID/claim`,
  update: `${TeamPaths.root}/:teamID/tasks/:taskID/update`,
} as const

export const TeamTranscriptSyncPath = `${TeamPaths.root}/:teamID/transcript/sync` as const

/** Public error contract for the PR 2 control-plane transport surface. Expected
 * domain failures (unknown team/member, outsider caller, terminal recipient,
 * closed team, plan/settle conflicts) are translated to this shape at the
 * handler boundary per httpapi/AGENTS.md. */
export class TeamRequestError extends Schema.ErrorClass<TeamRequestError>("TeamRequestError")(
  {
    name: Schema.Literal("TeamRequestError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 400 },
) {}

export const TeamAccessMemberQuery = Schema.Struct({
  sessionID: Schema.String,
})

export const TeamMemberContextQuery = Schema.Struct({
  sessionID: Schema.String,
  // Optional messageID cursor: when present the response carries only the
  // history that precedes that message, so a member process can resume a local
  // transcript mirror from an exact point.
  messageID: Schema.optional(Schema.String),
})

const TeamMemberModelSchema = Schema.Struct({
  provider_id: Schema.String,
  model_id: Schema.String,
  variant: Schema.optional(Schema.String),
}).annotate({ identifier: "TeamMemberModel" })

const TeamMemberContextSchema = Schema.Struct({
  team: TeamInfoSchema,
  member: Schema.Struct({
    id: Schema.String,
    team_id: Schema.String,
    session_id: Schema.String,
    name: Schema.String,
    agent_type: Schema.String,
    model: Schema.NullOr(TeamMemberModelSchema),
    role_prompt: Schema.String,
    status: Schema.String,
    lifecycle: Schema.String,
    daemon_state: Schema.NullOr(Schema.String),
    daemon_last_active: Schema.NullOr(Schema.Number),
    daemon_error: Schema.NullOr(Schema.String),
    plan_mode: Schema.Boolean,
    work_mode: Schema.String,
    dependency_ids: Schema.NullOr(Schema.Array(Schema.String)),
    result: Schema.NullOr(Schema.String),
    time_created: Schema.Number,
    time_updated: Schema.Number,
  }),
  session: Schema.Struct({
    id: Schema.String,
    agent: Schema.optional(Schema.String),
    model: Schema.optional(TeamMemberModelSchema),
    permission: Schema.optional(PermissionV1.Ruleset),
  }),
  // Serialized session message history the member process hydrates before a
  // run. Same wire type as the existing session message REST surface.
  messages: Schema.Array(SessionV1.WithParts),
}).annotate({ identifier: "TeamMemberContext" })

export const TeamRunPayload = Schema.Struct({
  // The persisted run instruction. The lead writes this as a mailbox message to
  // the target member (existing sendMessage semantics: one revision bump, one
  // recipient delivery row) and wakes the member's registered session. The
  // remote member parks on its SSE events stream and reads the instruction from
  // its mailbox claim.
  instruction: Schema.String,
  messageID: Schema.optional(Schema.String),
}).annotate({ identifier: "TeamRunPayload" })

export const TeamFailureCode = Schema.Literals([
  "empty_result",
  "provider_error",
  "dependency_failed",
  "missing_task_handoff",
])

export const TeamResultPayload = Schema.Struct({
  status: Schema.Literals(["completed", "cancelled", "failed"]),
  result: Schema.optional(Schema.String),
  failure_code: Schema.optional(Schema.NullOr(TeamFailureCode)),
  // Opaque transcript cursor reported by the member process. The lead does not
  // interpret it in this slice; it is returned to the member as an
  // acknowledgment so later result reporting can correlate with sync state.
  transcript_cursor: Schema.optional(Schema.String),
}).annotate({ identifier: "TeamResultPayload" })

export const TeamHeartbeatPayload = Schema.Struct({
  daemon_state: Schema.optional(Schema.Literals(["initializing", "running", "idle"])),
  daemon_error: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "TeamHeartbeatPayload" })

export const TeamMemberResultSchema = Schema.Struct({
  member_id: Schema.String,
  session_id: Schema.String,
  status: Schema.String,
}).annotate({ identifier: "TeamMemberResult" })

export const TeamHeartbeatResultSchema = Schema.Struct({
  member_id: Schema.String,
  session_id: Schema.String,
  daemon_last_active: Schema.Number,
}).annotate({ identifier: "TeamHeartbeatResult" })

export const TeamSendMessagePayload = Schema.Struct({
  recipients: Schema.Array(Schema.String),
  body: Schema.String,
}).annotate({ identifier: "TeamSendMessagePayload" })

const TeamMessageAckResultSchema = Schema.Struct({
  acked: Schema.Boolean,
}).annotate({ identifier: "TeamMessageAckResult" })

export const TeamTaskUpdatePayload = Schema.Struct({
  status: Schema.optional(Schema.Literals(["pending", "in_progress", "completed", "cancelled"])),
  assignee: Schema.optional(Schema.String),
  handoff: Schema.optional(TeamTaskHandoffSchema),
  // Canonical pathKeys of handoff.changed_paths. Mirrors the team_task_update tool argument of
  // the same meaning: the service validates these against the task's reserved pathKeys, and the
  // remote member process canonicalizes its own workspace paths before sending them.
  handoff_path_keys: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "TeamTaskUpdatePayload" })

export const TeamPlanPayload = Schema.Struct({
  // submit action
  plan: Schema.optional(Schema.String),
  // decide action
  decision: Schema.optional(Schema.Literals(["approve", "reject"])),
  feedback: Schema.optional(Schema.String),
}).annotate({ identifier: "TeamPlanPayload" })

const TeamPlanResultSchema = Schema.Struct({
  decision: Schema.String,
  member_id: Schema.String,
  session_id: Schema.String,
  messageID: Schema.optional(Schema.String),
}).annotate({ identifier: "TeamPlanResult" })

const TeamTranscriptSyncPayload = ReplayPayload

export const TeamTranscriptSyncResultSchema = Schema.Struct({
  sessionID: Schema.String,
  events: Schema.Number,
  cursor: Schema.Number,
}).annotate({ identifier: "TeamTranscriptSyncResult" })

export const TeamQuery = Schema.Struct({
  sessionID: Schema.String,
})

const TeamAccessQuery = Schema.Struct({
  sessionID: Schema.String,
})

const TeamShutdownQuery = Schema.Struct({
  sessionID: Schema.String,
  force: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
})

const TeamShutdownResultSchema = Schema.Struct({
  team_id: Schema.String,
  cancelled_members: Schema.Number,
  cancelled_tasks: Schema.Number,
  released_reservations: Schema.Number,
  session_cancellation_failures: Schema.Number,
}).annotate({ identifier: "TeamShutdownResult" })

export const TeamApi = HttpApi.make("team").add(
  HttpApiGroup.make("team")
    .add(
      HttpApiEndpoint.get("getBySession", TeamPaths.root, {
        query: TeamQuery,
        success: described(TeamInfoSchema, "Team info"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.get",
          summary: "Get team by lead session",
          description: "Get the latest team for a given lead session ID.",
        }),
      ),
      HttpApiEndpoint.get("getEval", `${TeamPaths.root}/:teamID/eval`, {
        params: { teamID: Schema.String },
        query: TeamAccessQuery,
        success: described(TeamEvalReportSchema, "Team evaluation report"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.eval",
          summary: "Get team evaluation report",
          description: "Build and return the evaluation report for a team.",
        }),
      ),
      HttpApiEndpoint.get("getByTeam", `${TeamPaths.root}/:teamID`, {
        params: { teamID: Schema.String },
        query: TeamAccessQuery,
        success: described(TeamInfoSchema, "Team info"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.getById",
          summary: "Get team by ID",
          description: "Get a team by its team ID.",
        }),
      ),
      HttpApiEndpoint.get("getTasks", `${TeamPaths.root}/:teamID/tasks`, {
        params: { teamID: Schema.String },
        query: TeamAccessQuery,
        success: described(Schema.Array(TeamTaskSchema), "Team tasks"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.tasks",
          summary: "Get team tasks",
          description: "Get all tasks for a team.",
        }),
      ),
      HttpApiEndpoint.get("getMessages", `${TeamPaths.root}/:teamID/messages`, {
        params: { teamID: Schema.String },
        query: TeamAccessQuery,
        success: described(Schema.Array(TeamMessageSchema), "Team messages"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.messages",
          summary: "Get team messages",
          description: "Get all messages for a team.",
        }),
      ),
      HttpApiEndpoint.post("shutdown", `${TeamPaths.root}/:teamID/shutdown`, {
        params: { teamID: Schema.String },
        query: TeamShutdownQuery,
        success: described(TeamShutdownResultSchema, "Team shutdown result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.shutdown",
          summary: "Shutdown team",
          description:
            "Shutdown a team and cancel all non-terminal member sessions and tasks. Lead-only. force=true requires a nonblank reason and bypasses the final-report checkpoint.",
        }),
      ),
      // PR 2 control-plane endpoints (see specs/multiprocess-agent-teams.md).
      // Each endpoint reuses the existing Team.Service and reconciler methods
      // unchanged; the transport adds no durable state of its own.
      HttpApiEndpoint.get("memberContext", TeamMemberPaths.context, {
        params: { teamID: Schema.String, sessionID: Schema.String },
        query: TeamMemberContextQuery,
        success: described(TeamMemberContextSchema, "Team member pre-run context"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.getMemberContext",
          summary: "Get member pre-run context",
          description:
            "Fetch the role prompt, agent, model, permission, and message history a member process needs before a run.",
        }),
      ),
      HttpApiEndpoint.post("runMember", TeamMemberPaths.run, {
        params: { teamID: Schema.String, sessionID: Schema.String },
        query: TeamAccessMemberQuery,
        payload: TeamRunPayload,
        success: described(TeamMemberResultSchema, "Run request accepted"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.runMember",
          summary: "Deliver a run request",
          description:
            "Persist a run instruction to a member's mailbox and wake the member. Lead-only; the member process wakes on its SSE events stream.",
        }),
      ),
      HttpApiEndpoint.post("memberResult", TeamMemberPaths.result, {
        params: { teamID: Schema.String, sessionID: Schema.String },
        query: TeamAccessMemberQuery,
        payload: TeamResultPayload,
        success: described(TeamMemberResultSchema, "Member terminal result settled"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.memberResult",
          summary: "Report member terminal result",
          description:
            "Member reports terminal completion/cancel/failure; the lead settles the member with the existing terminal transaction.",
        }),
      ),
      HttpApiEndpoint.post("memberHeartbeat", TeamMemberPaths.heartbeat, {
        params: { teamID: Schema.String, sessionID: Schema.String },
        query: TeamAccessMemberQuery,
        payload: TeamHeartbeatPayload,
        success: described(TeamHeartbeatResultSchema, "Member liveness recorded"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.memberHeartbeat",
          summary: "Record member heartbeat",
          description: "Refresh a member's daemon_last_active liveness timestamp.",
        }),
      ),
      HttpApiEndpoint.get("memberEvents", TeamMemberPaths.events, {
        params: { teamID: Schema.String, sessionID: Schema.String },
        query: TeamAccessMemberQuery,
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.memberEvents",
          summary: "Subscribe to member events",
          description:
            "Server-sent event stream for a member process: run request wake, pause/cancel, new mail, and plan decisions.",
        }),
      ),
      HttpApiEndpoint.post("messagesSend", TeamMessagePaths.send, {
        params: { teamID: Schema.String },
        query: TeamAccessMemberQuery,
        payload: TeamSendMessagePayload,
        success: described(TeamMessageSchema, "Sent team message"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.messagesSend",
          summary: "Send team message",
          description:
            "Remote mailbox mutation equivalent to sendMessage. The authenticated caller session is the sender.",
        }),
      ),
      HttpApiEndpoint.post("messagesClaim", TeamMessagePaths.claim, {
        params: { teamID: Schema.String },
        query: TeamAccessMemberQuery,
        success: described(Schema.Array(TeamMessageSchema), "Claimed messages"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.messagesClaim",
          summary: "Claim pending messages",
          description:
            "Remote mailbox mutation equivalent to claimPendingMessages for the authenticated caller session.",
        }),
      ),
      HttpApiEndpoint.post("messagesAck", TeamMessagePaths.ack, {
        params: { teamID: Schema.String, messageID: Schema.String },
        query: TeamAccessMemberQuery,
        success: described(TeamMessageAckResultSchema, "Message acknowledged"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.messagesAck",
          summary: "Acknowledge a delivered message",
          description:
            "Remote mailbox mutation equivalent to markMessageDelivered for the authenticated caller session.",
        }),
      ),
      HttpApiEndpoint.post("messagesRelease", TeamMessagePaths.release, {
        params: { teamID: Schema.String, messageID: Schema.String },
        query: TeamAccessMemberQuery,
        success: described(TeamMessageAckResultSchema, "Message released"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.messagesRelease",
          summary: "Release a claimed message",
          description:
            "Remote mailbox mutation equivalent to releaseClaimedMessages for the authenticated caller session.",
        }),
      ),
      HttpApiEndpoint.post("taskClaim", TeamTaskPaths.claim, {
        params: { teamID: Schema.String, taskID: Schema.String },
        query: TeamAccessMemberQuery,
        success: described(TeamTaskSchema, "Claimed task"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.taskClaim",
          summary: "Claim a team task",
          description: "Remote task mutation equivalent to team_task_claim.",
        }),
      ),
      HttpApiEndpoint.post("taskUpdate", TeamTaskPaths.update, {
        params: { teamID: Schema.String, taskID: Schema.String },
        query: TeamAccessMemberQuery,
        payload: TeamTaskUpdatePayload,
        success: described(TeamTaskSchema, "Updated task"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.taskUpdate",
          summary: "Update a team task",
          description: "Remote task mutation equivalent to team_task_update.",
        }),
      ),
      HttpApiEndpoint.post("memberPlan", TeamMemberPaths.plan, {
        params: { teamID: Schema.String, sessionID: Schema.String, action: Schema.Literals(["submit", "decide"]) },
        query: TeamAccessMemberQuery,
        payload: TeamPlanPayload,
        success: described(TeamPlanResultSchema, "Plan submission or decision result"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.memberPlan",
          summary: "Submit or decide a member plan",
          description:
            "Plan-mode submit (member to lead) and decide (lead approve/reject) over the wire. action=submit requires the member session; action=decide requires the lead session.",
        }),
      ),
      HttpApiEndpoint.post("transcriptSync", TeamTranscriptSyncPath, {
        params: { teamID: Schema.String },
        query: TeamAccessMemberQuery,
        payload: TeamTranscriptSyncPayload,
        success: described(TeamTranscriptSyncResultSchema, "Transcript events replayed"),
        error: TeamRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.transcriptSync",
          summary: "Sync member transcript events",
          description:
            "Push member-local session events; the lead replays them into the member session aggregate with the existing projector.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "team",
        description: "Team orchestration endpoints.",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
