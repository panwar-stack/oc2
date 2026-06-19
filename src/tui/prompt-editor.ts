export interface PromptEditorSnapshot {
  readonly text: string
  readonly cursor: number
  readonly historyIndex?: number
}

export interface PromptEditor {
  readonly snapshot: () => PromptEditorSnapshot
  readonly text: () => string
  readonly hasText: () => boolean
  readonly replace: (value: string) => void
  readonly clear: () => boolean
  readonly insertText: (value: string) => void
  readonly insertNewline: () => void
  readonly deleteBackward: () => void
  readonly deleteForward: () => void
  readonly moveLeft: () => void
  readonly moveRight: () => void
  readonly moveStart: () => void
  readonly moveEnd: () => void
  readonly historyPrev: () => boolean
  readonly historyNext: () => boolean
  readonly recordHistory: (value: string) => void
}

export function createPromptEditor(): PromptEditor {
  let text = ""
  let cursor = 0
  let history: string[] = []
  let historyIndex: number | undefined
  let draftBeforeHistory = ""

  const replace = (value: string) => {
    text = normalizePromptText(value)
    cursor = splitInput(text).length
  }
  const endHistoryNavigation = () => {
    historyIndex = undefined
    draftBeforeHistory = ""
  }

  return {
    snapshot: () => ({ text, cursor, historyIndex }),
    text: () => text,
    hasText: () => text.length > 0,
    replace(value) {
      replace(value)
      endHistoryNavigation()
    },
    clear() {
      if (!text) return false
      replace("")
      endHistoryNavigation()
      return true
    },
    insertText(value) {
      const normalized = normalizePromptText(value)
      if (!normalized) return
      const parts = splitInput(text)
      const inserted = splitInput(normalized)
      text = [...parts.slice(0, cursor), ...inserted, ...parts.slice(cursor)].join("")
      cursor += inserted.length
      endHistoryNavigation()
    },
    insertNewline() {
      this.insertText("\n")
    },
    deleteBackward() {
      if (cursor <= 0) return
      const parts = splitInput(text)
      parts.splice(cursor - 1, 1)
      cursor -= 1
      text = parts.join("")
      endHistoryNavigation()
    },
    deleteForward() {
      const parts = splitInput(text)
      if (cursor >= parts.length) return
      parts.splice(cursor, 1)
      text = parts.join("")
      endHistoryNavigation()
    },
    moveLeft() {
      cursor = Math.max(0, cursor - 1)
    },
    moveRight() {
      cursor = Math.min(splitInput(text).length, cursor + 1)
    },
    moveStart() {
      cursor = 0
    },
    moveEnd() {
      cursor = splitInput(text).length
    },
    historyPrev() {
      if (history.length === 0) return false
      if (historyIndex === undefined) {
        draftBeforeHistory = text
        historyIndex = history.length - 1
      } else {
        historyIndex = Math.max(0, historyIndex - 1)
      }
      replace(history[historyIndex] ?? "")
      return true
    },
    historyNext() {
      if (historyIndex === undefined) return false
      if (historyIndex < history.length - 1) {
        historyIndex += 1
        replace(history[historyIndex] ?? "")
      } else {
        replace(draftBeforeHistory)
        endHistoryNavigation()
      }
      return true
    },
    recordHistory(value) {
      const normalized = normalizePromptText(value)
      if (!normalized.trim()) return
      if (history[history.length - 1] !== normalized) history = [...history, normalized]
      endHistoryNavigation()
    },
  }
}

export function normalizePromptText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function splitInput(value: string): string[] {
  const Segmenter = (
    Intl as typeof Intl & {
      readonly Segmenter?: new (
        locale: string | undefined,
        options: { readonly granularity: "grapheme" },
      ) => {
        segment(input: string): Iterable<{ readonly segment: string }>
      }
    }
  ).Segmenter
  if (Segmenter)
    return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(value), (item) => item.segment)
  return Array.from(value)
}
