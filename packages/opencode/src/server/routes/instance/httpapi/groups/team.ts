import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware } from "../middleware/workspace-routing"
import { described } from "./metadata"
import { TeamBoard } from "@/team/board"

const TeamInfoSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  goal: Schema.String,
  lead_session_id: Schema.String,
  status: Schema.Literals(["active", "closed", "cancelled"]),
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

const TeamTaskSchema = Schema.Struct({
  id: Schema.String,
  team_id: Schema.String,
  description: Schema.String,
  status: Schema.String,
  assignee: Schema.optionalKey(Schema.String),
  dependency_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
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

export const TeamQuery = Schema.Struct({
  sessionID: Schema.optional(Schema.String),
  viewer_session_id: Schema.optional(Schema.String),
})

const TeamViewerQuery = Schema.Struct({
  viewer_session_id: Schema.String,
})

const TeamAccessQuery = Schema.Struct({
  sessionID: Schema.String,
})

const TeamMailboxQuery = Schema.Struct({
  viewer_session_id: Schema.String,
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})

const TeamAttentionDetailSchema = Schema.Struct({
  id: Schema.String,
  member_id: Schema.String,
  kind: Schema.Literals(["plan", "permission", "question"]),
  state: Schema.String,
  detail: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "TeamAttentionDetail" })

const TeamPlanDecisionResultSchema = Schema.Struct({
  changed: Schema.Boolean,
  state: Schema.Literals(["approved", "rejected"]),
  revision: Schema.Number,
}).annotate({ identifier: "TeamPlanDecisionResult" })

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
          summary: "Get active team by session",
          description: "Get the active team for a lead or member session selector.",
        }),
      ),
      HttpApiEndpoint.get("getHistory", `${TeamPaths.root}/history`, {
        query: TeamViewerQuery,
        success: described(Schema.Array(TeamInfoSchema), "Team history"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.history",
          summary: "Get team history",
          description: "Get every team containing the selected lead or member session, newest first.",
        }),
      ),
      HttpApiEndpoint.get("getBoard", `${TeamPaths.root}/:teamID/board`, {
        params: { teamID: Schema.String },
        query: TeamViewerQuery,
        success: described(TeamBoard.Snapshot, "Authoritative team Board snapshot"),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.board",
          summary: "Get team Board",
          description: "Get one coherent, data-minimized Board projection for a team.",
        }),
      ),
      HttpApiEndpoint.get("getMailbox", `${TeamPaths.root}/:teamID/mailbox`, {
        params: { teamID: Schema.String },
        query: TeamMailboxQuery,
        success: described(TeamBoard.MailboxPage, "Recipient-filtered team mailbox"),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.mailbox",
          summary: "Get team mailbox",
          description: "Get one recipient's bounded, cursor-paginated team mailbox.",
        }),
      ),
      HttpApiEndpoint.get("getAttention", `${TeamPaths.root}/:teamID/attention/:attentionID`, {
        params: { teamID: Schema.String, attentionID: Schema.String },
        query: TeamViewerQuery,
        success: described(TeamAttentionDetailSchema, "Team attention detail"),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.attention",
          summary: "Get team attention detail",
          description: "Get bounded plan, permission, or question detail for an authorized team viewer.",
        }),
      ),
      HttpApiEndpoint.post("markMessagesRead", `${TeamPaths.root}/:teamID/messages/read`, {
        params: { teamID: Schema.String },
        query: TeamViewerQuery,
        payload: Schema.Struct({
          message_ids: Schema.Array(Schema.String),
          expected_revision: Schema.Number,
        }),
        success: described(TeamBoard.MarkReadResult, "Mailbox read result"),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound, HttpApiError.Conflict],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.messages.read",
          summary: "Mark team messages read",
          description: "Mark delivered recipient messages read with Board revision compare-and-set.",
        }),
      ),
      HttpApiEndpoint.post("decidePlan", `${TeamPaths.root}/:teamID/plans/:reviewID/decision`, {
        params: { teamID: Schema.String, reviewID: Schema.String },
        query: TeamViewerQuery,
        payload: Schema.Struct({
          decision: Schema.Literals(["approve", "reject"]),
          feedback: Schema.optional(Schema.String),
          expected_revision: Schema.Number,
        }),
        success: described(TeamPlanDecisionResultSchema, "Plan decision result"),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound, HttpApiError.Conflict],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.plans.decision",
          summary: "Decide team plan",
          description: "Approve or reject a submitted teammate plan with Board revision compare-and-set.",
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
        query: TeamAccessQuery,
        success: described(Schema.Boolean, "Team shut down"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "team.shutdown",
          summary: "Shutdown team",
          description: "Shutdown a team and cancel all active member sessions.",
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
