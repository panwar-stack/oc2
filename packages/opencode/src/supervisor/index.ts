import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { Supervisor } from "@/supervisor/supervisor"
import { Context, Effect, Layer, Scope } from "effect"
import * as Stream from "effect/Stream"
import path from "node:path"

const MAX_FILES = 25
const MAX_COMMANDS = 20
const MAX_VALIDATIONS = 10

type Command = Supervisor.State["commandsRun"][number]
type Derived = {
  filesTouched: string[]
  commandsRun: Command[]
  validationsRun: string[]
  status: Supervisor.State["status"]
  statusUpdated?: boolean
  summary?: string
  updatedAt: number
}
type State = {
  derived: Map<SessionID, Derived>
  roots: string[]
}

type EventPayload = {
  type: string
  properties: unknown
}
type NormalizedEvent =
  | { type: "refresh"; sessionID: SessionID }
  | { type: "derived"; sessionID: SessionID; derived: Derived }
  | { type: "part"; sessionID: SessionID; part: MessageV2.Part }

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Supervisor.State>
  readonly updateSettings: (input: {
    sessionID: SessionID
    patch: Supervisor.SettingsPatch
  }) => Effect.Effect<Supervisor.State>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Supervisor") {}

export const layer: Layer.Layer<
  Service,
  never,
  Bus.Service | Config.Service | Session.Service | SessionSummary.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const session = yield* Session.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const state = yield* InstanceState.make<State>(
      Effect.fn("SupervisorState.state")((ctx) =>
        Effect.succeed({ derived: new Map(), roots: [ctx.directory, ctx.worktree].filter((root) => root !== "/") }),
      ),
    )

    const get = Effect.fn("SupervisorState.get")(function* (sessionID: SessionID) {
      return yield* rebuild(sessionID, { publish: false })
    })

    const updateSettings = Effect.fn("SupervisorState.updateSettings")(function* (input: {
      sessionID: SessionID
      patch: Supervisor.SettingsPatch
    }) {
      const info = yield* session.get(input.sessionID).pipe(Effect.orDie)
      const settings = Supervisor.applySettingsPatch({
        current: info.supervisor,
        patch: input.patch,
        updatedAt: Date.now(),
      })
      yield* session.setSupervisorSettings({ sessionID: input.sessionID, supervisor: settings })
      const next = yield* rebuild(input.sessionID, { publish: false })
      yield* bus.publish(Supervisor.Event.SettingsUpdated, { sessionID: input.sessionID, settings, state: next })
      return next
    })

    const init = Effect.fn("SupervisorState.init")(function* () {
      const stream = yield* Scope.provide(scope)(bus.subscribeAll())
      yield* stream.pipe(Stream.runForEach(handleEvent), Effect.forkIn(scope))
    })

    function rebuild(sessionID: SessionID, options: { publish: boolean }) {
      return Effect.gen(function* () {
        const info = yield* session.get(sessionID).pipe(Effect.orDie)
        const base = Supervisor.state({ sessionID, config: yield* config.get(), session: info.supervisor })
        const data = yield* InstanceState.get(state)

        if (base.mode === "off") {
          data.derived.delete(sessionID)
          return base
        }

        const fromSnapshots = yield* deriveFromSnapshots(info, base.config.effective, data.roots).pipe(
          Effect.orElseSucceed((): Derived => emptyDerived()),
        )
        const current = data.derived.get(sessionID)
        const derived = mergeDerived(fromSnapshots, current)
        data.derived.set(sessionID, derived)
        const next = overlay(base, derived)
        if (options.publish) yield* bus.publish(Supervisor.Event.StateUpdated, { sessionID, state: next })
        return next
      })
    }

    function handleEvent(event: EventPayload) {
      return Effect.gen(function* () {
        const normalized = normalizeEvent(event)
        if (!normalized) return
        const base = Supervisor.state({
          sessionID: normalized.sessionID,
          config: yield* config.get(),
          session: (yield* session.get(normalized.sessionID).pipe(Effect.orDie)).supervisor,
        })
        const data = yield* InstanceState.get(state)
        if (base.mode === "off") {
          data.derived.delete(normalized.sessionID)
          return
        }
        if (normalized.type === "refresh") {
          yield* rebuild(normalized.sessionID, { publish: true })
          return
        }
        const eventDerived =
          normalized.type === "part"
            ? deriveFromPart(normalized.part, base.config.effective, data.roots, Date.now())
            : normalized.derived
        const derived = mergeDerived(data.derived.get(normalized.sessionID) ?? emptyDerived(), eventDerived)
        data.derived.set(normalized.sessionID, derived)
        yield* bus.publish(Supervisor.Event.StateUpdated, {
          sessionID: normalized.sessionID,
          state: overlay(base, derived),
        })
      }).pipe(Effect.catch(() => Effect.void))
    }

    function deriveFromSnapshots(info: Session.Info, effective: Supervisor.EffectiveConfig, roots: string[]) {
      return Effect.gen(function* () {
        const messages = yield* session.messages({ sessionID: info.id })
        const diffs = yield* summary
          .diff({ sessionID: info.id })
          .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
        const derived = messages.reduce<Derived>(
          (result, item) =>
            item.parts.reduce<Derived>(
              (next, part) => mergeDerived(next, deriveFromPart(part, effective, roots, Date.now())),
              result,
            ),
          mergeDerived(emptyDerived(), {
            ...emptyDerived(),
            filesTouched: boundedUnique(diffs.flatMap((diff) => (diff.file ? [diff.file] : [])), MAX_FILES),
          }),
        )
        return { ...derived, summary: activitySummary(derived) }
      })
    }

    return Service.of({ init, get, updateSettings })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionSummary.defaultLayer),
  ),
)

function emptyDerived(): Derived {
  return {
    filesTouched: [],
    commandsRun: [],
    validationsRun: [],
    status: "on_track",
    updatedAt: Date.now(),
  }
}

function overlay(base: Supervisor.State, derived: Derived): Supervisor.State {
  return {
    ...base,
    status: derived.status,
    summary: derived.summary,
    filesTouched: derived.filesTouched,
    commandsRun: derived.commandsRun,
    validationsRun: derived.validationsRun,
    risks: [],
    updatedAt: derived.updatedAt,
  }
}

function deriveFromPart(
  part: MessageV2.Part,
  config: Supervisor.EffectiveConfig,
  roots: string[],
  updatedAt: number,
): Derived {
  if (part.type === "patch") return { ...emptyDerived(), filesTouched: part.files, summary: "Session with edits", updatedAt }
  if (part.type !== "tool") return { ...emptyDerived(), updatedAt }
  const command = shellCommand(part, roots)
  if (!command) return { ...emptyDerived(), updatedAt }
  const validation = config.validation_command_patterns.some((pattern) => command.startsWith(collapseCommand(pattern)))
  const exitCode = toolExitCode(part)
  return {
    ...emptyDerived(),
    commandsRun: [{ command, exitCode, validation, repeatedFailureCount: 0 }],
    validationsRun: validation && exitCode === 0 ? [command] : [],
    summary: validation ? "Session with validation" : "Session with commands",
    updatedAt,
  }
}

function mergeDerived(first: Derived, second?: Derived): Derived {
  if (!second) return boundDerived(first)
  return boundDerived({
    filesTouched: boundedUnique([...second.filesTouched, ...first.filesTouched], MAX_FILES),
    commandsRun: boundedCommands([...second.commandsRun, ...first.commandsRun]),
    validationsRun: boundedUnique([...second.validationsRun, ...first.validationsRun], MAX_VALIDATIONS),
    status: second.statusUpdated ? second.status : second.status === "on_track" ? first.status : second.status,
    statusUpdated: first.statusUpdated || second.statusUpdated,
    summary: first.summary ?? second.summary,
    updatedAt: Math.max(first.updatedAt, second.updatedAt),
  })
}

function boundDerived(derived: Derived): Derived {
  return {
    ...derived,
    filesTouched: boundedUnique(derived.filesTouched, MAX_FILES),
    commandsRun: boundedCommands(derived.commandsRun),
    validationsRun: boundedUnique(derived.validationsRun, MAX_VALIDATIONS),
  }
}

function boundedUnique(values: string[], max: number) {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0))).slice(0, max)
}

function boundedCommands(commands: Command[]) {
  return boundedUnique(
    commands.map((item) => item.command),
    MAX_COMMANDS,
  ).flatMap((command) => commands.find((item) => item.command === command) ?? [])
}

function collapseCommand(command: string) {
  return command.trim().replace(/\s+/g, " ")
}

function normalizeCommand(command: string, roots: string[]) {
  const normalized = collapseCommand(command)
  const match = normalized.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|([^\s&;|]+))\s*&&\s*(.+)$/)
  if (!match) return normalized
  const cdPath = match[1] ?? match[2] ?? match[3]
  const rest = match[4]
  if (!cdPath || !rest) return normalized
  const target = path.resolve(roots[0] ?? process.cwd(), cdPath)
  if (!roots.some((root) => isInside(root, target))) return normalized
  return collapseCommand(rest)
}

function isInside(root: string, target: string) {
  const relative = path.relative(path.resolve(root), target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function shellCommand(part: MessageV2.ToolPart, roots: string[]) {
  if (part.tool !== "bash" && part.tool !== "shell" && !part.tool.includes("shell")) return
  const command = part.state.input.command
  if (typeof command !== "string") return
  const normalized = normalizeCommand(command, roots)
  return normalized.length > 0 ? normalized : undefined
}

function toolExitCode(part: MessageV2.ToolPart) {
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  const values = [metadata?.exit, metadata?.exitCode, part.metadata?.exit, part.metadata?.exitCode]
  return values.find((value): value is number => typeof value === "number" && Number.isFinite(value))
}

function activitySummary(derived: Derived) {
  if (derived.validationsRun.length > 0) return "Session with validation"
  if (derived.filesTouched.length > 0) return "Session with edits"
  if (derived.commandsRun.length > 0) return "Session with commands"
  return "Coding session"
}

function normalizeEvent(event: EventPayload): NormalizedEvent | undefined {
  if (!isRecord(event.properties)) return
  const sessionID = sessionIDFromProperties(event.properties)
  if (!sessionID) return
  switch (event.type) {
    case "session.updated":
    case "message.updated":
    case "message.part.removed":
      return { type: "refresh" as const, sessionID }
    case "permission.asked":
    case "permission.replied":
      return { type: "derived" as const, sessionID, derived: { ...emptyDerived(), updatedAt: Date.now() } }
  }
  if (event.type === "session.diff") {
    const diff = Array.isArray(event.properties.diff) ? event.properties.diff : []
    return {
      type: "derived" as const,
      sessionID,
      derived: {
        ...emptyDerived(),
        filesTouched: diff.flatMap((item) => (isRecord(item) && typeof item.file === "string" ? [item.file] : [])),
      },
    }
  }
  if (event.type === "session.error") {
    return {
      type: "derived" as const,
      sessionID,
      derived: { ...emptyDerived(), status: "blocked", statusUpdated: true, updatedAt: Date.now() },
    }
  }
  if (event.type === "session.idle") {
    return {
      type: "derived" as const,
      sessionID,
      derived: { ...emptyDerived(), status: "on_track", statusUpdated: true, updatedAt: Date.now() },
    }
  }
  if (event.type === "session.status") {
    return {
      type: "derived" as const,
      sessionID,
      derived: {
        ...emptyDerived(),
        status: statusFromProperties(event.properties),
        statusUpdated: true,
        updatedAt: Date.now(),
      },
    }
  }
  if (event.type === "message.part.updated" && isRecord(event.properties.part)) {
    return {
      type: "part" as const,
      sessionID,
      part: event.properties.part as MessageV2.Part,
    }
  }
}

function sessionIDFromProperties(properties: Record<string, unknown>) {
  if (typeof properties.sessionID === "string") return SessionID.make(properties.sessionID)
  if (isRecord(properties.request) && typeof properties.request.sessionID === "string") {
    return SessionID.make(properties.request.sessionID)
  }
}

function statusFromProperties(properties: Record<string, unknown>): Supervisor.State["status"] {
  if (!isRecord(properties.status)) return "on_track"
  if (properties.status.type === "busy" || properties.status.type === "retry" || properties.status.type === "active") {
    return "uncertain"
  }
  return "on_track"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export * as SupervisorState from "."
