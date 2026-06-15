import { resolveMainAgentProfile } from "../agent/profiles"
import type { Oc2Config } from "../config/schema"
import type { RuntimeEvent, RuntimeEventMap, RuntimeEventProjector } from "../events/events"
import { redactText } from "../logging/redaction"
import type { ModelInfo, ShallowJsonObject } from "../model/provider"
import type { PersistedToolCall } from "../persistence/repositories/tool-calls"
import type { MessagePart, MessageRole, RuntimeStatus, SessionMessage } from "../session/message"

export interface TuiMessageView {
  readonly id: string
  readonly role: MessageRole | "streaming"
  readonly text: string
  readonly status: RuntimeStatus
}

export interface TuiToolCallView {
  readonly id: string
  readonly name: string
  readonly status: RuntimeStatus
  readonly error?: string
}

export interface TuiPlanApprovalView {
  readonly teamId: string
  readonly memberId: string
  readonly memberName: string
  readonly status: string
}

export type TuiPanel = "session" | "team" | "mcp" | "agent"

export interface SlashMatch {
  readonly name: string
  readonly display: string
  readonly description: string
  readonly source: "tui" | "builtin" | "user" | "skill" | "mcp"
}

export interface TuiModelSelection {
  readonly providerId: string
  readonly providerName?: string
  readonly modelId: string
  readonly modelName?: string
  readonly variantId?: string
  readonly variantName?: string
  readonly modelVariantOptions?: ShallowJsonObject
}

export interface TuiModelOption {
  readonly providerId: string
  readonly providerName: string
  readonly model: ModelInfo
}

export interface TuiVariantOption {
  readonly id?: string
  readonly label: string
  readonly description?: string
  readonly runtimeOptions?: ShallowJsonObject
}

export interface TuiTeamMemberView {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly planStatus?: string
  readonly agentId?: string
  readonly lifecycle?: string
  readonly dependencyIds: readonly string[]
  readonly daemonState?: string
  readonly daemonError?: string
}

export interface TuiTeamTaskView {
  readonly id: string
  readonly status: string
  readonly description?: string
  readonly assignee?: string
  readonly dependencyIds: readonly string[]
}

export interface TuiTeamMessageView {
  readonly id: string
  readonly recipientId: string
  readonly sender?: string
  readonly body?: string
}

export interface TuiTeamView {
  readonly id: string
  readonly name?: string
  readonly goal?: string
  readonly status: string
  readonly reportAvailable: boolean
  readonly members: readonly TuiTeamMemberView[]
  readonly tasks: readonly TuiTeamTaskView[]
  readonly mailbox: readonly TuiTeamMessageView[]
}

export interface TuiMcpServerView {
  readonly serverId: string
  readonly status: string
  readonly toolCount?: number
  readonly tools: readonly string[]
  readonly authRequired: boolean
  readonly authState?: "auth_required" | "callback_pending" | "authenticated" | "refresh_failed"
  readonly error?: string
  readonly resourceCount?: number
  readonly promptCount?: number
  readonly authUrl?: string
}

export interface TuiPermissionView {
  readonly permissionId: string
  readonly toolName?: string
  readonly action?: string
  readonly resource?: string
  readonly callId?: string
  readonly sessionId?: string
  readonly status: "pending" | "allow" | "deny"
  readonly reason?: string
}

export interface TuiQuestionPromptView {
  readonly permissionId: string
  readonly header?: string
  readonly question: string
  readonly options: readonly { readonly label: string; readonly description?: string }[]
  readonly multiple: boolean
}

export interface TuiDiagnosticView {
  readonly message: string
  readonly code?: string
}

export interface TuiAgentTaskView {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly parentTaskId?: string
  readonly error?: string
}

export interface TuiState {
  readonly sessionId?: string
  readonly status: RuntimeStatus
  readonly messages: readonly TuiMessageView[]
  readonly streamingText: string
  readonly toolCalls: readonly TuiToolCallView[]
  readonly errors: readonly string[]
  readonly sidePanel: boolean
  readonly running: boolean
  readonly pendingPlanApprovals: readonly TuiPlanApprovalView[]
  readonly teamReportAvailable: boolean
  readonly activePanel: TuiPanel
  readonly teams: readonly TuiTeamView[]
  readonly mcpServers: readonly TuiMcpServerView[]
  readonly permissions: readonly TuiPermissionView[]
  readonly questionPrompt?: TuiQuestionPromptView
  readonly diagnostics: readonly TuiDiagnosticView[]
  readonly agentTasks: readonly TuiAgentTaskView[]
  readonly slashActive: boolean
  readonly slashQuery: string
  readonly slashMatches: readonly SlashMatch[]
  readonly showSessionList: boolean
  readonly modelSelection: TuiModelSelection
  readonly modelPickerOpen: boolean
  readonly modelPickerMode: "model" | "variant"
  readonly modelPickerQuery: string
  readonly modelPickerSelectedIndex: number
  readonly modelPickerLoading: boolean
  readonly modelPickerError?: string
  readonly modelProviderCount: number
  readonly modelOptions: readonly TuiModelOption[]
  readonly variantOptions: readonly TuiVariantOption[]
}

export interface InitialTuiModelSelectionInput {
  readonly config?: Pick<Oc2Config, "agents" | "model">
  readonly launchModel?: string
}

export const createInitialTuiState = (
  sidePanel = true,
  selectionInput: InitialTuiModelSelectionInput = {},
): TuiState => ({
  status: "idle",
  messages: [],
  streamingText: "",
  toolCalls: [],
  errors: [],
  sidePanel,
  running: false,
  pendingPlanApprovals: [],
  teamReportAvailable: false,
  activePanel: "session",
  teams: [],
  mcpServers: [],
  permissions: [],
  diagnostics: [],
  agentTasks: [],
  slashActive: false,
  slashQuery: "",
  slashMatches: [],
  showSessionList: false,
  modelSelection: createInitialModelSelection(selectionInput),
  modelPickerOpen: false,
  modelPickerMode: "model",
  modelPickerQuery: "",
  modelPickerSelectedIndex: 0,
  modelPickerLoading: false,
  modelPickerError: undefined,
  modelProviderCount: 0,
  modelOptions: [],
  variantOptions: [],
})

/** Projects runtime events into the narrow state needed by the minimal terminal UI. */
export const projectTuiEvent: RuntimeEventProjector<TuiState> = (state, event) => {
  switch (event.type) {
    case "session.created": {
      const payload = event.payload as RuntimeEventMap["session.created"]
      return { ...state, sessionId: payload.sessionId, status: "idle" }
    }
    case "session.updated": {
      const payload = event.payload as RuntimeEventMap["session.updated"]
      return { ...state, sessionId: payload.sessionId, status: toRuntimeStatus(payload.status, state.status) }
    }
    case "model.started": {
      const payload = event.payload as RuntimeEventMap["model.started"]
      return {
        ...state,
        sessionId: payload.sessionId ?? state.sessionId,
        streamingText: "",
        running: true,
        status: "running",
      }
    }
    case "model.delta": {
      const payload = event.payload as RuntimeEventMap["model.delta"]
      return {
        ...state,
        sessionId: payload.sessionId ?? state.sessionId,
        streamingText: state.streamingText + payload.delta,
        running: true,
      }
    }
    case "model.completed": {
      const payload = event.payload as RuntimeEventMap["model.completed"]
      return appendStreamingMessage({
        ...state,
        sessionId: payload.sessionId ?? state.sessionId,
        running: false,
        status: "completed",
      })
    }
    case "model.failed": {
      const payload = event.payload as RuntimeEventMap["model.failed"]
      return appendError(
        { ...state, sessionId: payload.sessionId ?? state.sessionId, running: false, status: "failed" },
        payload.error.message,
      )
    }
    case "tool.started": {
      const payload = event.payload as RuntimeEventMap["tool.started"]
      return {
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, {
          id: payload.taskId ?? payload.toolName,
          name: payload.toolName,
          status: "running",
        }),
        agentTasks: payload.taskId
          ? upsertAgentTask(state.agentTasks, { id: payload.taskId, kind: "tool", status: "running" })
          : state.agentTasks,
      }
    }
    case "tool.completed": {
      const payload = event.payload as RuntimeEventMap["tool.completed"]
      return {
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, {
          id: payload.taskId ?? payload.toolName,
          name: payload.toolName,
          status: "completed",
        }),
        agentTasks: payload.taskId
          ? upsertAgentTask(state.agentTasks, { id: payload.taskId, kind: "tool", status: "completed" })
          : state.agentTasks,
      }
    }
    case "tool.failed": {
      const payload = event.payload as RuntimeEventMap["tool.failed"]
      return {
        ...state,
        toolCalls: upsertToolCall(state.toolCalls, {
          id: payload.taskId ?? payload.toolName,
          name: payload.toolName,
          status: "failed",
          error: payload.error.message,
        }),
        agentTasks: payload.taskId
          ? upsertAgentTask(state.agentTasks, {
              id: payload.taskId,
              kind: "tool",
              status: "failed",
              error: payload.error.message,
            })
          : state.agentTasks,
      }
    }
    case "permission.requested": {
      const payload = event.payload as RuntimeEventMap["permission.requested"]
      return {
        ...state,
        permissions: upsertPermission(state.permissions, {
          permissionId: payload.permissionId,
          toolName: payload.toolName,
          action: payload.action,
          resource: payload.resource ? redactText(payload.resource) : undefined,
          callId: payload.callId,
          sessionId: payload.sessionId,
          status: "pending",
        }),
        questionPrompt: payload.question
          ? {
              permissionId: payload.permissionId,
              header: payload.question.header ? redactText(payload.question.header) : undefined,
              question: redactText(payload.question.question),
              options: (payload.question.options ?? []).map((option) => ({
                label: redactText(option.label),
                description: option.description ? redactText(option.description) : undefined,
              })),
              multiple: payload.question.multiple ?? false,
            }
          : state.questionPrompt,
      }
    }
    case "permission.resolved": {
      const payload = event.payload as RuntimeEventMap["permission.resolved"]
      return {
        ...state,
        permissions: upsertPermission(state.permissions, {
          permissionId: payload.permissionId,
          toolName: payload.toolName,
          status: payload.decision,
          reason: payload.reason,
        }),
        questionPrompt: state.questionPrompt?.permissionId === payload.permissionId ? undefined : state.questionPrompt,
      }
    }
    case "error": {
      const payload = event.payload as RuntimeEventMap["error"]
      return appendError(state, payload.error.message)
    }
    case "diagnostic.warning": {
      const payload = event.payload as RuntimeEventMap["diagnostic.warning"]
      return { ...state, diagnostics: [...state.diagnostics, { message: payload.message, code: payload.code }] }
    }
    case "scheduler.task.updated": {
      const payload = event.payload as RuntimeEventMap["scheduler.task.updated"]
      return {
        ...state,
        agentTasks: upsertAgentTask(state.agentTasks, {
          id: payload.taskId,
          kind: payload.kind,
          status: payload.status,
          parentTaskId: payload.parentTaskId,
          error: payload.error?.message,
        }),
      }
    }
    case "subagent.updated": {
      const payload = event.payload as RuntimeEventMap["subagent.updated"]
      return {
        ...state,
        agentTasks: upsertAgentTask(state.agentTasks, {
          id: payload.taskId ?? payload.subagentId,
          kind: payload.agentId ? `subagent:${payload.agentId}` : "subagent",
          status: payload.status,
        }),
      }
    }
    case "team.member.updated": {
      const payload = event.payload as RuntimeEventMap["team.member.updated"]
      const withTeam = {
        ...state,
        teams: upsertTeamMember(state.teams, payload),
      }
      if (payload.planStatus === "submitted") {
        return {
          ...withTeam,
          pendingPlanApprovals: upsertPlanApproval(withTeam.pendingPlanApprovals, {
            teamId: payload.teamId,
            memberId: payload.memberId,
            memberName: payload.memberName ?? payload.memberId,
            status: payload.status,
          }),
        }
      }
      if (payload.planStatus === "approved" || payload.planStatus === "rejected") {
        return {
          ...withTeam,
          pendingPlanApprovals: withTeam.pendingPlanApprovals.filter(
            (approval) => approval.memberId !== payload.memberId,
          ),
        }
      }
      return withTeam
    }
    case "team.updated": {
      const payload = event.payload as RuntimeEventMap["team.updated"]
      const withTeam = {
        ...state,
        teams: upsertTeam(state.teams, {
          id: payload.teamId,
          name: payload.name ? redactText(payload.name) : undefined,
          goal: payload.goal ? redactText(payload.goal) : undefined,
          status: payload.status,
          reportAvailable: payload.reportAvailable ?? false,
          members: [],
          tasks: [],
          mailbox: [],
        }),
        teamReportAvailable: payload.reportAvailable ? true : state.teamReportAvailable,
      }
      if (payload.status === "shutdown") {
        return {
          ...withTeam,
          pendingPlanApprovals: withTeam.pendingPlanApprovals.filter((approval) => approval.teamId !== payload.teamId),
        }
      }
      return withTeam
    }
    case "team.task.updated": {
      const payload = event.payload as RuntimeEventMap["team.task.updated"]
      return { ...state, teams: upsertTeamTask(state.teams, payload) }
    }
    case "team.message.delivered": {
      const payload = event.payload as RuntimeEventMap["team.message.delivered"]
      return { ...state, teams: upsertTeamMessage(state.teams, payload) }
    }
    case "mcp.status": {
      const payload = event.payload as RuntimeEventMap["mcp.status"]
      return {
        ...state,
        mcpServers: upsertMcpServer(state.mcpServers, {
          serverId: payload.serverId,
          status: payload.status,
          toolCount: payload.toolCount,
          tools: payload.tools ?? [],
          authRequired:
            payload.authRequired ??
            (payload.status === "auth_required" ||
              payload.authState === "auth_required" ||
              payload.authState === "callback_pending" ||
              payload.authState === "refresh_failed"),
          authState: payload.authState,
          error: payload.error?.message,
          resourceCount: payload.resourceCount,
          promptCount: payload.promptCount,
          authUrl: payload.authUrl,
        }),
      }
    }
    default:
      return state
  }
}

export const toggleSidePanel = (state: TuiState): TuiState => ({ ...state, sidePanel: !state.sidePanel })

export const toggleTeamPanel = (state: TuiState): TuiState => toggleActivePanel(state, "team")

export const toggleMcpPanel = (state: TuiState): TuiState => toggleActivePanel(state, "mcp")

export const toggleAgentPanel = (state: TuiState): TuiState => toggleActivePanel(state, "agent")

export const setSlashState = (
  state: TuiState,
  partial: Partial<Pick<TuiState, "slashActive" | "slashQuery" | "slashMatches">>,
): TuiState => ({ ...state, ...partial })

export function createInitialModelSelection(input: InitialTuiModelSelectionInput = {}): TuiModelSelection {
  const config = input.config
  const fallback = config ? `${config.model.provider}/${config.model.model}` : "fake/test"
  const profileDefault = config ? resolveMainAgentProfile(config).defaultModel : undefined
  const parsed = parseModelSelection(input.launchModel ?? profileDefault ?? fallback, fallback)
  return { providerId: parsed.providerId, modelId: parsed.modelId }
}

export const openModelPicker = (state: TuiState): TuiState => ({
  ...state,
  modelPickerOpen: true,
  modelPickerMode: "model",
  modelPickerQuery: "",
  modelPickerSelectedIndex: 0,
  modelPickerError: undefined,
  slashActive: false,
  slashQuery: "",
  slashMatches: [],
})

export const closeModelPicker = (state: TuiState): TuiState => ({ ...state, modelPickerOpen: false })

export const setModelOptions = (
  state: TuiState,
  modelOptions: readonly TuiModelOption[],
  modelProviderCount = Math.max(
    state.modelProviderCount,
    new Set(modelOptions.map((option) => option.providerId)).size,
  ),
): TuiState => ({
  ...state,
  modelProviderCount,
  modelOptions,
  modelPickerLoading: false,
  modelPickerSelectedIndex: clampPickerIndex(
    state.modelPickerSelectedIndex,
    filterModelOptions(modelOptions, state.modelPickerQuery).length,
  ),
})

export const setModelPickerLoading = (state: TuiState, modelPickerLoading: boolean): TuiState => ({
  ...state,
  modelPickerLoading,
})

export const setModelPickerError = (state: TuiState, modelPickerError: string | undefined): TuiState => ({
  ...state,
  modelPickerError,
  modelPickerLoading: false,
})

export const filterModelOptions = (options: readonly TuiModelOption[], query: string): readonly TuiModelOption[] => {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return options
  return options.filter((option) =>
    [option.providerId, option.providerName, option.model.id, option.model.name]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(normalized)),
  )
}

export function setModelPickerQuery(state: TuiState, query: string): TuiState {
  const count =
    state.modelPickerMode === "model"
      ? filterModelOptions(state.modelOptions, query).length
      : state.variantOptions.length
  return {
    ...state,
    modelPickerQuery: query,
    modelPickerSelectedIndex: clampPickerIndex(state.modelPickerSelectedIndex, count),
  }
}

export function moveModelPickerSelection(state: TuiState, delta: number): TuiState {
  const count =
    state.modelPickerMode === "model"
      ? filterModelOptions(state.modelOptions, state.modelPickerQuery).length
      : state.variantOptions.length
  return { ...state, modelPickerSelectedIndex: clampPickerIndex(state.modelPickerSelectedIndex + delta, count) }
}

export function applyModelPickerSelection(state: TuiState): TuiState {
  if (state.modelPickerMode === "variant") return applyVariantSelection(state)
  const options = filterModelOptions(state.modelOptions, state.modelPickerQuery)
  const option = options[clampPickerIndex(state.modelPickerSelectedIndex, options.length)]
  if (!option) return { ...state, modelPickerError: "No matching models" }
  const variantOptions = buildVariantOptions(option.model)
  const compatibleVariant = variantOptions.find(
    (variant) => variant.id !== undefined && variant.id === state.modelSelection.variantId,
  )
  const selection: TuiModelSelection = {
    providerId: option.providerId,
    providerName: option.providerName,
    modelId: option.model.id,
    modelName: option.model.name,
    variantId: compatibleVariant?.id,
    variantName: compatibleVariant?.label,
    modelVariantOptions: compatibleVariant?.runtimeOptions,
  }
  if (variantOptions.length > 1) {
    return {
      ...state,
      modelSelection: selection,
      modelPickerMode: "variant",
      modelPickerQuery: "",
      modelPickerSelectedIndex: compatibleVariant ? variantOptions.indexOf(compatibleVariant) : 0,
      modelPickerError: undefined,
      variantOptions,
    }
  }
  return {
    ...state,
    modelSelection: selection,
    modelPickerOpen: false,
    modelPickerError: undefined,
    variantOptions: [],
  }
}

export function buildVariantOptions(model: ModelInfo | undefined): readonly TuiVariantOption[] {
  const variants = model?.variants ?? []
  return [
    { id: undefined, label: "Default" },
    ...variants.map((variant) => ({
      id: variant.id,
      label: variant.name ?? variant.id,
      description: variant.description,
      runtimeOptions: variant.runtimeOptions,
    })),
  ]
}

export function applyVariantSelection(state: TuiState): TuiState {
  const option = state.variantOptions[clampPickerIndex(state.modelPickerSelectedIndex, state.variantOptions.length)]
  if (!option) return { ...state, modelPickerError: "No variants for current model" }
  return {
    ...state,
    modelSelection: {
      ...state.modelSelection,
      variantId: option.id,
      variantName: option.id ? option.label : undefined,
      modelVariantOptions: option.id ? option.runtimeOptions : undefined,
    },
    modelPickerOpen: false,
    modelPickerError: undefined,
  }
}

export function cycleModelVariant(state: TuiState): TuiState {
  const model = state.modelOptions.find(
    (option) =>
      option.providerId === state.modelSelection.providerId && option.model.id === state.modelSelection.modelId,
  )?.model
  const options = buildVariantOptions(model)
  if (options.length <= 1) return { ...state, modelPickerError: "No variants for current model" }
  const current = options.findIndex((option) => option.id === state.modelSelection.variantId)
  const next = options[(current + 1) % options.length]
  if (!next) return { ...state, modelPickerError: "No variants for current model" }
  return {
    ...state,
    modelSelection: {
      ...state.modelSelection,
      variantId: next.id,
      variantName: next.id ? next.label : undefined,
      modelVariantOptions: next.id ? next.runtimeOptions : undefined,
    },
    modelPickerError: undefined,
  }
}

export const clampModelPickerSelectedIndex = (state: TuiState): TuiState => {
  const count =
    state.modelPickerMode === "model"
      ? filterModelOptions(state.modelOptions, state.modelPickerQuery).length
      : state.variantOptions.length
  return { ...state, modelPickerSelectedIndex: clampPickerIndex(state.modelPickerSelectedIndex, count) }
}

export const toggleSessionList = (state: TuiState): TuiState => ({
  ...state,
  showSessionList: !state.showSessionList,
})

export const clearMessages = (state: TuiState): TuiState => ({
  ...state,
  messages: [],
  streamingText: "",
  errors: [],
})

export const closeActivePanel = (state: TuiState): TuiState => ({
  ...state,
  activePanel: "session",
  questionPrompt: undefined,
})

export const appendLocalMessage = (state: TuiState, role: MessageRole, text: string): TuiState => ({
  ...state,
  messages: [...state.messages, { id: crypto.randomUUID(), role, text, status: "completed" }],
})

export function completeTuiRun(
  state: TuiState,
  result: { readonly sessionId: string; readonly status: "completed" | "failed" },
  aborted: boolean,
): TuiState {
  if (aborted) return { ...state, running: false, status: "cancelled" }
  return { ...state, sessionId: result.sessionId, running: false, status: result.status }
}

export function failTuiRun(state: TuiState, error: unknown, aborted: boolean): TuiState {
  if (aborted) return { ...state, running: false, status: "cancelled" }
  return appendError(
    { ...state, running: false, status: "failed" },
    error instanceof Error ? error.message : String(error),
  )
}

export function hydrateTuiState(
  state: TuiState,
  messages: readonly SessionMessage[],
  toolCalls: readonly PersistedToolCall[],
): TuiState {
  return {
    ...state,
    sessionId: messages[0]?.sessionId ?? state.sessionId,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: partsToText(message.parts),
      status: message.status,
    })),
    toolCalls: toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      status: call.status,
      error: call.error?.message,
    })),
  }
}

export function applyTuiEvent(state: TuiState, event: RuntimeEvent): TuiState {
  return projectTuiEvent(state, event)
}

function appendStreamingMessage(state: TuiState): TuiState {
  if (!state.streamingText) return state
  return {
    ...state,
    messages: [
      ...state.messages,
      { id: crypto.randomUUID(), role: "assistant", text: state.streamingText, status: "completed" },
    ],
    streamingText: "",
  }
}

function appendError(state: TuiState, message: string): TuiState {
  return { ...state, errors: [...state.errors, message] }
}

function parseModelSelection(
  value: string,
  fallback: string,
): { readonly providerId: string; readonly modelId: string } {
  const [fallbackProvider = "fake", ...fallbackModelParts] = fallback.split("/")
  const [providerId, ...modelParts] = value.split("/")
  return {
    providerId: providerId || fallbackProvider,
    modelId: modelParts.join("/") || fallbackModelParts.join("/") || "test",
  }
}

function clampPickerIndex(index: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(Math.max(index, 0), count - 1)
}

function upsertToolCall(calls: readonly TuiToolCallView[], next: TuiToolCallView): readonly TuiToolCallView[] {
  const index = calls.findIndex((call) => call.id === next.id)
  if (index === -1) return [...calls, next]
  return calls.map((call, current) => (current === index ? { ...call, ...next } : call))
}

function upsertPlanApproval(
  approvals: readonly TuiPlanApprovalView[],
  next: TuiPlanApprovalView,
): readonly TuiPlanApprovalView[] {
  const index = approvals.findIndex((approval) => approval.memberId === next.memberId)
  if (index === -1) return [...approvals, next]
  return approvals.map((approval, current) => (current === index ? { ...approval, ...next } : approval))
}

function toggleActivePanel(state: TuiState, panel: TuiPanel): TuiState {
  return { ...state, activePanel: state.activePanel === panel ? "session" : panel, sidePanel: true }
}

function upsertTeam(teams: readonly TuiTeamView[], next: TuiTeamView): readonly TuiTeamView[] {
  const existing = teams.find((team) => team.id === next.id)
  const merged = existing
    ? {
        ...existing,
        ...next,
        name: next.name ?? existing.name,
        goal: next.goal ?? existing.goal,
        reportAvailable: existing.reportAvailable || next.reportAvailable,
        members: next.members.length ? next.members : existing.members,
        tasks: next.tasks.length ? next.tasks : existing.tasks,
        mailbox: next.mailbox.length ? next.mailbox : existing.mailbox,
      }
    : next
  if (!existing) return [...teams, merged]
  return teams.map((team) => (team.id === next.id ? merged : team))
}

function ensureTeam(teams: readonly TuiTeamView[], teamId: string): readonly TuiTeamView[] {
  if (teams.some((team) => team.id === teamId)) return teams
  return [...teams, { id: teamId, status: "active", reportAvailable: false, members: [], tasks: [], mailbox: [] }]
}

function upsertTeamMember(
  teams: readonly TuiTeamView[],
  payload: RuntimeEventMap["team.member.updated"],
): readonly TuiTeamView[] {
  return ensureTeam(teams, payload.teamId).map((team) => {
    if (team.id !== payload.teamId) return team
    const next: TuiTeamMemberView = {
      id: payload.memberId,
      name: payload.memberName ?? payload.memberId,
      status: payload.status,
      planStatus: payload.planStatus,
      agentId: payload.agentId,
      lifecycle: payload.lifecycle,
      dependencyIds: payload.dependencyIds ?? [],
      daemonState: payload.daemonState,
      daemonError: payload.daemonError?.message,
    }
    return { ...team, members: upsertById(team.members, next) }
  })
}

function upsertTeamTask(
  teams: readonly TuiTeamView[],
  payload: RuntimeEventMap["team.task.updated"],
): readonly TuiTeamView[] {
  return ensureTeam(teams, payload.teamId).map((team) => {
    if (team.id !== payload.teamId) return team
    return {
      ...team,
      tasks: upsertById(team.tasks, {
        id: payload.taskId,
        status: payload.status,
        description: payload.description ? redactText(payload.description) : undefined,
        assignee: payload.assignee,
        dependencyIds: payload.dependencyIds ?? [],
      }),
    }
  })
}

function upsertTeamMessage(
  teams: readonly TuiTeamView[],
  payload: RuntimeEventMap["team.message.delivered"],
): readonly TuiTeamView[] {
  return ensureTeam(teams, payload.teamId).map((team) => {
    if (team.id !== payload.teamId) return team
    return {
      ...team,
      mailbox: upsertById(team.mailbox, {
        id: payload.messageId,
        recipientId: payload.recipientId,
        sender: payload.sender,
        body: payload.body ? redactText(payload.body) : undefined,
      }),
    }
  })
}

function upsertMcpServer(servers: readonly TuiMcpServerView[], next: TuiMcpServerView): readonly TuiMcpServerView[] {
  return upsertById(servers, next, "serverId")
}

function upsertPermission(
  permissions: readonly TuiPermissionView[],
  next: TuiPermissionView,
): readonly TuiPermissionView[] {
  const existing = permissions.find((permission) => permission.permissionId === next.permissionId)
  const merged = existing ? { ...existing, ...next } : next
  if (!existing) return [...permissions, merged]
  return permissions.map((permission) => (permission.permissionId === next.permissionId ? merged : permission))
}

function upsertAgentTask(tasks: readonly TuiAgentTaskView[], next: TuiAgentTaskView): readonly TuiAgentTaskView[] {
  return upsertById(tasks, next)
}

function upsertById<T>(items: readonly T[], next: T, key?: keyof T): readonly T[] {
  const resolvedKey = key ?? ("id" as keyof T)
  const index = items.findIndex((item) => item[resolvedKey] === next[resolvedKey])
  if (index === -1) return [...items, next]
  return items.map((item, current) => (current === index ? { ...item, ...next } : item))
}

function partsToText(parts: readonly MessagePart[]): string {
  return parts
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return part.text
      if (part.type === "tool-call") return `[tool:${part.toolCall.name} ${part.toolCall.status}]`
      if (part.type === "tool-result") return `[tool-result:${part.result.toolCallId}]`
      if (part.type === "file") return part.text ?? `[file:${part.path}]`
      return `[event:${part.eventId}]`
    })
    .filter(Boolean)
    .join("\n")
}

function toRuntimeStatus(value: string | undefined, fallback: RuntimeStatus): RuntimeStatus {
  const statuses = new Set<RuntimeStatus>([
    "idle",
    "queued",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
  ])
  return statuses.has(value as RuntimeStatus) ? (value as RuntimeStatus) : fallback
}
