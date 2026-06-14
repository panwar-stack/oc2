import type { TuiState } from "../state"

export function MessageList({ state }: { readonly state: TuiState }): string {
  const persisted = state.messages.map((message) => `${message.role}> ${message.text || "(empty)"}`)
  const streaming = state.streamingText ? [`assistant> ${state.streamingText}`] : []
  return [...persisted, ...streaming].join("\n") || "No messages yet."
}
