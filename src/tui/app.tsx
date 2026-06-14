import type { Readable } from "node:stream"

import type { Oc2Config } from "../config/schema"
import { createRuntimeEventBus } from "../events/event-bus"
import type { ModelProvider } from "../model/provider"
import { createSessionRunService } from "../session/run"
import { parseTuiKey } from "./keymap"
import { SessionView } from "./components/SessionView"
import {
  appendLocalMessage,
  completeTuiRun,
  createInitialTuiState,
  failTuiRun,
  hydrateTuiState,
  projectTuiEvent,
  toggleSidePanel,
  type TuiState,
} from "./state"

export interface TuiLaunchOptions {
  readonly config: Oc2Config
  readonly cwd: string
  readonly dataDir?: string
  readonly sessionId?: string
  readonly model?: string
  readonly providers?: readonly ModelProvider[]
  readonly stdin?: Readable
  readonly stdout?: { write(chunk: string): unknown }
}

/** Renders the minimal TUI snapshot as plain terminal text for both runtime and tests. */
export function renderTui(state: TuiState, input = ""): string {
  return SessionView({ state, input })
}

/** Launches the dependency-free terminal UI adapter over the session run service. */
export async function launchTui(options: TuiLaunchOptions): Promise<void> {
  const eventBus = createRuntimeEventBus<TuiState>({
    initialState: createInitialTuiState(options.config.tui.sidePanel),
    projector: projectTuiEvent,
  })
  const service = createSessionRunService({
    config: options.config,
    cwd: options.cwd,
    dataDir: options.dataDir,
    events: eventBus,
    providers: options.providers,
  })
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  let state = eventBus.getState()
  let input = ""
  let activeRun: AbortController | undefined

  if (options.sessionId) {
    const messages = service.sessions.messages.listBySession(options.sessionId)
    const tools = service.sessions.toolCalls.listBySession(options.sessionId)
    state = hydrateTuiState({ ...state, sessionId: options.sessionId }, messages, tools)
  }

  const render = () => {
    stdout.write(`\x1b[2J\x1b[H${renderTui(state, input)}\n`)
  }
  const unsubscribe = eventBus.all((event) => {
    state = projectTuiEvent(state, event)
    render()
  })

  const submit = async () => {
    const prompt = input.trim()
    if (!prompt || state.running) return
    input = ""
    state = appendLocalMessage(state, "user", prompt)
    const runController = new AbortController()
    activeRun = runController
    render()
    try {
      const result = await service.run({
        prompt,
        sessionId: state.sessionId,
        model: options.model,
        signal: runController.signal,
      })
      state = completeTuiRun(state, result, runController.signal.aborted)
    } catch (error) {
      state = failTuiRun(state, error, runController.signal.aborted)
    } finally {
      if (activeRun === runController) activeRun = undefined
    }
    render()
  }

  const cleanup = () => {
    unsubscribe()
    if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") stdin.setRawMode(false)
    stdin.pause()
    service.database?.close()
  }

  render()
  if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") stdin.setRawMode(true)
  stdin.setEncoding("utf8")
  stdin.resume()

  await new Promise<void>((resolve) => {
    stdin.on("data", (chunk: string) => {
      const key = parseTuiKey(chunk)
      if (key.action === "cancel") {
        if (activeRun) {
          activeRun.abort(new Error("Cancelled from TUI"))
          activeRun = undefined
          state = { ...state, running: false, status: "cancelled" }
          render()
          return
        }
        cleanup()
        resolve()
        return
      }
      if (key.action === "toggle-side-panel") state = toggleSidePanel(state)
      if (key.action === "backspace") input = input.slice(0, -1)
      if (key.action === "input") input += key.value ?? ""
      if (key.action === "submit") void submit()
      render()
    })
  })
}
