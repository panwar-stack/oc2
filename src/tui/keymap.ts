export type TuiKeyAction =
  | "submit"
  | "cancel"
  | "exit"
  | "leader"
  | "command-palette"
  | "status-dialog"
  | "theme-list"
  | "new-session"
  | "toggle-side-panel"
  | "toggle-team-panel"
  | "toggle-mcp-panel"
  | "toggle-agent-panel"
  | "escape"
  | "backspace"
  | "delete-forward"
  | "input"
  | "paste"
  | "newline"
  | "cursor-left"
  | "cursor-right"
  | "cursor-start"
  | "cursor-end"
  | "history-prev"
  | "history-next"
  | "tab"
  | "clear-messages"
  | "session-switcher"
  | "model-picker-toggle"
  | "variant-cycle"
  | "picker-up"
  | "picker-down"
  | "noop"

export type TuiFocus = "prompt" | "dialog" | "list"

export interface TuiKeyBinding {
  readonly action: TuiKeyAction
  readonly value?: string
}

export interface TuiKeymapOptions {
  readonly leaderTimeoutMs?: number
  readonly now?: () => number
}

export const TUI_KEYMAP = {
  cancel: "Ctrl+C",
  toggleSidePanel: "Ctrl+S",
  toggleTeamPanel: "Ctrl+T",
  toggleMcpPanel: "Ctrl+M",
  toggleAgentPanel: "Ctrl+A",
  clearMessages: "Ctrl+L",
  sessionSwitcher: "Ctrl+R",
  commandPalette: "Ctrl+P",
  leader: "Ctrl+X",
  leaderSidebar: "<leader>b",
  leaderStatus: "<leader>s",
  leaderTheme: "<leader>t",
  leaderModel: "<leader>m",
  leaderNewSession: "<leader>n",
  leaderSessionList: "<leader>l",
  leaderExit: "<leader>q",
  variantCycle: "Ctrl+V",
  newline: "Alt+Enter",
  completeSlash: "Tab",
  escape: "Esc",
  submit: "Enter",
} as const

const DEFAULT_LEADER_TIMEOUT_MS = 2000

const KEY_ALIASES: Record<string, string> = {
  enter: "return",
  esc: "escape",
  pgdown: "pagedown",
  pgup: "pageup",
}

export function normalizeTuiKeyName(name: string): string {
  const normalized = name.trim().toLowerCase()
  return KEY_ALIASES[normalized] ?? normalized
}

export function createTuiKeymap(options: TuiKeymapOptions = {}) {
  const timeoutMs = options.leaderTimeoutMs ?? DEFAULT_LEADER_TIMEOUT_MS
  const now = options.now ?? (() => Date.now())
  let leaderAt: number | undefined

  return {
    handle(input: string, focus: TuiFocus = "prompt"): TuiKeyBinding {
      const currentTime = now()
      if (leaderAt !== undefined && currentTime - leaderAt > timeoutMs) leaderAt = undefined
      if (input === "\u0018") {
        leaderAt = currentTime
        return { action: "leader" }
      }
      if (leaderAt !== undefined) {
        leaderAt = undefined
        return parseLeaderKey(input)
      }
      return parseTuiKey(input, focus)
    },
    resetLeader(): void {
      leaderAt = undefined
    },
  }
}

/** Converts raw terminal key chunks into high-level TUI actions. */
export function parseTuiKey(input: string, focus: TuiFocus = "prompt"): TuiKeyBinding {
  const bracketedPaste = parseBracketedPaste(input)
  if (bracketedPaste !== undefined) return { action: "paste", value: bracketedPaste }
  if (input === "\u0003") return { action: "cancel" }
  if (input === "\u0004") return { action: "exit" }
  if (input === "\u0018") return { action: "leader" }
  if (input === "\u0002") return { action: "toggle-side-panel" }
  if (input === "\u0013") return { action: "toggle-side-panel" }
  if (input === "\u0014") return { action: "toggle-team-panel" }
  if (input === "\u0001") return { action: "toggle-agent-panel" }
  if (input === "\u000c") return { action: "clear-messages" }
  if (input === "\u0012") return { action: "session-switcher" }
  if (input === "\u0010") return { action: focus === "prompt" ? "command-palette" : "picker-up" }
  if (input === "\u000e" && focus !== "prompt") return { action: "picker-down" }
  if (input === "\u0016") return { action: "variant-cycle" }
  if (input === "\u001b") return { action: "escape" }
  if (input === "\u001b[A") return { action: focus === "prompt" ? "history-prev" : "picker-up" }
  if (input === "\u001b[B") return { action: focus === "prompt" ? "history-next" : "picker-down" }
  if (input === "\u001b[D") return { action: "cursor-left" }
  if (input === "\u001b[C") return { action: "cursor-right" }
  if (input === "\u001b[H" || input === "\u001b[1~") return { action: "cursor-start" }
  if (input === "\u001b[F" || input === "\u001b[4~") return { action: "cursor-end" }
  if (input === "\u001b[3~") return { action: "delete-forward" }
  if (input === "\u001b[5~") return { action: "picker-up" }
  if (input === "\u001b[6~") return { action: "picker-down" }
  if (isModifiedEnter(input)) return { action: "newline" }
  if (input === "\u001b[77~") return { action: "toggle-mcp-panel" }
  if (input === "\t") return { action: "tab" }
  if (input === "\n") return { action: "newline" }
  if (input === "\r") return { action: "submit" }
  if (input === "\u007f" || input === "\b") return { action: "backspace" }
  if (isPrintableInput(input)) return { action: "input", value: input }
  return { action: "noop" }
}

function parseBracketedPaste(input: string): string | undefined {
  const start = "\u001b[200~"
  const end = "\u001b[201~"
  return input.startsWith(start) && input.endsWith(end) ? input.slice(start.length, -end.length) : undefined
}

function isModifiedEnter(input: string): boolean {
  return (
    input === "\u001b\r" ||
    input === "\u001b\n" ||
    input === "\u001b[13;2u" ||
    input === "\u001b[13;5u" ||
    input === "\u001b[13;6u" ||
    input === "\u001b[13;2~" ||
    input === "\u001b[13;5~" ||
    input === "\u001b[27;2;13~" ||
    input === "\u001b[27;5;13~"
  )
}

function isPrintableInput(input: string): boolean {
  return Array.from(input).some((item) => item.codePointAt(0)! >= 32) && !Array.from(input).some(isControlInput)
}

function isControlInput(input: string): boolean {
  const code = input.codePointAt(0)!
  return code < 32 || code === 127
}

function parseLeaderKey(input: string): TuiKeyBinding {
  switch (input.toLowerCase()) {
    case "q":
      return { action: "exit" }
    case "b":
      return { action: "toggle-side-panel" }
    case "s":
      return { action: "status-dialog" }
    case "t":
      return { action: "theme-list" }
    case "m":
      return { action: "model-picker-toggle" }
    case "n":
      return { action: "new-session" }
    case "l":
      return { action: "session-switcher" }
    default:
      return { action: "noop" }
  }
}
