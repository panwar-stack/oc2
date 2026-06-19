import type { CommandRegistry, SlashCommand } from "../commands/types"
import type { RuntimeEventBus } from "../events/event-bus"
import type { RuntimeEvent } from "../events/events"
import { redactText } from "../logging/redaction"
import type { SessionRecord } from "../persistence/repositories/sessions"
import type { SessionRunService } from "../session/run"
import type { TuiClient, TuiCommand, TuiCommandResult, TuiSessionSummary, TuiStatusSnapshot } from "./client"
import { createInitialTuiState, hydrateTuiState, type TuiState } from "./state"

export interface LocalTuiClientOptions {
  readonly service: SessionRunService
  readonly events: RuntimeEventBus<TuiState>
  readonly commands: CommandRegistry
  readonly initialState?: TuiState
  readonly roots?: readonly string[]
  readonly model?: string
}

export function createLocalTuiClient(options: LocalTuiClientOptions): TuiClient {
  const initialState = options.initialState ?? createInitialTuiState(true)
  const activeControllers = new Map<string, AbortController>()
  const adapterDiagnostics: string[] = []

  const withController = async <T>(
    sessionId: string | undefined,
    externalSignal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController()
    let registeredSessionId = sessionId
    let unsubscribeCreated: (() => void) | undefined
    if (!sessionId) {
      unsubscribeCreated = options.events.subscribe("session.created", (event) => {
        registeredSessionId = event.payload.sessionId
        activeControllers.set(registeredSessionId, controller)
        unsubscribeCreated?.()
      })
    }
    const abortFromExternal = () => controller.abort(externalSignal?.reason ?? new Error("Cancelled from TUI"))
    if (externalSignal) {
      if (externalSignal.aborted) abortFromExternal()
      else externalSignal.addEventListener("abort", abortFromExternal, { once: true })
    }
    if (sessionId) activeControllers.set(sessionId, controller)
    try {
      return await run(controller.signal)
    } finally {
      unsubscribeCreated?.()
      if (registeredSessionId && activeControllers.get(registeredSessionId) === controller) {
        activeControllers.delete(registeredSessionId)
      }
      externalSignal?.removeEventListener("abort", abortFromExternal)
    }
  }

  return {
    sessions: {
      async list(input = {}) {
        const requestedRoots = new Set(input.roots ?? [])
        return options.service.sessions
          .listSessions()
          .filter((session) => {
            if (requestedRoots.size === 0) return true
            const sessionRoots = new Set(session.workspaceRoots.map((root) => root.path))
            return [...requestedRoots].every((root) => sessionRoots.has(root))
          })
          .map(toSessionSummary)
      },

      async hydrate(sessionId) {
        try {
          const session = options.service.sessions.resumeSession(sessionId)
          if (!session) throw new Error(`Session not found: ${sessionId}`)
          const messages = options.service.sessions.messages.listBySession(sessionId)
          const tools = options.service.sessions.toolCalls.listBySession(sessionId)
          let state = hydrateTuiState({ ...initialState, sessionId }, messages, tools)
          state = {
            ...state,
            modelSelection: {
              ...state.modelSelection,
              providerId: session.providerId,
              modelId: session.modelId,
              variantId: typeof session.metadata.modelVariant === "string" ? session.metadata.modelVariant : undefined,
            },
          }
          return { session: toSessionSummary(session), state }
        } catch (error) {
          const message = `Failed to hydrate session ${sessionId}: ${redactText(error instanceof Error ? error.message : String(error))}`
          adapterDiagnostics.push(message)
          return {
            session: { id: "", roots: options.roots ?? [] },
            state: {
              ...initialState,
              sessionId: undefined,
              diagnostics: [...initialState.diagnostics, { message }],
            },
          }
        }
      },

      async prompt(input) {
        return await withController(input.sessionId, input.signal, async (signal) => {
          const result = await options.service.run({
            prompt: input.prompt,
            sessionId: input.sessionId,
            model: input.model,
            modelVariant: input.modelVariant,
            modelVariantOptions: input.modelVariantOptions,
            roots: input.roots,
            signal,
          })
          return { sessionId: result.sessionId }
        })
      },

      async abort(sessionId) {
        activeControllers.get(sessionId)?.abort(new Error("Cancelled from TUI"))
      },
    },

    commands: {
      async list() {
        return options.commands.list().map(toTuiCommand)
      },

      async execute(input): Promise<TuiCommandResult> {
        const command = options.commands.get(input.name)
        if (!command || command.source === "tui" || !command.template) {
          return { ok: false, message: `Slash command not found: ${input.name}` }
        }
        return await withController(input.sessionId, input.signal, async (signal) => {
          const result = await options.service.command({
            name: input.name,
            arguments: input.args.join(" "),
            sessionId: input.sessionId,
            model: input.model,
            modelVariant: input.modelVariant,
            modelVariantOptions: input.modelVariantOptions,
            roots: input.roots,
            signal,
          })
          return {
            ok: result.status !== "failed",
            sessionId: result.sessionId,
            message: result.errors?.[0]?.message,
          }
        })
      },
    },

    status: {
      async snapshot(): Promise<TuiStatusSnapshot> {
        const state = options.events.getState()
        const selection = state.modelSelection
        const model =
          selection.providerId && selection.modelId ? `${selection.providerId}/${selection.modelId}` : options.model
        return {
          model,
          roots: options.roots ?? [],
          diagnostics: [...adapterDiagnostics, ...state.diagnostics.map((diagnostic) => diagnostic.message)],
        }
      },
    },

    models: {
      async list() {
        const result = await options.service.listModelOptions()
        return { options: result.options, providerCount: result.providerCount, errors: result.errors }
      },
    },

    events: {
      subscribe(listener: (event: RuntimeEvent) => void) {
        return options.events.all(listener)
      },
    },
  }
}

function toSessionSummary(session: SessionRecord): TuiSessionSummary {
  return {
    id: session.id,
    title: session.title ?? undefined,
    roots: session.workspaceRoots.map((root) => root.path),
    updatedAt: session.updatedAt,
  }
}

function toTuiCommand(command: SlashCommand): TuiCommand {
  return {
    id: command.name,
    title: command.name,
    category: command.source === "tui" ? "app" : "session",
    description: command.description,
    slashName: command.name,
    slashAliases: command.aliases,
    source: command.source,
    enabled: true,
  }
}
