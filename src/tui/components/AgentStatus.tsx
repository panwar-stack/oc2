import type { TuiState } from "../state"

export function AgentStatus({ state }: { readonly state: TuiState }): string {
  const tasks = state.agentTasks.length
    ? state.agentTasks.map((task) => `- ${task.kind}:${task.id} ${task.status}${task.error ? ` (${task.error})` : ""}`)
    : ["- No active agent tasks."]
  return ["Agent status:", `- Run: ${state.status}${state.running ? " (running)" : ""}`, ...tasks].join("\n")
}
