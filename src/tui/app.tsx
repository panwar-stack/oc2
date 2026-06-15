import type { Readable } from "node:stream"

import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { createElement, render, spread } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"

import { createBuiltinCommands } from "../commands/builtins"
import { createCommandRegistry } from "../commands/registry"
import type { CommandRegistry } from "../commands/types"
import type { Oc2Config } from "../config/schema"
import { createRuntimeEventBus } from "../events/event-bus"
import type { ModelProvider, ShallowJsonObject } from "../model/provider"
import { createSessionRunService } from "../session/run"
import type { TuiClient } from "./client"
import { createLocalTuiClient } from "./client.local"
import { SessionView } from "./components/SessionView"
import {
  appendLocalMessage,
  completeTuiRun,
  createInitialTuiState,
  failTuiRun,
  projectTuiEvent,
  type TuiState,
} from "./state"

export interface TuiLaunchOptions {
  readonly config: Oc2Config
  readonly cwd: string
  readonly dataDir?: string
  readonly sessionId?: string
  readonly model?: string
  readonly roots?: readonly string[]
  readonly providers?: readonly ModelProvider[]
  readonly commands?: CommandRegistry
  readonly client?: TuiClient
  readonly stdin?: Readable
  readonly stdout?: { readonly columns?: number; write(chunk: string): unknown }
}

export interface TuiRenderOptions {
  readonly width?: number
}

export const STATIC_TUI_SHELL_LABELS = {
  transcript: "oc2 transcript viewport",
  sidebar: "sidebar placeholder",
  footer: "footer placeholder",
  prompt: "Prompt>",
} as const

/** Renders the legacy minimal TUI snapshot as plain terminal text for tests. */
export function renderTui(state: TuiState, input = "", options: TuiRenderOptions = {}): string {
  return SessionView({ state, input, options })
}

interface ShellSnapshot {
  readonly state: TuiState
  readonly input: string
}

interface ShellController {
  readonly snapshot: () => ShellSnapshot
  readonly subscribe: (listener: () => void) => () => void
}

/** Launches the OpenTUI/Solid renderer shell over the local TUI adapter. */
export async function launchTui(options: TuiLaunchOptions): Promise<void> {
  let renderer: CliRenderer | undefined
  let removeSighup: (() => void) | undefined
  let unsubscribeEvents: (() => void) | undefined
  let unsubscribeShell: (() => void) | undefined
  let service: ReturnType<typeof createSessionRunService> | undefined
  const roots = options.roots ?? [options.cwd]
  const initialState = createInitialTuiState(options.config.tui.sidePanel, {
    config: options.config,
    launchModel: options.model,
  })
  const registry = options.commands ?? createCommandRegistry(createBuiltinCommands())
  const eventBus = createRuntimeEventBus<TuiState>({ initialState, projector: projectTuiEvent })
  if (!options.client) {
    service = createSessionRunService({
      config: options.config,
      cwd: options.cwd,
      dataDir: options.dataDir,
      events: eventBus,
      providers: options.providers,
      commands: registry,
    })
  }
  const client =
    options.client ??
    createLocalTuiClient({
      service: service!,
      events: eventBus,
      commands: registry,
      initialState,
      roots,
      model: options.model,
    })
  const shell = createShellController({ client, initialState, roots, model: options.model })

  if (options.sessionId) {
    const hydrated = await client.sessions.hydrate(options.sessionId)
    shell.setState(options.model ? { ...hydrated.state, modelSelection: initialState.modelSelection } : hydrated.state)
  }

  unsubscribeEvents = client.events.subscribe((event) => {
    shell.setState((state) => projectTuiEvent(state, event))
  })

  try {
    const inputHandlers = [createInputHandler({ shell, client, roots, getRenderer: () => renderer })]
    renderer = await createCliRenderer({
      stdin: options.stdin as NodeJS.ReadStream | undefined,
      stdout: options.stdout as NodeJS.WriteStream | undefined,
      externalOutputMode: "passthrough",
      targetFps: 60,
      gatherStats: false,
      exitOnCtrlC: false,
      useKittyKeyboard: {},
      autoFocus: false,
      openConsoleOnError: false,
      prependInputHandlers: inputHandlers,
    })
    unsubscribeShell = shell.subscribe(() => renderer?.requestRender())

    const done = new Promise<void>((resolve) => renderer?.once("destroy", () => resolve()))
    const onSighup = () => destroyRenderer(renderer)
    process.on("SIGHUP", onSighup)
    removeSighup = () => process.off("SIGHUP", onSighup)

    await render(() => TuiShell({ controller: shell, options }), renderer)
    await done
  } catch (error) {
    destroyRenderer(renderer)
    writeTerminalRestore(options.stdout)
    writeTerminalSafeError(`oc2 tui renderer failed: ${errorMessage(error)}`)
  } finally {
    unsubscribeShell?.()
    unsubscribeEvents?.()
    removeSighup?.()
    destroyRenderer(renderer)
    service?.database?.close()
    writeTerminalRestore(options.stdout)
  }
}

function TuiShell(props: { readonly controller: ShellController; readonly options: TuiLaunchOptions }) {
  const [snapshot, setSnapshot] = createSignal(props.controller.snapshot())
  onCleanup(props.controller.subscribe(() => setSnapshot(props.controller.snapshot())))
  const width = Math.max(40, props.options.stdout?.columns ?? process.stdout.columns ?? 100)
  const showSidebar = props.options.config.tui.sidePanel && width >= 80
  const sidebarWidth = showSidebar ? Math.min(42, Math.max(24, width - 60)) : 0
  const labels = STATIC_TUI_SHELL_LABELS

  return tuiElement("box", { width, height: process.stdout.rows ?? 24, flexDirection: "column" }, [
    tuiElement("box", { flexGrow: 1, minHeight: 0, flexDirection: "row" }, [
      tuiElement("scrollbox", { flexGrow: 1, minWidth: 0 }, [
        tuiElement(() => ({ content: `${labels.transcript}\n${formatTranscript(snapshot().state)}` })),
      ]),
      ...(showSidebar
        ? [
            tuiElement("box", { width: sidebarWidth, flexShrink: 0, border: true }, [
              tuiElement(() => ({ content: `${labels.sidebar}\nsession: ${snapshot().state.sessionId ?? "new"}` })),
            ]),
          ]
        : []),
    ]),
    tuiElement("box", { flexShrink: 0, border: true }, [
      tuiElement(() => ({ content: `${labels.footer} status=${snapshot().state.status}` })),
    ]),
    tuiElement("box", { flexShrink: 0, border: true }, [
      tuiElement(() => ({ content: `${labels.prompt} ${snapshot().input}` })),
    ]),
  ])
}

function tuiElement(props: () => Record<string, unknown>): unknown
function tuiElement(tag: string, props: Record<string, unknown>, children?: unknown[]): unknown
function tuiElement(
  tagOrProps: string | (() => Record<string, unknown>),
  props: Record<string, unknown> = {},
  children: unknown[] = [],
) {
  if (typeof tagOrProps === "function") {
    const element = createElement("text")
    spread(element, () => ({ ...tagOrProps(), children: [] }))
    return element
  }
  const tag = tagOrProps
  const element = createElement(tag)
  spread(element, { ...props, children })
  return element
}

function createShellController(input: {
  readonly client: TuiClient
  readonly initialState: TuiState
  readonly roots: readonly string[]
  readonly model?: string
}) {
  let state = input.initialState
  let promptInput = ""
  let activeRun: AbortController | undefined
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const setState = (next: TuiState | ((current: TuiState) => TuiState)) => {
    state = typeof next === "function" ? next(state) : next
    notify()
  }
  const setInput = (next: string) => {
    promptInput = next
    notify()
  }
  return {
    snapshot: () => ({ state, input: promptInput }),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setState,
    appendInput(value: string) {
      setInput(promptInput + value)
    },
    backspace() {
      setInput(promptInput.slice(0, -1))
    },
    async submit() {
      const prompt = promptInput.trim()
      if (!prompt || activeRun) return
      const runController = new AbortController()
      activeRun = runController
      setInput("")
      setState({ ...appendLocalMessage(state, "user", prompt), running: true, status: "running" })
      try {
        const result = await input.client.sessions.prompt({
          prompt,
          sessionId: state.sessionId,
          ...activeModelInput(state, input.model),
          roots: input.roots,
          signal: runController.signal,
        })
        setState(
          completeTuiRun(state, { sessionId: result.sessionId, status: "completed" }, runController.signal.aborted),
        )
      } catch (error) {
        setState(failTuiRun(state, error, runController.signal.aborted))
      } finally {
        if (activeRun === runController) activeRun = undefined
      }
    },
    cancelActiveRun() {
      if (!activeRun) return false
      activeRun.abort(new Error("Cancelled from TUI"))
      if (state.sessionId) void input.client.sessions.abort(state.sessionId)
      setState(failTuiRun(state, new Error("Cancelled from TUI"), true))
      return true
    },
  }
}

function createInputHandler(input: {
  readonly shell: ReturnType<typeof createShellController>
  readonly client: TuiClient
  readonly roots: readonly string[]
  readonly getRenderer: () => CliRenderer | undefined
}): (sequence: string) => boolean {
  return (sequence) => {
    if (sequence === "\u0003") {
      if (input.shell.cancelActiveRun()) return true
      destroyRenderer(input.getRenderer())
      return true
    }
    if (sequence === "\u0004") {
      destroyRenderer(input.getRenderer())
      return true
    }
    if (sequence === "\r" || sequence === "\n") {
      void input.shell.submit()
      return true
    }
    if (sequence === "\u007f" || sequence === "\b") {
      input.shell.backspace()
      input.getRenderer()?.requestRender()
      return true
    }
    if (sequence >= " " && sequence !== "\u001b") {
      input.shell.appendInput(sequence)
      input.getRenderer()?.requestRender()
      return true
    }
    return false
  }
}

function activeModelInput(
  state: TuiState,
  launchModel: string | undefined,
): { readonly model?: string; readonly modelVariant?: string; readonly modelVariantOptions?: ShallowJsonObject } {
  const model = launchModel ?? `${state.modelSelection.providerId}/${state.modelSelection.modelId}`
  return {
    model,
    modelVariant: state.modelSelection.variantId,
    modelVariantOptions: state.modelSelection.modelVariantOptions,
  }
}

function formatTranscript(state: TuiState): string {
  const rows = [
    ...state.diagnostics.map(
      (diagnostic) => `diagnostic> ${diagnostic.code ? `[${diagnostic.code}] ` : ""}${diagnostic.message}`,
    ),
    ...state.errors.map((error) => `error> ${error}`),
    ...state.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => `${message.role}> ${message.text || "(empty)"}`),
    state.streamingText ? `assistant> ${state.streamingText}` : undefined,
  ].filter((row): row is string => Boolean(row))

  return rows.join("\n") || "No messages yet."
}

function destroyRenderer(renderer: CliRenderer | undefined): void {
  if (!renderer || renderer.isDestroyed) return
  try {
    renderer.setTerminalTitle("")
  } finally {
    renderer.destroy()
  }
}

function writeTerminalRestore(stdout: TuiLaunchOptions["stdout"]): void {
  try {
    ;(stdout ?? process.stdout).write("\x1b[0m\x1b[?25h")
  } catch {
    // Best-effort restoration only. The renderer error path prints a safe line separately.
  }
}

function writeTerminalSafeError(message: string): void {
  process.stderr.write(`${message.replace(/[\r\n]+/g, " ")}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
