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

export function createTuiStartupInputTrace(trace: TuiStartup["trace"]) {
  let mounted = false
  let operations = 0
  let accepted = false
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
    begin() {
      if (accepted) return () => {}
      operations++
      let active = true
      return () => {
        if (!active) return
        active = false
        operations = Math.max(0, operations - 1)
      }
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
