import type { RuntimeEvent } from "../events/events"
import type { ShallowJsonObject } from "../model/provider"
import type { TuiState } from "./state"

export interface TuiClient {
  readonly sessions: {
    list(input?: { readonly roots?: readonly string[] }): Promise<readonly TuiSessionSummary[]>
    hydrate(sessionId: string): Promise<TuiHydratedSession>
    prompt(input: {
      readonly sessionId?: string
      readonly prompt: string
      readonly model?: string
      readonly modelVariant?: string
      readonly modelVariantOptions?: ShallowJsonObject
      readonly roots: readonly string[]
      readonly signal?: AbortSignal
    }): Promise<{ readonly sessionId: string }>
    abort(sessionId: string): Promise<void>
  }
  readonly commands: {
    list(): Promise<readonly TuiCommand[]>
    execute(input: {
      readonly sessionId?: string
      readonly name: string
      readonly args: readonly string[]
      readonly raw: string
      readonly model?: string
      readonly modelVariant?: string
      readonly modelVariantOptions?: ShallowJsonObject
      readonly roots: readonly string[]
      readonly signal?: AbortSignal
    }): Promise<TuiCommandResult>
  }
  readonly status: {
    snapshot(): Promise<TuiStatusSnapshot>
  }
  readonly events: {
    subscribe(listener: (event: RuntimeEvent) => void): () => void
  }
}

export interface TuiSessionSummary {
  readonly id: string
  readonly title?: string
  readonly roots: readonly string[]
  readonly updatedAt?: string
}

export interface TuiHydratedSession {
  readonly session: TuiSessionSummary
  readonly state: TuiState
}

export interface TuiCommandResult {
  readonly ok: boolean
  readonly message?: string
  readonly sessionId?: string
}

export interface TuiStatusSnapshot {
  readonly model?: string
  readonly roots: readonly string[]
  readonly diagnostics: readonly string[]
}

export interface TuiCommand {
  readonly id: string
  readonly title: string
  readonly category: "session" | "app" | "model" | "agent" | "theme" | "status" | "debug"
  readonly description?: string
  readonly keybindings?: readonly string[]
  readonly slashName?: string
  readonly slashAliases?: readonly string[]
  readonly enabled: boolean
}
