import { createComponent, createContext, type JSX, useContext } from "solid-js"
import type { TuiStartupTraceInput } from "@oc2-ai/core/util/tui-startup-profile"

export type TuiPaths = Readonly<{
  cwd: string
  home: string
  state: string
  worktree: string
}>

export type TuiTerminalEnvironment = Readonly<{
  platform: string
  multiplexer?: "tmux" | "screen"
  displayServer?: "wayland" | "x11"
}>

export type TuiStartup = Readonly<{
  initialRoute?: unknown
  skipInitialLoading: boolean
  trace?: (input: TuiStartupTraceInput) => boolean
}>

export function emitTuiStartupTrace(trace: TuiStartup["trace"], input: TuiStartupTraceInput) {
  try {
    return trace?.(input) ?? false
  } catch {
    return false
  }
}

export function isolateTuiStartupTrace(trace: TuiStartup["trace"]): TuiStartup["trace"] {
  if (!trace) return undefined
  return (input) => emitTuiStartupTrace(trace, input)
}

type TuiStartupKeyEvent = Readonly<{
  name: string
  sequence: string
  ctrl: boolean
  meta: boolean
  super?: boolean
  hyper?: boolean
}>

const tuiStartupEditingKeys = new Set(["space", "backspace", "delete", "return", "kpenter", "linefeed"])

export function isTuiStartupEditingKey(event: TuiStartupKeyEvent) {
  if (event.ctrl || event.meta || event.super || event.hyper) return false
  if (tuiStartupEditingKeys.has(event.name)) return true
  if (!event.sequence) return false
  const first = event.sequence.charCodeAt(0)
  return first >= 32 && first !== 127
}

const noopTuiStartupInput = () => {}
const inertTuiStartupInputTrace = Object.freeze({
  mount: noopTuiStartupInput,
  begin: () => noopTuiStartupInput,
  key: noopTuiStartupInput,
  changed: noopTuiStartupInput,
  cleanup: noopTuiStartupInput,
})

export function createTuiStartupInputTrace(trace: TuiStartup["trace"]) {
  if (!trace) return inertTuiStartupInputTrace
  let mounted = false
  let operations = 0
  let accepted = false
  let keyTimer: ReturnType<typeof setTimeout> | undefined
  let endKey: (() => void) | undefined
  const begin = () => {
    if (accepted) return () => {}
    operations++
    let active = true
    return () => {
      if (!active) return
      active = false
      operations = Math.max(0, operations - 1)
    }
  }
  return {
    mount() {
      if (mounted) return
      mounted = true
      emitTuiStartupTrace(trace, {
        event: "prompt.mounted",
        role: "main",
        workspaceGeneration: 0,
        attemptGeneration: 0,
      })
    },
    begin,
    key(event: TuiStartupKeyEvent, disabled = false) {
      if (disabled || !mounted || accepted) return
      if (!isTuiStartupEditingKey(event)) return
      if (keyTimer) clearTimeout(keyTimer)
      endKey?.()
      const end = begin()
      endKey = end
      keyTimer = setTimeout(() => {
        keyTimer = undefined
        end()
        if (endKey === end) endKey = undefined
      }, 0)
    },
    changed() {
      if (!mounted || operations === 0 || accepted) return
      accepted = true
      emitTuiStartupTrace(trace, {
        event: "input.accepted",
        role: "main",
        workspaceGeneration: 0,
        attemptGeneration: 0,
      })
    },
    cleanup() {
      if (keyTimer) clearTimeout(keyTimer)
      endKey?.()
      keyTimer = undefined
      endKey = undefined
      mounted = false
      operations = 0
      accepted = false
    },
  }
}

const PathsContext = createContext<TuiPaths>()
const TerminalEnvironmentContext = createContext<TuiTerminalEnvironment>()
const StartupContext = createContext<TuiStartup>()

function provider<T>(context: ReturnType<typeof createContext<T>>, value: T, children: () => JSX.Element) {
  return createComponent(context.Provider, {
    value: Object.freeze({ ...value }),
    get children() {
      return children()
    },
  })
}

export function TuiPathsProvider(props: { value: TuiPaths; children: JSX.Element }) {
  return provider(PathsContext, props.value, () => props.children)
}

export function TuiTerminalEnvironmentProvider(props: { value: TuiTerminalEnvironment; children: JSX.Element }) {
  return provider(TerminalEnvironmentContext, props.value, () => props.children)
}

export function TuiStartupProvider(props: { value: TuiStartup; children: JSX.Element }) {
  return provider(StartupContext, { ...props.value, trace: isolateTuiStartupTrace(props.value.trace) }, () => props.children)
}

function required<T>(context: ReturnType<typeof createContext<T>>, name: string) {
  const value = useContext(context)
  if (!value) throw new Error(`${name} is missing`)
  return value
}

export function useTuiPaths() {
  return required(PathsContext, "TuiPathsProvider")
}

export function useTuiTerminalEnvironment() {
  return required(TerminalEnvironmentContext, "TuiTerminalEnvironmentProvider")
}

export function useTuiStartup() {
  return required(StartupContext, "TuiStartupProvider")
}
