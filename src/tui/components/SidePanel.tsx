import { ToolCallView } from "./ToolCallView"
import type { TuiState } from "../state"

export function SidePanel({ state }: { readonly state: TuiState }): string {
  if (!state.sidePanel) return ""
  const tools = state.toolCalls.length
    ? state.toolCalls.map((call) => `- ${ToolCallView({ call })}`).join("\n")
    : "No tool calls."
  return [`Session: ${state.sessionId ?? "new"}`, `Status: ${state.status}`, "Tools:", tools].join("\n")
}
