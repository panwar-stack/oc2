// Pure state machine for the prompt input.
//
// Handles history ring navigation and prompt text helpers. All functions are
// pure -- they take state in and return new state out, with no side effects.
//
// The history ring (PromptHistoryState) stores past prompts and tracks
// the current browse position. When the user arrows up at cursor offset 0,
// the current draft is saved and history begins. Arrowing past the end
// restores the draft.
export { displayCharAt, displaySlice, mentionTriggerIndex } from "../prompt-display"
import type { RunPrompt } from "./types"

const HISTORY_LIMIT = 200

export type PromptHistoryState = {
  items: RunPrompt[]
  index: number | null
  draft: string
}

export type PromptMove = {
  state: PromptHistoryState
  text?: string
  cursor?: number
  apply: boolean
}

export function promptCopy(prompt: RunPrompt): RunPrompt {
  return {
    text: prompt.text,
    parts: structuredClone(prompt.parts),
    ...(prompt.mode ? { mode: prompt.mode } : {}),
    ...(prompt.command ? { command: prompt.command } : {}),
  }
}

export function promptSame(a: RunPrompt, b: RunPrompt): boolean {
  return (
    a.mode === b.mode &&
    a.text === b.text &&
    promptPartsSame(a.parts, b.parts) &&
    promptCommandSame(a.command, b.command)
  )
}

function promptCommandSame(a: RunPrompt["command"], b: RunPrompt["command"]) {
  if (!a || !b) return a === b
  return a.name === b.name && a.arguments === b.arguments
}

function promptPartsSame(a: RunPrompt["parts"], b: RunPrompt["parts"]) {
  return a.length === b.length && a.every((part, index) => promptPartSame(part, b[index]))
}

function promptPartSame(a: RunPrompt["parts"][number], b: RunPrompt["parts"][number]) {
  if (a.type !== b.type) return false

  switch (a.type) {
    case "text":
      return (
        b.type === "text" &&
        a.id === b.id &&
        a.text === b.text &&
        a.synthetic === b.synthetic &&
        a.ignored === b.ignored &&
        timeSame(a.time, b.time) &&
        recordSame(a.metadata, b.metadata)
      )
    case "file":
      return (
        b.type === "file" &&
        a.id === b.id &&
        a.mime === b.mime &&
        a.filename === b.filename &&
        a.url === b.url &&
        fileSourceSame(a.source, b.source)
      )
    case "agent":
      return b.type === "agent" && a.id === b.id && a.name === b.name && sourceTextSame(a.source, b.source)
    case "subtask":
      return (
        b.type === "subtask" &&
        a.id === b.id &&
        a.prompt === b.prompt &&
        a.description === b.description &&
        a.agent === b.agent &&
        a.command === b.command &&
        promptModelSame(a.model, b.model)
      )
  }
}

function promptModelSame(
  a: Extract<RunPrompt["parts"][number], { type: "subtask" }>["model"],
  b: Extract<RunPrompt["parts"][number], { type: "subtask" }>["model"],
) {
  if (!a || !b) return a === b
  return a.providerID === b.providerID && a.modelID === b.modelID
}

function timeSame(
  a: Extract<RunPrompt["parts"][number], { type: "text" }>["time"],
  b: Extract<RunPrompt["parts"][number], { type: "text" }>["time"],
) {
  if (!a || !b) return a === b
  return a.start === b.start && a.end === b.end
}

function recordSame(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined) {
  if (!a || !b) return a === b
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => valueSame(a[key], b[key]))
}

function valueSame(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => valueSame(item, b[index]))
    )
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false

  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const keys = Object.keys(aRecord)
  return keys.length === Object.keys(bRecord).length && keys.every((key) => valueSame(aRecord[key], bRecord[key]))
}

function fileSourceSame(
  a: Extract<RunPrompt["parts"][number], { type: "file" }>["source"],
  b: Extract<RunPrompt["parts"][number], { type: "file" }>["source"],
) {
  if (!a || !b) return a === b
  if (a.type !== b.type || !sourceTextSame(a.text, b.text)) return false

  switch (a.type) {
    case "file":
      return b.type === "file" && a.path === b.path
    case "resource":
      return b.type === "resource" && a.clientName === b.clientName && a.uri === b.uri
    case "symbol":
      return (
        b.type === "symbol" &&
        a.path === b.path &&
        a.name === b.name &&
        a.kind === b.kind &&
        a.range.start.line === b.range.start.line &&
        a.range.start.character === b.range.start.character &&
        a.range.end.line === b.range.end.line &&
        a.range.end.character === b.range.end.character
      )
  }
}

function sourceTextSame(
  a: { value: string; start: number; end: number } | undefined,
  b: { value: string; start: number; end: number } | undefined,
) {
  if (!a || !b) return a === b
  return a.value === b.value && a.start === b.start && a.end === b.end
}

export function isExitCommand(input: string): boolean {
  const text = input.trim().toLowerCase()
  return text === "/exit" || text === "/quit" || text === ":q"
}

export function isNewCommand(input: string): boolean {
  return input.trim().toLowerCase() === "/new"
}

export function createPromptHistory(items?: RunPrompt[]): PromptHistoryState {
  const list = (items ?? []).filter((item) => item.text.trim().length > 0).map(promptCopy)
  const next: RunPrompt[] = []
  for (const item of list) {
    if (next.length > 0 && promptSame(next[next.length - 1], item)) {
      continue
    }

    next.push(item)
  }

  return {
    items: next.slice(-HISTORY_LIMIT),
    index: null,
    draft: "",
  }
}

export function pushPromptHistory(state: PromptHistoryState, prompt: RunPrompt): PromptHistoryState {
  if (!prompt.text.trim()) {
    return state
  }

  const next = promptCopy(prompt)
  if (state.items[state.items.length - 1] && promptSame(state.items[state.items.length - 1], next)) {
    return {
      ...state,
      index: null,
      draft: "",
    }
  }

  const items = [...state.items, next].slice(-HISTORY_LIMIT)
  return {
    ...state,
    items,
    index: null,
    draft: "",
  }
}

export function movePromptHistory(state: PromptHistoryState, dir: -1 | 1, text: string, cursor: number): PromptMove {
  if (state.items.length === 0) {
    return { state, apply: false }
  }

  if (dir === -1 && cursor !== 0) {
    return { state, apply: false }
  }

  if (dir === 1 && cursor !== Bun.stringWidth(text)) {
    return { state, apply: false }
  }

  if (state.index === null) {
    if (dir === 1) {
      return { state, apply: false }
    }

    const idx = state.items.length - 1
    return {
      state: {
        ...state,
        index: idx,
        draft: text,
      },
      text: state.items[idx].text,
      cursor: 0,
      apply: true,
    }
  }

  const idx = state.index + dir
  if (idx < 0) {
    return { state, apply: false }
  }

  if (idx >= state.items.length) {
    return {
      state: {
        ...state,
        index: null,
      },
      text: state.draft,
      cursor: Bun.stringWidth(state.draft),
      apply: true,
    }
  }

  return {
    state: {
      ...state,
      index: idx,
    },
    text: state.items[idx].text,
    cursor: dir === -1 ? 0 : Bun.stringWidth(state.items[idx].text),
    apply: true,
  }
}
