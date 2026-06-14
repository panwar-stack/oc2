export type TuiKeyAction =
  | "submit"
  | "cancel"
  | "toggle-side-panel"
  | "toggle-team-panel"
  | "toggle-mcp-panel"
  | "escape"
  | "backspace"
  | "input"
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
  escape: "Esc",
  submit: "Enter",
} as const

/** Converts raw terminal key chunks into high-level TUI actions. */
export function parseTuiKey(input: string): TuiKeyBinding {
  if (input === "\u0003") return { action: "cancel" }
  if (input === "\u0013") return { action: "toggle-side-panel" }
  if (input === "\u0014") return { action: "toggle-team-panel" }
  if (input === "\u001b") return { action: "escape" }
  if (input === "\u001b[77~") return { action: "toggle-mcp-panel" }
  if (input === "\r" || input === "\n") return { action: "submit" }
  if (input === "\u007f" || input === "\b") return { action: "backspace" }
  if (/^[\x20-\x7e]+$/.test(input)) return { action: "input", value: input }
  return { action: "noop" }
}
