export type TuiKeyAction =
  | "submit"
  | "cancel"
  | "toggle-side-panel"
  | "toggle-team-panel"
  | "toggle-mcp-panel"
  | "toggle-agent-panel"
  | "escape"
  | "backspace"
  | "input"
  | "newline"
  | "tab"
  | "clear-messages"
  | "session-switcher"
  | "model-picker-toggle"
  | "variant-cycle"
  | "picker-up"
  | "picker-down"
  | "noop"

export interface TuiKeyBinding {
  readonly action: TuiKeyAction
  readonly value?: string
}

export const TUI_KEYMAP = {
  cancel: "Ctrl+C",
  toggleSidePanel: "Ctrl+S",
  toggleTeamPanel: "Ctrl+T",
  toggleMcpPanel: "Ctrl+M",
  toggleAgentPanel: "Ctrl+A",
  clearMessages: "Ctrl+L",
  sessionSwitcher: "Ctrl+R",
  modelPickerToggle: "Ctrl+P",
  variantCycle: "Ctrl+V",
  newline: "Alt+Enter",
  completeSlash: "Tab",
  escape: "Esc",
  submit: "Enter",
} as const

/** Converts raw terminal key chunks into high-level TUI actions. */
export function parseTuiKey(input: string): TuiKeyBinding {
  if (input === "\u0003") return { action: "cancel" }
  if (input === "\u0013") return { action: "toggle-side-panel" }
  if (input === "\u0014") return { action: "toggle-team-panel" }
  if (input === "\u0001") return { action: "toggle-agent-panel" }
  if (input === "\u000c") return { action: "clear-messages" }
  if (input === "\u0012") return { action: "session-switcher" }
  if (input === "\u0010") return { action: "model-picker-toggle" }
  if (input === "\u0016") return { action: "variant-cycle" }
  if (input === "\u001b") return { action: "escape" }
  if (input === "\u001b[A") return { action: "picker-up" }
  if (input === "\u001b[B") return { action: "picker-down" }
  if (input === "\u001b\r" || input === "\u001b\n") return { action: "newline" }
  if (input === "\u001b[77~") return { action: "toggle-mcp-panel" }
  if (input === "\t") return { action: "tab" }
  if (input === "\r" || input === "\n") return { action: "submit" }
  if (input === "\u007f" || input === "\b") return { action: "backspace" }
  if (/^[\x20-\x7e]+$/.test(input)) return { action: "input", value: input }
  return { action: "noop" }
}
