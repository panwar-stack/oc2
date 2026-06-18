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
import type { TuiClient } from "./client"
import { createLocalTuiClient } from "./client.local"
import { SessionView } from "./components/SessionView"
import { TuiFooter, formatRootLabel } from "./primitives/Footer"
import { getSidebarWidth } from "./primitives/SidebarFrame"
import { TuiToastOverlay } from "./primitives/Toast"
import { tuiElement } from "./primitives/elements"
import {
  appendLocalMessage,
  completeTuiRun,
  createInitialTuiState,
  failTuiRun,
  projectTuiEvent,
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
        title: () => (snapshot().state.permissions.some((permission) => permission.status === "pending") ? "Permission request" : undefined),
        content: () => {
          const pendingPermission = snapshot().state.permissions.find((permission) => permission.status === "pending")
          return pendingPermission ? formatPermissionDialog(pendingPermission) : ""
        },
      }),
      TuiDynamicDialog({
        theme: props.theme.theme,
        width,
        title: () => snapshot().state.questionPrompt?.header ?? (snapshot().state.questionPrompt ? "Question" : undefined),
        content: () => {
          const question = snapshot().state.questionPrompt
          return question ? formatQuestionDialog(question) : ""
        },
      }),
      TuiFooter({
        theme: props.theme.theme,
        rootLabel,
        status: () => snapshot().state.status,
        hints: () => formatFooterHints(snapshot().state),
      }),
      tuiElement(
        "box",
        {
          flexShrink: 0,
          border: true,
          borderColor: props.theme.theme.borderActive,
          backgroundColor: props.theme.theme.backgroundElement,
        },
        [tuiElement(() => ({ content: `${labels.prompt} ${snapshot().input}` }))],
      ),
      TuiToastOverlay({ theme: props.theme.theme, toasts: props.theme.toasts, width }),
    ],
  )
}

function createShellController(input: {
  readonly client: TuiClient
  readonly initialState: TuiState
  readonly roots: readonly string[]
  readonly model?: string
  readonly dialogResolver: TuiDialogResolver
}) {
  let state = input.initialState
  let promptInput = ""
  let sessionTitle: string | undefined
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
    snapshot: () => ({ state, input: promptInput, sessionTitle }),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setState,
    setSessionTitle(title: string | undefined) {
      sessionTitle = title
      notify()
    },
    appendInput(value: string) {
      setInput(promptInput + value)
    },
    backspace() {
      setInput(promptInput.slice(0, -1))
    },
    toggleSidebar() {
      setState({ ...state, sidePanel: !state.sidePanel })
    },
    async submit() {
      if (resolveDialog("allow")) return
      const prompt = promptInput.trim()
      if (!prompt || activeRun) return
      const runController = new AbortController()
      activeRun = runController
      if (!sessionTitle) sessionTitle = formatSessionTitle(prompt)
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
    resolveDialog,
  }

  function resolveDialog(decision: TuiDialogDecision): boolean {
    const permission = state.permissions.find((item) => item.status === "pending")
    const question = state.questionPrompt
    if (!permission && !question) return false
    input.dialogResolver.resolveCurrent({ decision, question, answer: promptInput.trim() || undefined })
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
  return (sequence) => {
    if (sequence === "\u0003") {
      if (input.shell.cancelActiveRun()) return true
      destroyRenderer(input.getRenderer())
      return true
    }
    if (sequence === "\u001b") {
      if (input.shell.resolveDialog("deny")) return true
      return false
    }
    if (sequence === "\u0004") {
      destroyRenderer(input.getRenderer())
      return true
    }
    if (sequence === "\u0002") {
      input.shell.toggleSidebar()
      input.getRenderer()?.requestRender()
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
    pendingPermissions > 0 || mcpServers > 0 || activeTeamAndSubagentCount > 0 || state.diagnostics.length > 0 || state.errors.length > 0

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
    ...state.diagnostics.map((diagnostic) => `- ${diagnostic.code ? `[${diagnostic.code}] ` : ""}${diagnostic.message}`),
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
    ...options.map((option, index) => `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`),
  ].join("\n")
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
