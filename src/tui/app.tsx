import type { Readable } from "node:stream"

import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"

import { createBuiltinCommands } from "../commands/builtins"
import { createCommandRegistry } from "../commands/registry"
import type { CommandRegistry } from "../commands/types"
import type { Oc2Config } from "../config/schema"
import { createRuntimeEventBus } from "../events/event-bus"
import type { ModelProvider, ShallowJsonObject } from "../model/provider"
import { createSessionRunService } from "../session/run"
import type { ToolPermissionDecision, ToolPermissionRequest } from "../tools/tool"
import type { TuiClient, TuiSessionSummary } from "./client"
import { createLocalTuiClient } from "./client.local"
import {
  buildSlashMatches,
  buildTuiPaletteCommands,
  filterTuiPaletteCommands,
  resolveSlashCommand,
  type TuiPaletteCommand,
} from "./commands"
import { ModelPicker } from "./components/ModelPicker"
import { SessionView } from "./components/SessionView"
import { SlashSuggestions } from "./components/SlashSuggestions"
import { createTuiKeymap, type TuiFocus, type TuiKeyBinding } from "./keymap"
import { TuiFooter, formatRootLabel } from "./primitives/Footer"
import { getSidebarWidth } from "./primitives/SidebarFrame"
import { TuiToastOverlay } from "./primitives/Toast"
import { tuiElement } from "./primitives/elements"
import { createPromptEditor } from "./prompt-editor"
import {
  appendLocalMessage,
  applyModelPickerSelection,
  closeModelPicker,
  completeTuiRun,
  createInitialTuiState,
  failTuiRun,
  moveModelPickerSelection,
  openModelPicker,
  projectTuiEvent,
  setModelOptions,
  setModelPickerError,
  setModelPickerLoading,
  setModelPickerQuery,
  setSlashState,
  toggleSessionList,
  type TuiState,
} from "./state"
import { resolveTuiTheme, type TuiTheme, type TuiThemeToast } from "./theme"

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
  sidebar: "session sidebar",
  footer: "oc2",
  prompt: "Prompt>",
} as const

/** Renders the legacy minimal TUI snapshot as plain terminal text for tests. */
export function renderTui(state: TuiState, input = "", options: TuiRenderOptions = {}): string {
  return SessionView({ state, input, options })
}

interface ShellSnapshot {
  readonly state: TuiState
  readonly input: string
  readonly sessionTitle?: string
  readonly commandPalette: CommandPaletteState
  readonly sessionList: SessionListState
}

interface CommandPaletteState {
  readonly open: boolean
  readonly query: string
  readonly selectedIndex: number
  readonly commands: readonly TuiPaletteCommand[]
  readonly message?: string
}

export interface SessionListState {
  readonly loading: boolean
  readonly sessions: readonly TuiSessionSummary[]
  readonly error?: string
  readonly selectedIndex: number
}

interface ShellController {
  readonly snapshot: () => ShellSnapshot
  readonly subscribe: (listener: () => void) => () => void
}

interface ShellThemeInput {
  readonly theme: TuiTheme
  readonly toasts: readonly TuiThemeToast[]
}

type TuiDialogDecision = Exclude<ToolPermissionDecision, "ask">

interface TuiDialogResolver {
  readonly resolvePermission: (request: ToolPermissionRequest, signal: AbortSignal) => Promise<TuiDialogDecision>
  readonly resolveQuestion: (input: unknown, signal: AbortSignal) => Promise<unknown>
  readonly resolveCurrent: (input: {
    readonly decision: TuiDialogDecision
    readonly question?: TuiState["questionPrompt"]
    readonly answer?: string
  }) => void
}

/** Launches the OpenTUI/Solid renderer shell over the local TUI adapter. */
export async function launchTui(options: TuiLaunchOptions): Promise<void> {
  let renderer: CliRenderer | undefined
  let removeSighup: (() => void) | undefined
  let unsubscribeEvents: (() => void) | undefined
  let unsubscribeShell: (() => void) | undefined
  let service: ReturnType<typeof createSessionRunService> | undefined
  const roots = options.roots ?? [options.cwd]
  const dialogResolver = createTuiDialogResolver()
  const themeResolution = resolveTuiTheme({ theme: options.config.tui.theme })
  const initialState = createInitialTuiState(options.config.tui.sidePanel, {
    config: options.config,
    launchModel: options.model,
  })
  const themedInitialState: TuiState = {
    ...initialState,
    diagnostics: [...initialState.diagnostics, ...themeResolution.diagnostics],
  }
  const registry = options.commands ?? createCommandRegistry(createBuiltinCommands())
  const eventBus = createRuntimeEventBus<TuiState>({ initialState: themedInitialState, projector: projectTuiEvent })
  if (!options.client) {
    service = createSessionRunService({
      config: options.config,
      cwd: options.cwd,
      dataDir: options.dataDir,
      events: eventBus,
      providers: options.providers,
      commands: registry,
      resolveQuestion: dialogResolver.resolveQuestion,
      resolvePermission: dialogResolver.resolvePermission,
    })
  }
  const client =
    options.client ??
    createLocalTuiClient({
      service: service!,
      events: eventBus,
      commands: registry,
      initialState: themedInitialState,
      roots,
      model: options.model,
    })
  const shell = createShellController({
    client,
    initialState: themedInitialState,
    roots,
    model: options.model,
    themeName: themeResolution.theme.name,
    dialogResolver,
  })

  if (options.sessionId) {
    const hydrated = await client.sessions.hydrate(options.sessionId)
    shell.setSessionTitle(hydrated.session.title)
    shell.setState(
      options.model
        ? {
            ...hydrated.state,
            diagnostics: mergeDiagnostics(themeResolution.diagnostics, hydrated.state.diagnostics),
            modelSelection: themedInitialState.modelSelection,
          }
        : { ...hydrated.state, diagnostics: mergeDiagnostics(themeResolution.diagnostics, hydrated.state.diagnostics) },
    )
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

    await render(() => TuiShell({ controller: shell, options, roots, theme: themeResolution }), renderer)
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

function TuiShell(props: {
  readonly controller: ShellController
  readonly options: TuiLaunchOptions
  readonly roots: readonly string[]
  readonly theme: ShellThemeInput
}) {
  const [snapshot, setSnapshot] = createSignal(props.controller.snapshot())
  onCleanup(props.controller.subscribe(() => setSnapshot(props.controller.snapshot())))
  const width = Math.max(40, props.options.stdout?.columns ?? process.stdout.columns ?? 100)
  const labels = STATIC_TUI_SHELL_LABELS
  const rootLabel = formatRootLabel({ roots: props.roots, cwd: props.options.cwd })

  return tuiElement(
    "box",
    {
      width,
      height: process.stdout.rows ?? 24,
      flexDirection: "column",
      backgroundColor: props.theme.theme.background,
    },
    [
      tuiElement("box", { flexGrow: 1, minHeight: 0, flexDirection: "row" }, [
        tuiElement("scrollbox", { flexGrow: 1, minWidth: 0, backgroundColor: props.theme.theme.background }, [
          tuiElement(() => ({ content: `${labels.transcript}\n${formatTranscript(snapshot().state)}` })),
        ]),
        TuiDynamicSidebar({
          theme: props.theme.theme,
          width,
          title: labels.sidebar,
          content: () => formatSidebar(snapshot().state, { rootLabel, title: snapshot().sessionTitle }),
          visible: () => snapshot().state.sidePanel,
        }),
      ]),
      TuiDynamicDialog({
        theme: props.theme.theme,
        width,
        title: () =>
          snapshot().state.permissions.some((permission) => permission.status === "pending")
            ? "Permission request"
            : undefined,
        content: () => {
          const pendingPermission = snapshot().state.permissions.find((permission) => permission.status === "pending")
          return pendingPermission ? formatPermissionDialog(pendingPermission) : ""
        },
      }),
      TuiDynamicDialog({
        theme: props.theme.theme,
        width,
        title: () =>
          snapshot().state.questionPrompt?.header ?? (snapshot().state.questionPrompt ? "Question" : undefined),
        content: () => {
          const question = snapshot().state.questionPrompt
          return question ? formatQuestionDialog(question) : ""
        },
      }),
      TuiDynamicDialog({
        theme: props.theme.theme,
        width,
        title: () => (snapshot().state.modelPickerOpen ? "Model list" : undefined),
        content: () => ModelPicker({ state: snapshot().state, width: Math.min(width - 4, 76) }),
      }),
      TuiDynamicDialog({
        theme: props.theme.theme,
        width,
        title: () => (snapshot().state.showSessionList ? "Session list" : undefined),
        content: () => formatSessionListDialog(snapshot().state, snapshot().sessionList),
      }),
      TuiDynamicDialog({
        theme: props.theme.theme,
        width,
        title: () => (snapshot().commandPalette.open ? "Command palette" : undefined),
        content: () => formatCommandPalette(snapshot().commandPalette),
      }),
      TuiFooter({
        theme: props.theme.theme,
        rootLabel,
        status: () => snapshot().state.status,
        hints: () => formatFooterHints(snapshot().state),
      }),
      tuiElement(() => ({
        content: SlashSuggestions({
          matches: snapshot().state.slashMatches,
          width,
          active: !snapshot().state.modelPickerOpen && snapshot().state.slashActive,
        }),
        fg: props.theme.theme.text,
      })),
      tuiElement(
        "box",
        {
          flexShrink: 0,
          border: true,
          borderColor: props.theme.theme.borderActive,
          backgroundColor: props.theme.theme.backgroundElement,
        },
        [tuiElement(() => ({ content: `${formatPromptMetadata(snapshot().state)}\n${labels.prompt} ${snapshot().input}` }))],
      ),
      TuiToastOverlay({
        theme: props.theme.theme,
        toasts: [...(snapshot().state.toasts ?? []), ...props.theme.toasts],
        width,
      }),
    ],
  )
}

function createShellController(input: {
  readonly client: TuiClient
  readonly initialState: TuiState
  readonly roots: readonly string[]
  readonly model?: string
  readonly themeName: string
  readonly dialogResolver: TuiDialogResolver
}) {
  let state = input.initialState
  const promptEditor = createPromptEditor()
  let sessionTitle: string | undefined
  let activeRun: AbortController | undefined
  let commandPalette: CommandPaletteState = { open: false, query: "", selectedIndex: 0, commands: [] }
  let sessionList: SessionListState = { loading: false, sessions: [], selectedIndex: 0 }
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const setState = (next: TuiState | ((current: TuiState) => TuiState)) => {
    state = typeof next === "function" ? next(state) : next
    notify()
  }
  const setInput = (next: string) => {
    promptEditor.replace(next)
    notify()
  }
  const setCommandPalette = (next: CommandPaletteState) => {
    commandPalette = next
    notify()
  }
  const setSessionList = (next: SessionListState) => {
    sessionList = next
    notify()
  }
  const rebuildPalette = async (partial: Partial<CommandPaletteState> = {}) => {
    const clientCommands = await input.client.commands.list()
    const next = {
      ...commandPalette,
      ...partial,
      commands: buildTuiPaletteCommands({ clientCommands, state, themeName: input.themeName }),
    }
    setCommandPalette({
      ...next,
      selectedIndex: clampIndex(next.selectedIndex, filterTuiPaletteCommands(next.commands, next.query).length),
    })
  }
  const resetToNewSession = () => {
    sessionTitle = undefined
    setInput("")
    setState({
      ...state,
      sessionId: undefined,
      status: "idle",
      running: false,
      messages: [],
      streamingText: "",
      toolCalls: [],
      errors: [],
      showSessionList: false,
    })
  }
  return {
    snapshot: () => ({ state, input: promptEditor.text(), sessionTitle, commandPalette, sessionList }),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setState,
    setSessionTitle(title: string | undefined) {
      sessionTitle = title
      notify()
    },
    insertInput(value: string) {
      promptEditor.insertText(value)
      notify()
      void refreshSlashState(promptEditor.text())
    },
    insertNewline() {
      promptEditor.insertNewline()
      notify()
      void refreshSlashState(promptEditor.text())
    },
    backspace() {
      promptEditor.deleteBackward()
      notify()
      void refreshSlashState(promptEditor.text())
    },
    deleteForward() {
      promptEditor.deleteForward()
      notify()
      void refreshSlashState(promptEditor.text())
    },
    moveCursorLeft() {
      promptEditor.moveLeft()
      notify()
    },
    moveCursorRight() {
      promptEditor.moveRight()
      notify()
    },
    moveCursorStart() {
      promptEditor.moveStart()
      notify()
    },
    moveCursorEnd() {
      promptEditor.moveEnd()
      notify()
    },
    historyPrev() {
      const changed = promptEditor.historyPrev()
      if (changed) {
        notify()
        void refreshSlashState(promptEditor.text())
      }
      return changed
    },
    historyNext() {
      const changed = promptEditor.historyNext()
      if (changed) {
        notify()
        void refreshSlashState(promptEditor.text())
      }
      return changed
    },
    clearInput() {
      const changed = promptEditor.clear()
      if (changed) {
        notify()
        void refreshSlashState(promptEditor.text())
      }
      return changed
    },
    toggleSidebar() {
      setState({ ...state, sidePanel: !state.sidePanel })
    },
    openCommandPalette() {
      setCommandPalette({ ...commandPalette, open: true, query: "", selectedIndex: 0, message: undefined })
      void rebuildPalette({ open: true, query: "", selectedIndex: 0, message: undefined })
    },
    openStatusDialog() {
      setCommandPalette({
        ...commandPalette,
        open: true,
        query: "",
        selectedIndex: 0,
        message: formatStatusSummary(state),
      })
      void rebuildPalette({ open: true, query: "", selectedIndex: 0, message: formatStatusSummary(state) })
    },
    openThemeList() {
      const message = `Current theme: ${input.themeName}`
      setCommandPalette({ ...commandPalette, open: true, query: "", selectedIndex: 0, message })
      void rebuildPalette({ open: true, query: "", selectedIndex: 0, message })
    },
    newSession() {
      resetToNewSession()
    },
    openSessionList() {
      const opening = !state.showSessionList
      setState(toggleSessionList(state))
      if (opening) void loadSessionList()
    },
    closeCommandPalette() {
      setCommandPalette({ ...commandPalette, open: false, query: "", selectedIndex: 0, message: undefined })
    },
    appendPaletteQuery(value: string) {
      const query = commandPalette.query + value
      setCommandPalette({
        ...commandPalette,
        query,
        selectedIndex: clampIndex(
          commandPalette.selectedIndex,
          filterTuiPaletteCommands(commandPalette.commands, query).length,
        ),
      })
    },
    backspacePaletteQuery() {
      const query = commandPalette.query.slice(0, -1)
      setCommandPalette({
        ...commandPalette,
        query,
        selectedIndex: clampIndex(
          commandPalette.selectedIndex,
          filterTuiPaletteCommands(commandPalette.commands, query).length,
        ),
      })
    },
    movePaletteSelection(delta: number) {
      const count = filterTuiPaletteCommands(commandPalette.commands, commandPalette.query).length
      setCommandPalette({ ...commandPalette, selectedIndex: clampIndex(commandPalette.selectedIndex + delta, count) })
    },
    executePaletteSelection() {
      const matches = filterTuiPaletteCommands(commandPalette.commands, commandPalette.query)
      const command = matches[clampIndex(commandPalette.selectedIndex, matches.length)]
      if (!command) return false
      executeBackedCommand(command.id)
      return true
    },
    openModelPicker() {
      setState(setModelPickerLoading(openModelPicker(state), true))
      void loadModelOptions()
      return true
    },
    closeModelPicker() {
      if (!state.modelPickerOpen) return false
      setState(closeModelPicker(state))
      return true
    },
    closeSessionList() {
      if (!state.showSessionList) return false
      setState({ ...state, showSessionList: false })
      return true
    },
    moveSessionListSelection(delta: number) {
      if (!state.showSessionList) return false
      setSessionList({
        ...sessionList,
        selectedIndex: clampIndex(sessionList.selectedIndex + delta, sessionList.sessions.length),
      })
      return true
    },
    async applySessionListSelection() {
      if (!state.showSessionList || sessionList.loading) return false
      const session = sessionList.sessions[clampIndex(sessionList.selectedIndex, sessionList.sessions.length)]
      if (!session) return false
      try {
        const hydrated = await input.client.sessions.hydrate(session.id)
        sessionTitle = hydrated.session.title
        setInput("")
        setState({ ...hydrated.state, showSessionList: false })
      } catch (error) {
        setState((current) => appendDiagnosticError(current, `Failed to hydrate session ${session.id}: ${errorMessage(error)}`))
      }
      return true
    },
    moveModelPickerSelection(delta: number) {
      if (!state.modelPickerOpen) return false
      setState(moveModelPickerSelection(state, delta))
      return true
    },
    appendModelPickerQuery(value: string) {
      if (!state.modelPickerOpen) return false
      setState(setModelPickerQuery(state, state.modelPickerQuery + value))
      return true
    },
    backspaceModelPickerQuery() {
      if (!state.modelPickerOpen) return false
      setState(setModelPickerQuery(state, state.modelPickerQuery.slice(0, -1)))
      return true
    },
    applyModelPickerSelection() {
      if (!state.modelPickerOpen) return false
      setState(applyModelPickerSelection(state))
      return true
    },
    async submit() {
      if (resolveDialog("allow")) return
      const prompt = promptEditor.text().trim()
      if (!prompt || activeRun) return
      const slash = parseSlashPrompt(prompt)
      if (slash) {
        await submitSlashCommand(prompt, slash)
        return
      }
      const runController = new AbortController()
      activeRun = runController
      if (!sessionTitle) sessionTitle = formatSessionTitle(prompt)
      promptEditor.recordHistory(prompt)
      setInput("")
      setState({ ...appendLocalMessage(state, "user", prompt), running: true, status: "running" })
      try {
        const result = await input.client.sessions.prompt({
          prompt,
          sessionId: state.sessionId,
          ...activeModelInput(state),
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
    resolveDialog,
  }

  async function refreshSlashState(value: string): Promise<void> {
    const parsed = parseSlashPrompt(value)
    if (!parsed) {
      setState((current) =>
        current.slashActive
          ? setSlashState(current, { slashActive: false, slashQuery: "", slashMatches: [] })
          : current,
      )
      return
    }
    try {
      const commands = await input.client.commands.list()
      if (promptEditor.text() !== value) return
      setState((current) =>
        setSlashState(current, {
          slashActive: true,
          slashQuery: parsed.name,
          slashMatches: buildSlashMatches(commands, parsed.name),
        }),
      )
    } catch (error) {
      setState((current) => appendDiagnosticError(current, `Failed to load slash commands: ${errorMessage(error)}`))
    }
  }

  async function submitSlashCommand(
    prompt: string,
    slash: { readonly name: string; readonly args: readonly string[] },
  ): Promise<void> {
    let commands: Awaited<ReturnType<TuiClient["commands"]["list"]>>
    try {
      commands = await input.client.commands.list()
    } catch (error) {
      setState((current) => appendDiagnosticError(current, `Failed to load slash commands: ${errorMessage(error)}`))
      return
    }

    const command = resolveSlashCommand(commands, slash.name)
    if (!command) {
      setState((current) => appendDiagnosticError(current, `Unknown slash command: /${slash.name}`))
      return
    }

    const runController = new AbortController()
    activeRun = runController
    setState((current) => ({ ...current, running: true, status: "running" }))
    try {
      const result = await input.client.commands.execute({
        name: slash.name,
        args: slash.args,
        raw: prompt,
        sessionId: state.sessionId,
        ...activeModelInput(state),
        roots: input.roots,
        signal: runController.signal,
      })
      if (!result.ok) {
        setState((current) =>
          appendDiagnosticError(current, result.message ?? `Slash command failed: /${command.slashName ?? slash.name}`),
        )
        return
      }
      promptEditor.recordHistory(prompt)
      setInput("")
      setState((current) =>
        setSlashState(
          completeTuiRun(
            current,
            { sessionId: result.sessionId ?? current.sessionId ?? "", status: "completed" },
            false,
          ),
          { slashActive: false, slashQuery: "", slashMatches: [] },
        ),
      )
    } catch (error) {
      setState((current) => appendDiagnosticError(current, errorMessage(error)))
    } finally {
      if (activeRun === runController) activeRun = undefined
    }
  }

  function executeBackedCommand(commandId: string): void {
    if (commandId.startsWith("slash.")) {
      setCommandPalette({ ...commandPalette, message: "Slash commands run from the prompt" })
      return
    }
    switch (commandId) {
      case "app.toggleSidebar":
        setState({ ...state, sidePanel: !state.sidePanel })
        setCommandPalette({ ...commandPalette, open: false })
        return
      case "status.open":
        setCommandPalette({ ...commandPalette, message: formatStatusSummary(state) })
        return
      case "theme.list":
        setCommandPalette({ ...commandPalette, message: `Current theme: ${input.themeName}` })
        return
      case "model.list":
        setState(setModelPickerLoading(openModelPicker(state), true))
        setCommandPalette({ ...commandPalette, open: false })
        void loadModelOptions()
        return
      case "session.new":
        resetToNewSession()
        setCommandPalette({ ...commandPalette, open: false })
        return
      case "session.list":
        setState(toggleSessionList(state))
        setCommandPalette({ ...commandPalette, open: false })
        void loadSessionList()
        return
    }
  }

  async function loadModelOptions(): Promise<void> {
    try {
      const result = await input.client.models.list()
      setState((current) => {
        const withOptions = setModelOptions(current, result.options, result.providerCount)
        return result.errors.length > 0 ? setModelPickerError(withOptions, result.errors.join("; ")) : withOptions
      })
    } catch (error) {
      setState((current) => setModelPickerError(setModelOptions(current, [], 0), errorMessage(error)))
    }
  }

  async function loadSessionList(): Promise<void> {
    setSessionList({ loading: true, sessions: [], selectedIndex: 0 })
    try {
      const sessions = await input.client.sessions.list({ roots: input.roots })
      const currentIndex = sessions.findIndex((session) => session.id === state.sessionId)
      setSessionList({
        loading: false,
        sessions,
        selectedIndex: currentIndex >= 0 ? currentIndex : 0,
      })
    } catch (error) {
      setSessionList({ loading: false, sessions: [], selectedIndex: 0, error: errorMessage(error) })
    }
  }

  function resolveDialog(decision: TuiDialogDecision): boolean {
    const permission = state.permissions.find((item) => item.status === "pending")
    const question = state.questionPrompt
    if (!permission && !question) return false
    input.dialogResolver.resolveCurrent({ decision, question, answer: promptEditor.text().trim() || undefined })
    setInput("")
    if (permission) {
      setState((current) =>
        projectTuiEvent(current, {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          type: "permission.resolved",
          payload: {
            permissionId: permission.permissionId,
            decision,
            toolName: permission.toolName,
            reason: decision === "deny" ? "resolved from TUI" : undefined,
          },
        }),
      )
    } else if (question) {
      setState({ ...state, questionPrompt: undefined })
    }
    return true
  }
}

function createInputHandler(input: {
  readonly shell: ReturnType<typeof createShellController>
  readonly client: TuiClient
  readonly roots: readonly string[]
  readonly getRenderer: () => CliRenderer | undefined
}): (sequence: string) => boolean {
  const keymap = createTuiKeymap()
  return (sequence) => {
    const snapshot = input.shell.snapshot()
    const focus = resolveFocus(snapshot)
    const binding = keymap.handle(sequence, focus)
    const handled = handleKeyBinding(binding, input)
    if (handled) input.getRenderer()?.requestRender()
    return handled
  }
}

function handleKeyBinding(
  binding: TuiKeyBinding,
  input: {
    readonly shell: ReturnType<typeof createShellController>
    readonly getRenderer: () => CliRenderer | undefined
  },
): boolean {
  const snapshot = input.shell.snapshot()
  if (snapshot.commandPalette.open) return handlePaletteKey(binding, input)
  if (snapshot.state.modelPickerOpen) return handleModelPickerKey(binding, input)
  if (snapshot.state.showSessionList) return handleSessionListKey(binding, input)
  if (
    (snapshot.state.permissions.some((permission) => permission.status === "pending") ||
      snapshot.state.questionPrompt) &&
    (binding.action === "picker-up" || binding.action === "picker-down")
  ) {
    return true
  }
  switch (binding.action) {
    case "cancel":
      if (input.shell.cancelActiveRun()) return true
      if (input.shell.clearInput()) return true
      destroyRenderer(input.getRenderer())
      return true
    case "exit":
      destroyRenderer(input.getRenderer())
      return true
    case "escape":
      return input.shell.resolveDialog("deny")
    case "leader":
      return true
    case "command-palette":
      input.shell.openCommandPalette()
      return true
    case "toggle-side-panel":
      input.shell.toggleSidebar()
      return true
    case "status-dialog":
      input.shell.openStatusDialog()
      return true
    case "theme-list":
      input.shell.openThemeList()
      return true
    case "model-picker-toggle":
      return input.shell.openModelPicker()
    case "new-session":
      input.shell.newSession()
      return true
    case "session-switcher":
      input.shell.openSessionList()
      return true
    case "submit":
      void input.shell.submit()
      return true
    case "backspace":
      input.shell.backspace()
      return true
    case "delete-forward":
      input.shell.deleteForward()
      return true
    case "newline":
      input.shell.insertNewline()
      return true
    case "cursor-left":
      input.shell.moveCursorLeft()
      return true
    case "cursor-right":
      input.shell.moveCursorRight()
      return true
    case "cursor-start":
      input.shell.moveCursorStart()
      return true
    case "cursor-end":
      input.shell.moveCursorEnd()
      return true
    case "history-prev":
      return input.shell.historyPrev()
    case "history-next":
      return input.shell.historyNext()
    case "input":
    case "paste":
      if (binding.value) input.shell.insertInput(binding.value)
      return true
    default:
      return false
  }
}

function handleSessionListKey(
  binding: TuiKeyBinding,
  input: {
    readonly shell: ReturnType<typeof createShellController>
    readonly getRenderer: () => CliRenderer | undefined
  },
): boolean {
  switch (binding.action) {
    case "escape":
      return input.shell.closeSessionList()
    case "picker-up":
      return input.shell.moveSessionListSelection(-1)
    case "picker-down":
      return input.shell.moveSessionListSelection(1)
    case "submit":
      void input.shell.applySessionListSelection()
      return true
    case "exit":
      destroyRenderer(input.getRenderer())
      return true
    case "cancel":
      if (input.shell.cancelActiveRun()) return true
      destroyRenderer(input.getRenderer())
      return true
    default:
      return true
  }
}

function handlePaletteKey(
  binding: TuiKeyBinding,
  input: {
    readonly shell: ReturnType<typeof createShellController>
    readonly getRenderer: () => CliRenderer | undefined
  },
): boolean {
  switch (binding.action) {
    case "escape":
      input.shell.closeCommandPalette()
      return true
    case "picker-up":
      input.shell.movePaletteSelection(-1)
      return true
    case "picker-down":
      input.shell.movePaletteSelection(1)
      return true
    case "submit":
      return input.shell.executePaletteSelection()
    case "backspace":
      input.shell.backspacePaletteQuery()
      return true
    case "input":
      if (binding.value) input.shell.appendPaletteQuery(binding.value)
      return true
    case "exit":
      destroyRenderer(input.getRenderer())
      return true
    case "cancel":
      if (input.shell.cancelActiveRun()) return true
      destroyRenderer(input.getRenderer())
      return true
    default:
      return true
  }
}

function handleModelPickerKey(
  binding: TuiKeyBinding,
  input: {
    readonly shell: ReturnType<typeof createShellController>
    readonly getRenderer: () => CliRenderer | undefined
  },
): boolean {
  switch (binding.action) {
    case "escape":
      return input.shell.closeModelPicker()
    case "picker-up":
      return input.shell.moveModelPickerSelection(-1)
    case "picker-down":
      return input.shell.moveModelPickerSelection(1)
    case "submit":
      return input.shell.applyModelPickerSelection()
    case "backspace":
      return input.shell.backspaceModelPickerQuery()
    case "input":
      return binding.value ? input.shell.appendModelPickerQuery(binding.value) : true
    case "exit":
      destroyRenderer(input.getRenderer())
      return true
    case "cancel":
      if (input.shell.cancelActiveRun()) return true
      destroyRenderer(input.getRenderer())
      return true
    default:
      return true
  }
}

function resolveFocus(snapshot: ShellSnapshot): TuiFocus {
  if (snapshot.commandPalette.open || snapshot.state.modelPickerOpen || snapshot.state.showSessionList) return "list"
  if (
    snapshot.state.permissions.some((permission) => permission.status === "pending") ||
    snapshot.state.questionPrompt
  ) {
    return "dialog"
  }
  return "prompt"
}

function activeModelInput(
  state: TuiState,
): { readonly model?: string; readonly modelVariant?: string; readonly modelVariantOptions?: ShallowJsonObject } {
  const model = `${state.modelSelection.providerId}/${state.modelSelection.modelId}`
  return {
    model,
    modelVariant: state.modelSelection.variantId,
    modelVariantOptions: state.modelSelection.modelVariantOptions,
  }
}

function parseSlashPrompt(prompt: string): { readonly name: string; readonly args: readonly string[] } | undefined {
  if (!prompt.startsWith("/") || prompt.startsWith("//")) return undefined
  const [name = "", ...args] = prompt.slice(1).trim().split(/\s+/).filter(Boolean)
  return name ? { name, args } : { name: "", args: [] }
}

function appendDiagnosticError(state: TuiState, message: string): TuiState {
  return {
    ...state,
    running: false,
    status: "failed",
    errors: [...state.errors, message],
    diagnostics: [...state.diagnostics, { code: "tui.slash", message }],
    toasts: [{ id: `tui.slash.${state.diagnostics.length}`, variant: "error", title: "Slash command", message }],
  }
}

function createTuiDialogResolver(): TuiDialogResolver {
  let pendingPermission: ((decision: TuiDialogDecision) => void) | undefined
  let pendingQuestion: ((answer: unknown) => void) | undefined

  return {
    resolvePermission(_request, signal) {
      return new Promise<TuiDialogDecision>((resolve) => {
        pendingPermission = resolve
        signal.addEventListener(
          "abort",
          () => {
            if (pendingPermission === resolve) pendingPermission = undefined
            resolve("deny")
          },
          { once: true },
        )
      })
    },
    resolveQuestion(_input, signal) {
      return new Promise<unknown>((resolve) => {
        pendingQuestion = resolve
        signal.addEventListener(
          "abort",
          () => {
            if (pendingQuestion === resolve) pendingQuestion = undefined
            resolve(undefined)
          },
          { once: true },
        )
      })
    },
    resolveCurrent(input) {
      if (pendingPermission) {
        const resolve = pendingPermission
        pendingPermission = undefined
        resolve(input.decision)
      }
      if (pendingQuestion) {
        const resolve = pendingQuestion
        pendingQuestion = undefined
        resolve(input.decision === "allow" ? resolveQuestionAnswer(input.question, input.answer) : undefined)
      }
    },
  }
}

function resolveQuestionAnswer(question: TuiState["questionPrompt"] | undefined, answer: string | undefined): unknown {
  if (answer) return answer
  return question?.options[0]?.label
}

function formatSessionTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() || "New session"
  return firstLine.length > 48 ? `${firstLine.slice(0, 45)}...` : firstLine
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

function formatFooterHints(state: TuiState): readonly string[] {
  const pendingPermissions = state.permissions.filter((permission) => permission.status === "pending").length
  const mcpServers = state.mcpServers.length
  const mcpResources = state.mcpServers.reduce((total, server) => total + (server.resourceCount ?? 0), 0)
  const activeTeamAndSubagentCount = countActiveTeamAndSubagentItems(state)
  const hasStatusData =
    pendingPermissions > 0 ||
    mcpServers > 0 ||
    activeTeamAndSubagentCount > 0 ||
    state.diagnostics.length > 0 ||
    state.errors.length > 0

  return [
    pendingPermissions > 0 ? `permissions=${pendingPermissions}` : undefined,
    mcpServers > 0 ? `mcp=${mcpServers} servers/${mcpResources} resources` : undefined,
    activeTeamAndSubagentCount > 0 ? `active=${activeTeamAndSubagentCount} team/subagent` : undefined,
    hasStatusData ? "/status" : undefined,
  ].filter((hint): hint is string => Boolean(hint))
}

function TuiDynamicSidebar(props: {
  readonly theme: TuiTheme
  readonly width: number
  readonly title: string
  readonly visible: () => boolean
  readonly content: () => string
}): unknown {
  return tuiElement(
    "box",
    () => {
      const sidebarWidth = getSidebarWidth({ terminalWidth: props.width, visible: props.visible() })
      return {
        width: sidebarWidth,
        flexShrink: 0,
        border: sidebarWidth > 0,
        borderColor: props.theme.border,
        backgroundColor: props.theme.backgroundPanel,
        title: sidebarWidth > 0 ? props.title : undefined,
        titleColor: props.theme.textMuted,
      }
    },
    [tuiElement(() => ({ content: props.visible() ? props.content() : "", fg: props.theme.text }))],
  )
}

function TuiDynamicDialog(props: {
  readonly theme: TuiTheme
  readonly width: number
  readonly title: () => string | undefined
  readonly content: () => string
}): unknown {
  return tuiElement(() => {
    const title = props.title()
    return { content: title ? formatDialogBlock(title, props.content(), props.width) : "", fg: props.theme.text }
  })
}

function formatDialogBlock(title: string, content: string, terminalWidth: number): string {
  const width = Math.max(24, Math.min(60, terminalWidth - 4))
  const innerWidth = width - 4
  const rows = [title, ...content.split("\n")].map((row) => row.slice(0, innerWidth))
  const top = `┌${"─".repeat(width - 2)}┐`
  const bottom = `└${"─".repeat(width - 2)}┘`
  return [top, ...rows.map((row) => `│ ${row.padEnd(innerWidth, " ")} │`), bottom].join("\n")
}

function formatSidebar(state: TuiState, input: { readonly rootLabel: string; readonly title?: string }): string {
  const rows = [
    `session: ${state.sessionId ?? "new"}`,
    input.title ? `title: ${input.title}` : undefined,
    `roots: ${input.rootLabel}`,
    `status: ${state.status}`,
    `model: ${formatModel(state)}`,
    state.modelSelection.variantId || state.modelSelection.variantName
      ? `variant: ${state.modelSelection.variantName ?? state.modelSelection.variantId}`
      : undefined,
    "",
    ...formatToolRows(state),
    ...formatTeamRows(state),
    ...formatMcpRows(state),
    ...formatPermissionRows(state),
    ...formatDiagnosticRows(state),
  ].filter((row): row is string => row !== undefined)

  return rows.join("\n")
}

function formatToolRows(state: TuiState): readonly string[] {
  if (state.toolCalls.length === 0) return ["tools: none"]
  return [
    "tools:",
    ...state.toolCalls.map((tool) => `- ${tool.name}: ${tool.status}${tool.error ? ` error=${tool.error}` : ""}`),
  ]
}

function formatTeamRows(state: TuiState): readonly string[] {
  if (state.teams.length === 0 && state.agentTasks.length === 0) return ["team/subagents: none"]
  return [
    "team/subagents:",
    ...state.teams.flatMap((team) => [
      `- ${team.name ?? team.id}: ${team.status}${team.reportAvailable ? " report" : ""}`,
      ...team.members.map((member) => `  member ${member.name}: ${member.status}`),
    ]),
    ...state.agentTasks.map((task) => `- ${task.kind}:${task.id} ${task.status}`),
  ]
}

function formatMcpRows(state: TuiState): readonly string[] {
  if (state.mcpServers.length === 0) return ["mcp: none"]
  return [
    "mcp:",
    ...state.mcpServers.map(
      (server) =>
        `- ${server.serverId}: ${server.authState ?? server.status} tools=${server.toolCount ?? server.tools.length} resources=${server.resourceCount ?? 0}`,
    ),
  ]
}

function formatPermissionRows(state: TuiState): readonly string[] {
  if (state.permissions.length === 0) return []
  return [
    "permissions:",
    ...state.permissions.map((permission) =>
      [
        `- ${permission.status}`,
        permission.toolName,
        permission.action,
        permission.resource,
        permission.reason ? `reason=${permission.reason}` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  ]
}

function formatDiagnosticRows(state: TuiState): readonly string[] {
  const rows = [
    ...state.diagnostics.map(
      (diagnostic) => `- ${diagnostic.code ? `[${diagnostic.code}] ` : ""}${diagnostic.message}`,
    ),
    ...state.errors.map((error) => `- error: ${error}`),
  ]
  return rows.length > 0 ? ["diagnostics:", ...rows] : ["diagnostics: none"]
}

function formatPermissionDialog(permission: TuiState["permissions"][number]): string {
  return [
    `tool: ${permission.toolName ?? "unknown"}`,
    permission.action ? `action: ${permission.action}` : undefined,
    permission.resource ? `resource: ${permission.resource}` : undefined,
    "Return to allow, Escape to deny",
  ]
    .filter(Boolean)
    .join("\n")
}

function formatQuestionDialog(question: NonNullable<TuiState["questionPrompt"]>): string {
  const options = question.options.length > 0 ? question.options : [{ label: "Type an answer" }]
  return [
    question.question,
    question.multiple ? "Select one or more options:" : "Select an option:",
    ...options.map(
      (option, index) => `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`,
    ),
  ].join("\n")
}

function formatCommandPalette(palette: CommandPaletteState): string {
  const matches = filterTuiPaletteCommands(palette.commands, palette.query).slice(0, 10)
  const rows = matches.length
    ? matches.map((command, index) => {
        const marker = index === palette.selectedIndex ? ">" : " "
        const keys = command.keybindings?.length ? ` [${command.keybindings.join(", ")}]` : ""
        const slash = command.slashName ? ` /${command.slashName}` : ""
        return `${marker} ${command.title}${slash} (${command.category})${keys}${command.description ? ` - ${command.description}` : ""}`
      })
    : ["No enabled commands"]
  return [
    `Search: ${palette.query}`,
    ...rows,
    palette.message,
    "Up/Down or Ctrl+P/Ctrl+N move | Return run | Escape close",
  ]
    .filter((row): row is string => Boolean(row))
    .join("\n")
}

export function formatSessionListDialog(state: TuiState, sessionList: SessionListState): string {
  const rows = sessionList.loading
    ? ["Loading sessions..."]
    : sessionList.error
      ? [`error: ${sessionList.error}`]
      : sessionList.sessions.length > 0
        ? sessionList.sessions.slice(0, 10).map((session, index) => {
            const marker = index === clampIndex(sessionList.selectedIndex, sessionList.sessions.length) ? ">" : " "
            const title = session.title ? ` ${session.title}` : ""
            const roots = session.roots.length > 0 ? ` roots=${session.roots.join(",")}` : ""
            return `${marker} ${session.id}${title}${roots}`
          })
        : ["No sessions found"]
  return [
    state.sessionId ? `current: ${state.sessionId}` : "current: new session",
    ...rows,
    "Up/Down or Ctrl+P/Ctrl+N move | Return switch | Escape close",
  ].join("\n")
}

function formatPromptMetadata(state: TuiState): string {
  const rows = [`Model: ${formatModel(state)}`]
  if (state.modelSelection.variantId || state.modelSelection.variantName) {
    rows.push(`Variant: ${state.modelSelection.variantName ?? state.modelSelection.variantId}`)
  }
  return rows.join(" | ")
}

function formatStatusSummary(state: TuiState): string {
  const pendingPermissions = state.permissions.filter((permission) => permission.status === "pending").length
  return [
    `status: ${state.status}`,
    `diagnostics: ${state.diagnostics.length}`,
    `errors: ${state.errors.length}`,
    `pending permissions: ${pendingPermissions}`,
    `mcp servers: ${state.mcpServers.length}`,
    `teams: ${state.teams.length}`,
    `agent tasks: ${state.agentTasks.length}`,
  ].join(" | ")
}

function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(index, count - 1))
}

function formatModel(state: TuiState): string {
  const provider = state.modelSelection.providerName ?? state.modelSelection.providerId
  const model = state.modelSelection.modelName ?? state.modelSelection.modelId
  return `${provider}/${model}`
}

function countActiveTeamAndSubagentItems(state: TuiState): number {
  const activeTeams = state.teams.filter((team) => isActiveStatus(team.status)).length
  const activeMembers = state.teams.reduce(
    (total, team) => total + team.members.filter((member) => isActiveStatus(member.status)).length,
    0,
  )
  const activeAgentTasks = state.agentTasks.filter((task) => isActiveStatus(task.status)).length
  return activeTeams + activeMembers + activeAgentTasks
}

function isActiveStatus(status: string): boolean {
  return status === "active" || status === "running" || status === "pending" || status === "in_progress"
}

function mergeDiagnostics(
  first: readonly { readonly code?: string; readonly message: string }[],
  second: readonly { readonly code?: string; readonly message: string }[],
): TuiState["diagnostics"] {
  const seen = new Set<string>()
  return [...first, ...second].filter((diagnostic) => {
    const key = `${diagnostic.code ?? ""}:${diagnostic.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
