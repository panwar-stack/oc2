import { AgentStatus } from "./AgentStatus"
import { McpPanel } from "./McpPanel"
import { PermissionDialog } from "./PermissionDialog"
import { QuestionPrompt } from "./QuestionPrompt"
import { TeamPanel } from "./TeamPanel"
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
  const activePanel =
    state.activePanel === "team" ? TeamPanel({ state }) : state.activePanel === "mcp" ? McpPanel({ state }) : ""
  return [
    `Session: ${state.sessionId ?? "new"}`,
    `Status: ${state.status}`,
    `Provider: ${state.modelSelection.providerName ?? state.modelSelection.providerId}`,
    `Model: ${state.modelSelection.modelName ?? state.modelSelection.modelId}`,
    `Variant: ${state.modelSelection.variantName ?? state.modelSelection.variantId ?? "Default"}`,
    AgentStatus({ state }),
    activePanel,
    PermissionDialog({ state }),
    QuestionPrompt({ state }),
    `Team report: ${state.teamReportAvailable ? "available" : "not generated"}`,
    "Pending plans:",
    plans,
    "Tools:",
    tools,
  ].join("\n")
}
