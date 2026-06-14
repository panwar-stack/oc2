import type { TuiToolCallView as ToolCall } from "../state"

export function ToolCallView({ call }: { readonly call: ToolCall }): string {
  const suffix = call.error ? `: ${call.error}` : ""
  return `${call.name} [${call.status}]${suffix}`
}
