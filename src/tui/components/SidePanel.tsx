import { ToolCallView } from "./ToolCallView"
import type { TuiState } from "../state"

export function SidePanel({ state }: { readonly state: TuiState }): string {
  if (!state.sidePanel) return ""
  const tools = state.toolCalls.length
    ? state.toolCalls.map((call) => `- ${ToolCallView({ call })}`).join("\n")
    : "No tool calls."
  const plans = state.pendingPlanApprovals.length
    ? state.pendingPlanApprovals.map((approval) => `- ${approval.memberName}: ${approval.status}`).join("\n")
    : "No pending plan approvals."
  return [
    `Session: ${state.sessionId ?? "new"}`,
    `Status: ${state.status}`,
    `Team report: ${state.teamReportAvailable ? "available" : "not generated"}`,
    "Pending plans:",
    plans,
    "Tools:",
    tools,
  ].join("\n")
}
