export type TuiKeyAction = "submit" | "cancel" | "toggle-side-panel" | "backspace" | "input" | "noop"

export interface TuiKeyBinding {
  readonly action: TuiKeyAction
  readonly value?: string
}

export const TUI_KEYMAP = {
  cancel: "Ctrl+C",
  toggleSidePanel: "Ctrl+S",
  submit: "Enter",
} as const

/** Converts raw terminal key chunks into high-level TUI actions. */
export function parseTuiKey(input: string): TuiKeyBinding {
  if (input === "\u0003") return { action: "cancel" }
  if (input === "\u0013") return { action: "toggle-side-panel" }
  if (input === "\r" || input === "\n") return { action: "submit" }
  if (input === "\u007f" || input === "\b") return { action: "backspace" }
  if (/^[\x20-\x7e]+$/.test(input)) return { action: "input", value: input }
  return { action: "noop" }
}
