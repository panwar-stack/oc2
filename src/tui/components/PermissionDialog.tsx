import type { TuiState } from "../state"

export function PermissionDialog({ state }: { readonly state: TuiState }): string {
  const pending = state.permissions.filter((permission) => permission.status === "pending")
  const denied = state.permissions.filter((permission) => permission.status === "deny")
  if (!pending.length && !denied.length) return "Permissions:\n- none"
  return [
    "Permissions:",
    ...pending.map((permission) =>
      `- pending ${permission.toolName ?? permission.permissionId}: ${permission.action ?? "tool"} ${permission.resource ?? ""}`.trim(),
    ),
    ...denied.map(
      (permission) =>
        `- denied ${permission.toolName ?? permission.permissionId}${permission.reason ? `: ${permission.reason}` : ""}`,
    ),
  ].join("\n")
}
