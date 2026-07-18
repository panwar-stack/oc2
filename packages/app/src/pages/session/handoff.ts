import type { SelectedLineRange } from "@/context/file"
import { createSignal } from "solid-js"

type HandoffSession = {
  prompt: string
  files: Record<string, SelectedLineRange | null>
}

const MAX = 40

const store = {
  session: new Map<string, HandoffSession>(),
  navigationPrompt: new Map<string, string>(),
  terminal: new Map<string, string[]>(),
}
const [sessionPromptHandoffVersion, setSessionPromptHandoffVersion] = createSignal(0)

const touch = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX) {
    const first = map.keys().next().value
    if (first === undefined) return
    map.delete(first)
  }
}

export const setSessionHandoff = (key: string, patch: Partial<HandoffSession>) => {
  const prev = store.session.get(key) ?? { prompt: "", files: {} }
  touch(store.session, key, { ...prev, ...patch })
}

export const getSessionHandoff = (key: string) => store.session.get(key)

export const setSessionPromptHandoff = (key: string, prompt: string) => {
  touch(store.navigationPrompt, key, prompt)
  setSessionPromptHandoffVersion((version) => version + 1)
}

export { sessionPromptHandoffVersion }

export const takeSessionPromptHandoff = (key: string) => {
  const prompt = store.navigationPrompt.get(key)
  store.navigationPrompt.delete(key)
  return prompt
}

export const setTerminalHandoff = (key: string, value: string[]) => {
  touch(store.terminal, key, value)
}

export const getTerminalHandoff = (key: string) => store.terminal.get(key)
