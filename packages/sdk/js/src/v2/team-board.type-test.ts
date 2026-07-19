import type { Oc2Client } from "./gen/sdk.gen.js"
import type {
  PendingSessionInput,
  PendingSessionInputs,
  TeamBoard,
  TeamBoardOutcome,
  TeamBoardPlanReview,
  TeamBoardTask,
  TeamBoardWorker,
} from "./gen/types.gen.js"

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type _WorkerState = Assert<
  Equal<TeamBoardWorker["state"], "working" | "blocked" | "needs_you" | "idle" | "completed" | "errored">
>
type _WorkerMutability = Assert<Equal<TeamBoardWorker["mutability"], "read_only" | "write_allowed" | "unknown">>
type _TaskStatus = Assert<Equal<TeamBoardTask["status"], "pending" | "in_progress" | "completed" | "cancelled">>
type _PlanState = Assert<Equal<TeamBoardPlanReview["state"], "drafting" | "submitted" | "approved" | "rejected">>
type _OutcomeType = Assert<Equal<TeamBoardOutcome["type"], "succeeded" | "failed" | "cancelled" | "interrupted">>
type _OutcomeLabel = Assert<Equal<TeamBoardOutcome["label"], "completed" | "failed" | "cancelled" | "interrupted">>
type _RoleNullable = Assert<null extends TeamBoardWorker["role"] ? true : false>
type _SummaryNullable = Assert<null extends TeamBoardWorker["display_summary"] ? true : false>
type _CurrentWorkNullable = Assert<null extends TeamBoardWorker["current_work"] ? true : false>
type _ElapsedNullable = Assert<null extends TeamBoardWorker["elapsed_ms"] ? true : false>
type _PlanNullable = Assert<null extends TeamBoardWorker["attention"]["plan"] ? true : false>
type _OutcomeNullable = Assert<null extends TeamBoardWorker["outcome"] ? true : false>
type _AssigneeNullable = Assert<null extends TeamBoardTask["assignee"] ? true : false>
type _StartedNullable = Assert<null extends TeamBoardTask["started_at"] ? true : false>
type _CompletedNullable = Assert<null extends TeamBoardTask["completed_at"] ? true : false>
type _RevisionNumber = Assert<Equal<TeamBoard["revision"], number>>
type _GeneratedAtNumber = Assert<Equal<TeamBoard["generated_at"], number>>
type _PendingRevisionNumber = Assert<Equal<PendingSessionInputs["revision"], number>>
type _PendingSequenceNumber = Assert<Equal<PendingSessionInput["sequence"], number>>
type _PendingTimeNumber = Assert<Equal<PendingSessionInput["time_created"], number>>
type _PendingDelivery = Assert<Equal<PendingSessionInput["delivery"], "queue">>

declare const client: Oc2Client

void client.team.get({ viewer_session_id: "ses_viewer" })
void client.team.history({ viewer_session_id: "ses_viewer" })
void client.team.board({ teamID: "team_id", viewer_session_id: "ses_viewer" })
void client.v2.session.input.pending({ sessionID: "ses_viewer", state: "pending", delivery: "queue" })
