import type { TuiState } from "../state"

export function MessageList({ state }: { readonly state: TuiState }): string {
  const persisted = state.messages.map((message) => `${message.role}> ${message.text || "(empty)"}`)
  const streaming = state.streamingText ? [`assistant> ${state.streamingText}`] : []
  const permissions = state.permissions
    .filter((permission) => permission.status === "pending" || permission.status === "deny")
    .map((permission) => {
      const subject = permission.toolName ?? permission.permissionId
      if (permission.status === "pending") {
        return `permission> pending ${subject}: ${permission.action ?? "tool"} ${permission.resource ?? ""}`.trim()
      }
      return `permission> denied ${subject}${permission.reason ? `: ${permission.reason}` : ""}`
    })
  return [...persisted, ...streaming, ...permissions].join("\n") || "No messages yet."
}
