import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { Supervisor } from "@/supervisor/supervisor"
import { generateObject, type ModelMessage } from "ai"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import path from "node:path"

const MAX_FILES = 25
const MAX_COMMANDS = 20
const MAX_VALIDATIONS = 10
const MAX_RECENT_EVENTS = 40
const MODEL_ONLY_TRIGGERS = [
  "wrong_localization",
  "evidence_mismatch",
  "validation_mismatch",
  "premature_success",
  "less_optimal_action",
  "trajectory_drift",
]
const ALL_TRIGGERS: Supervisor.RecommendationInput["allowedTriggers"] = [
  "missing_reproduction",
  "repeated_command_failure",
  "missing_validation",
  "scope_expansion",
  "risky_edit",
  "wrong_localization",
  "evidence_mismatch",
  "validation_mismatch",
  "premature_success",
  "less_optimal_action",
  "trajectory_drift",
]

type Command = Supervisor.State["commandsRun"][number]
type RecentEvent = Supervisor.RecommendationInput["recentEvents"][number]
type Derived = {
  filesTouched: string[]
  commandsRun: Command[]
  validationsRun: string[]
  recentEvents: RecentEvent[]
  bugLikePrompt?: boolean
  userFailureEvidence?: boolean
  status: Supervisor.State["status"]
  statusUpdated?: boolean
  summary?: string
  updatedAt: number
}
type State = {
  derived: Map<SessionID, Derived>
  recommendations: Map<SessionID, Supervisor.Recommendation[]>
  lastReviewAt: Map<SessionID, number>
  configKeys: Map<SessionID, string>
  configGenerations: Map<SessionID, number>
  roots: string[]
}

type EventPayload = {
  type: string
  properties: unknown
}
type NormalizedEvent =
  | { type: "refresh"; sessionID: SessionID; boundary?: ReviewBoundary }
  | { type: "derived"; sessionID: SessionID; derived: Derived; boundary?: ReviewBoundary }
  | { type: "part"; sessionID: SessionID; part: MessageV2.Part; boundary?: ReviewBoundary }
type ReviewBoundary = "event" | "step" | "idle"

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Supervisor.State>
  readonly getReport: (sessionID: SessionID) => Effect.Effect<Supervisor.Report>
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
        Effect.succeed({
          derived: new Map(),
          recommendations: new Map(),
          lastReviewAt: new Map(),
          configKeys: new Map(),
          configGenerations: new Map(),
          roots: [ctx.directory, ctx.worktree].filter((root) => root !== "/"),
        }),
      ),
    )

    const get = Effect.fn("SupervisorState.get")(function* (sessionID: SessionID) {
      return yield* rebuild(sessionID, { publish: false })
    })

    const getReport = Effect.fn("SupervisorState.getReport")(function* (sessionID: SessionID) {
      const next = yield* rebuild(sessionID, { publish: false, report: true })
      const data = yield* InstanceState.get(state)
      const report = buildReport(next, data.recommendations.get(sessionID) ?? [])
      yield* bus.publish(Supervisor.Event.ReportCompleted, { sessionID, report })
      return report
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

    function rebuild(sessionID: SessionID, options: { publish: boolean; report?: boolean }) {
      return Effect.gen(function* () {
        const info = yield* session.get(sessionID).pipe(Effect.orDie)
        const base = Supervisor.state({ sessionID, config: yield* config.get(), session: info.supervisor })
        const data = yield* InstanceState.get(state)
        observeConfig(data, sessionID, base.config.effective)

        if (base.mode === "off") {
          data.derived.delete(sessionID)
          data.recommendations.delete(sessionID)
          data.lastReviewAt.delete(sessionID)
          return base
        }

        const fromSnapshots = yield* deriveFromSnapshots(info, base.config.effective, data.roots).pipe(
          Effect.orElseSucceed((): Derived => emptyDerived()),
        )
        const current = data.derived.get(sessionID)
        const derived = mergeDerived(fromSnapshots, current)
        data.derived.set(sessionID, derived)
        const next = overlay(base, derived, latestRecommendation(data, sessionID), { report: options.report })
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
        observeConfig(data, normalized.sessionID, base.config.effective)
        if (base.mode === "off") {
          data.derived.delete(normalized.sessionID)
          data.recommendations.delete(normalized.sessionID)
          data.lastReviewAt.delete(normalized.sessionID)
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
        const next = overlay(base, derived, latestRecommendation(data, normalized.sessionID))
        yield* bus.publish(Supervisor.Event.StateUpdated, {
          sessionID: normalized.sessionID,
          state: next,
        })
        if (normalized.boundary && shouldReview(base.config.effective.review_cadence, normalized.boundary)) {
          yield* maybeReview(normalized.sessionID, base, derived).pipe(Effect.forkIn(scope, { startImmediately: true }))
        }
      }).pipe(Effect.catch(() => Effect.void))
    }

    function maybeReview(sessionID: SessionID, base: Supervisor.State, derived: Derived) {
      return Effect.gen(function* () {
        if (base.mode !== "advise") return
        const data = yield* InstanceState.get(state)
        const current = overlay(base, derived, latestRecommendation(data, sessionID))
        if ((data.recommendations.get(sessionID)?.length ?? 0) >= base.config.effective.max_recommendations_per_session) return
        if (Date.now() - (data.lastReviewAt.get(sessionID) ?? 0) < base.config.effective.min_review_interval_ms) return
        data.lastReviewAt.set(sessionID, Date.now())
        const configGeneration = observeConfig(data, sessionID, base.config.effective)

        const recommendation = yield* createRecommendation({ state: current }).pipe(
          Effect.timeoutOrElse({
            duration: `${base.config.effective.recommendation_timeout_ms} millis`,
            orElse: () => Effect.succeed(undefined),
          }),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (!recommendation) return

        const latestInfo = yield* session.get(sessionID).pipe(Effect.orDie)
        const latestBase = Supervisor.state({ sessionID, config: yield* config.get(), session: latestInfo.supervisor })
        if (latestBase.mode !== "advise") return
        if (observeConfig(data, sessionID, latestBase.config.effective) !== configGeneration) return
        if ((data.recommendations.get(sessionID)?.length ?? 0) >= latestBase.config.effective.max_recommendations_per_session) return

        data.recommendations.set(sessionID, [...(data.recommendations.get(sessionID) ?? []), recommendation])
        const next = overlay(latestBase, derived, recommendation)
        yield* bus.publish(Supervisor.Event.RecommendationCreated, { sessionID, recommendation, state: next })
        yield* bus.publish(Supervisor.Event.StateUpdated, { sessionID, state: next })
      })
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

    return Service.of({ init, get, getReport, updateSettings })
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
    recentEvents: [],
    status: "on_track",
    updatedAt: Date.now(),
  }
}

function overlay(
  base: Supervisor.State,
  derived: Derived,
  recommendation?: Supervisor.Recommendation,
  options?: { report?: boolean },
): Supervisor.State {
  const risks = deriveRisks(base.config.effective, derived, options)
  return {
    ...base,
    status: statusWithRisks(derived.status, risks),
    summary: derived.summary,
    filesTouched: derived.filesTouched,
    commandsRun: derived.commandsRun,
    validationsRun: derived.validationsRun,
    risks,
    recommendation,
    updatedAt: derived.updatedAt,
  }
}

function deriveFromPart(
  part: MessageV2.Part,
  config: Supervisor.EffectiveConfig,
  roots: string[],
  updatedAt: number,
): Derived {
  if (part.type === "patch") {
    return {
      ...emptyDerived(),
      filesTouched: part.files,
      recentEvents: part.files.map((file) => ({ type: "patch", target: file, outcome: "unknown" as const })),
      summary: "Session with edits",
      updatedAt,
    }
  }
  if (part.type === "text") {
    return {
      ...emptyDerived(),
      bugLikePrompt: bugLikeText(part.text),
      userFailureEvidence: failureEvidenceText(part.text),
      recentEvents: failureEvidenceText(part.text) ? [{ type: "user_evidence", outcome: "failure" as const }] : [],
      updatedAt,
    }
  }
  if (part.type !== "tool") return { ...emptyDerived(), updatedAt }
  const command = shellCommand(part, roots)
  if (!command) return { ...emptyDerived(), updatedAt }
  const validation = config.validation_command_patterns.some((pattern) => command.startsWith(collapseCommand(pattern)))
  const exitCode = toolExitCode(part)
  return {
    ...emptyDerived(),
    commandsRun: [{ command, exitCode, validation, repeatedFailureCount: exitCode !== undefined && exitCode !== 0 ? 1 : 0 }],
    validationsRun: validation && exitCode === 0 ? [command] : [],
    recentEvents: [
      {
        type: validation ? "validation" : "command",
        target: command,
        outcome: exitCode === undefined ? "unknown" : exitCode === 0 ? "success" : "failure",
      },
    ],
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
    recentEvents: [...second.recentEvents, ...first.recentEvents].slice(0, MAX_RECENT_EVENTS),
    bugLikePrompt: first.bugLikePrompt || second.bugLikePrompt,
    userFailureEvidence: first.userFailureEvidence || second.userFailureEvidence,
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
    recentEvents: derived.recentEvents.slice(0, MAX_RECENT_EVENTS),
  }
}

function boundedUnique(values: string[], max: number) {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0))).slice(0, max)
}

function boundedCommands(commands: Command[]) {
  return boundedUnique(
    commands.map((item) => item.command),
    MAX_COMMANDS,
  ).flatMap((command) => {
    const items = commands.filter((item) => item.command === command)
    const latest = items[0]
    if (!latest) return []
    return [
      {
        ...latest,
        repeatedFailureCount: items.reduce(
          (total, item) => total + (item.repeatedFailureCount || (item.exitCode !== undefined && item.exitCode !== 0 ? 1 : 0)),
          0,
        ),
      },
    ]
  })
}

function collapseCommand(command: string) {
  return command.trim().replace(/\s+(?=(?:[^'"]|'[^']*'|"[^"]*")*$)/g, " ")
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

function bugLikeText(text: string) {
  return /\b(bug|broken|crash|error|exception|fail(?:ed|ing)?|regression|repro|stack trace|traceback)\b/i.test(text)
}

function failureEvidenceText(text: string) {
  return /\b(expected|actual|error:|exception|traceback|stack trace|failed|failing)\b/i.test(text)
}

export function buildRecommendationInput(
  state: Supervisor.State,
  options?: { recentEvents?: RecentEvent[]; reviewReason?: Supervisor.RecommendationInput["reviewReason"] },
): Supervisor.RecommendationInput {
  const model = state.config.effective.recommendation_model
    ? Provider.parseModel(state.config.effective.recommendation_model)
    : undefined
  return {
    sessionID: state.sessionID,
    status: state.status,
    summary: state.summary,
    supervisorModel: model,
    allowedTriggers: [...ALL_TRIGGERS],
    triggeredRisks: state.risks,
    filesTouched: state.filesTouched.slice(0, MAX_FILES),
    commandsRun: state.commandsRun.slice(0, MAX_COMMANDS),
    validationsRun: state.validationsRun.slice(0, MAX_VALIDATIONS),
    risks: state.risks,
    recentEvents: options?.recentEvents?.slice(0, MAX_RECENT_EVENTS) ?? [],
    reviewReason: options?.reviewReason ?? (state.risks.length > 0 ? "deterministic_trigger" : "cadence"),
    maxRecommendationChars: state.config.effective.max_recommendation_chars,
  }
}

export function validateRecommendationOutput(input: {
  state: Supervisor.State
  output: unknown
  model?: { providerID: string; modelID: string }
}): Supervisor.Recommendation | undefined {
  const decoded = Schema.decodeUnknownOption(Supervisor.RecommendationOutput)(input.output)
  if (Option.isNone(decoded)) return
  const output = decoded.value
  if (!output.recommend) return
  if (output.message.length > input.state.config.effective.max_recommendation_chars) return
  if (outOfScopeMessage(output.message)) return
  if (output.evidence.length === 0) return
  if (!output.evidence.every((evidence) => observedEvidence(input.state).includes(evidence))) return
  if (!input.state.risks.some((risk) => risk.trigger === output.trigger)) {
    if (!MODEL_ONLY_TRIGGERS.includes(output.trigger)) return
    if (output.evidence.length < 2) return
  }
  return {
    source: "model",
    action: output.action,
    trigger: output.trigger,
    message: output.message,
    evidence: [...output.evidence],
    model: input.model,
  }
}

export function buildReport(state: Supervisor.State, recommendations: Supervisor.Recommendation[]): Supervisor.Report {
  return {
    sessionID: state.sessionID,
    status: state.status,
    summary: state.summary,
    filesTouched: state.filesTouched,
    commandsRun: state.commandsRun,
    validationsRun: state.validationsRun,
    risks: state.risks,
    recommendations,
    evidence: boundedUnique(
      [
        ...state.risks.flatMap((risk) => risk.evidence),
        ...state.filesTouched.map((file) => `file:${file}`),
        ...state.commandsRun.map((command) => `command:${command.command}`),
        ...state.validationsRun.map((command) => `validation:${command}`),
        ...recommendations.flatMap((recommendation) => recommendation.evidence),
      ],
      50,
    ),
    generatedAt: Date.now(),
  }
}

function createRecommendation(input: { state: Supervisor.State }) {
  return Effect.gen(function* () {
    const modelID = input.state.config.effective.recommendation_model
    if (!modelID) return
    const providerOption = yield* Effect.serviceOption(Provider.Service)
    if (Option.isNone(providerOption)) return
    const provider = providerOption.value
    const parsed = Provider.parseModel(modelID)
    const model = yield* provider.getModel(parsed.providerID, parsed.modelID).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!model) return
    const language = yield* provider.getLanguage(model).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (!language) return
    const recommendationInput = buildRecommendationInput(input.state)
    const messages: ModelMessage[] = [
      {
        role: "system",
        content:
          "You are an opencode supervisor. Return one concise JSON recommendation using only the provided evidence. Do not request blocking, rollback, permission denial, specialist routing, or transcript insertion.",
      },
      {
        role: "user",
        content: JSON.stringify(recommendationInput),
      },
    ]
    const output = yield* Effect.promise(() =>
      generateObject({
        model: language,
        messages,
        temperature: 0,
        schema: Object.assign(
          Schema.toStandardSchemaV1(Supervisor.RecommendationOutput),
          Schema.toStandardJSONSchemaV1(Supervisor.RecommendationOutput),
        ),
      }).then((result) => result.object),
    )
    return validateRecommendationOutput({
      state: input.state,
      output,
      model: { providerID: parsed.providerID, modelID: parsed.modelID },
    })
  })
}

function deriveRisks(config: Supervisor.EffectiveConfig, derived: Derived, options?: { report?: boolean }): Supervisor.Risk[] {
  return [
    missingReproductionRisk(derived),
    ...repeatedCommandFailureRisks(config, derived),
    missingValidationRisk(derived, options),
    scopeExpansionRisk(config, derived),
    riskyEditRisk(config, derived),
  ].filter((risk): risk is Supervisor.Risk => Boolean(risk))
}

function missingReproductionRisk(derived: Derived): Supervisor.Risk | undefined {
  if (derived.filesTouched.length === 0) return
  if (!derived.bugLikePrompt) return
  if (derived.userFailureEvidence) return
  if (derived.recentEvents.some((event) => event.outcome === "failure")) return
  return {
    trigger: "missing_reproduction",
    severity: "warning",
    evidence: derived.filesTouched.slice(0, 3).map((file) => `file:${file}`),
    message: "Edits were observed without a reproduction command.",
  }
}

function repeatedCommandFailureRisks(config: Supervisor.EffectiveConfig, derived: Derived): Supervisor.Risk[] {
  const recent = eventsSinceLatestPatch(derived)
  return boundedUnique(
    recent.flatMap((event) => (event.target && event.outcome === "failure" ? [event.target] : [])),
    MAX_COMMANDS,
  ).flatMap((command) => {
    const count = recent.filter((event) => event.target === command && event.outcome === "failure").length
    if (count < config.max_repeated_command_failures) return []
    return [
      {
        trigger: "repeated_command_failure" as const,
        severity: "high" as const,
        evidence: [`command:${command}`],
        message: `Command failed ${count} times: ${command}`,
      },
    ]
  })
}

function missingValidationRisk(derived: Derived, options?: { report?: boolean }): Supervisor.Risk | undefined {
  if (derived.filesTouched.length === 0) return
  if (!options?.report && !idleAfterEdit(derived)) return
  if (hasSuccessfulValidationAfterLatestPatch(derived)) return
  return {
    trigger: "missing_validation",
    severity: "warning",
    evidence: derived.filesTouched.slice(0, 3).map((file) => `file:${file}`),
    message: "Edits were observed without a successful validation command.",
  }
}

function scopeExpansionRisk(config: Supervisor.EffectiveConfig, derived: Derived): Supervisor.Risk | undefined {
  if (derived.filesTouched.length <= config.broad_diff_file_limit) return
  return {
    trigger: "scope_expansion",
    severity: "warning",
    evidence: derived.filesTouched.slice(0, config.broad_diff_file_limit + 1).map((file) => `file:${file}`),
    message: `Touched ${derived.filesTouched.length} files, above the configured broad-diff limit.`,
  }
}

function riskyEditRisk(config: Supervisor.EffectiveConfig, derived: Derived): Supervisor.Risk | undefined {
  const files = unvalidatedSensitiveFiles(config, derived)
  if (files.length === 0) return
  return {
    trigger: "risky_edit",
    severity: "high",
    evidence: files.slice(0, 5).map((file) => `file:${file}`),
    message: "Sensitive-path edits were observed.",
  }
}

function statusWithRisks(status: Supervisor.State["status"], risks: Supervisor.Risk[]): Supervisor.State["status"] {
  if (status === "blocked") return status
  if (risks.some((risk) => risk.severity === "high")) return "high_risk"
  if (risks.length > 0) return "drifting"
  return status
}

function latestRecommendation(state: State, sessionID: SessionID) {
  return state.recommendations.get(sessionID)?.at(-1)
}

function observeConfig(state: State, sessionID: SessionID, config: Supervisor.EffectiveConfig) {
  const key = JSON.stringify(config)
  if (state.configKeys.get(sessionID) === key) return state.configGenerations.get(sessionID) ?? 0
  const generation = (state.configGenerations.get(sessionID) ?? 0) + 1
  state.configKeys.set(sessionID, key)
  state.configGenerations.set(sessionID, generation)
  return generation
}

function eventsSinceLatestPatch(derived: Derived) {
  const patchIndex = derived.recentEvents.findIndex((event) => event.type === "patch")
  return patchIndex === -1 ? derived.recentEvents : derived.recentEvents.slice(0, patchIndex)
}

function idleAfterEdit(derived: Derived) {
  return derived.recentEvents[0]?.type === "idle" && derived.recentEvents.some((event) => event.type === "patch")
}

function hasSuccessfulValidationAfterLatestPatch(derived: Derived) {
  return eventsSinceLatestPatch(derived).some((event) => event.type === "validation" && event.outcome === "success")
}

function unvalidatedSensitiveFiles(config: Supervisor.EffectiveConfig, derived: Derived) {
  return boundedUnique(
    derived.recentEvents.flatMap((event, index) => {
      if (event.type !== "patch" || !event.target) return []
      if (!config.sensitive_path_globs.some((glob) => matchesGlob(event.target ?? "", glob))) return []
      if (derived.recentEvents.slice(0, index).some((item) => item.type === "validation" && item.outcome === "success")) return []
      return [event.target]
    }),
    5,
  )
}

function outOfScopeMessage(message: string) {
  return /\b(block|deny|rollback|roll back|revert everything|fork|pause|permission denial|broad refactor|specialist|route to|policy)\b/i.test(
    message,
  )
}

function shouldReview(cadence: Supervisor.ReviewCadence, boundary: ReviewBoundary) {
  if (cadence === "event") return true
  if (cadence === "step") return boundary === "step" || boundary === "idle"
  return boundary === "idle"
}

function observedEvidence(state: Supervisor.State) {
  return boundedUnique(
    [
      ...state.risks.flatMap((risk) => risk.evidence),
      ...state.filesTouched.map((file) => `file:${file}`),
      ...state.commandsRun.map((command) => `command:${command.command}`),
      ...state.validationsRun.map((command) => `validation:${command}`),
    ],
    100,
  )
}

function matchesGlob(file: string, glob: string) {
  const normalizedFile = file.replaceAll("\\", "/")
  const normalizedGlob = glob.replaceAll("\\", "/")
  if (normalizedGlob.startsWith("**/") && normalizedGlob.endsWith("/**")) {
    return normalizedFile.split("/").includes(normalizedGlob.slice(3, -3))
  }
  return new RegExp(
    `^${normalizedGlob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**", ".*")
      .replaceAll("*", "[^/]*")}$`,
  ).test(normalizedFile)
}

function normalizeEvent(event: EventPayload): NormalizedEvent | undefined {
  if (!isRecord(event.properties)) return
  const sessionID = sessionIDFromProperties(event.properties)
  if (!sessionID) return
  switch (event.type) {
    case "session.updated":
    case "message.updated":
    case "message.part.removed":
      return { type: "refresh" as const, sessionID, boundary: "step" }
    case "permission.asked":
    case "permission.replied":
      return {
        type: "derived" as const,
        sessionID,
        derived: { ...emptyDerived(), recentEvents: [{ type: event.type, outcome: "unknown" }], updatedAt: Date.now() },
        boundary: "event",
      }
  }
  if (event.type === "session.diff") {
    const diff = Array.isArray(event.properties.diff) ? event.properties.diff : []
    return {
      type: "derived" as const,
      sessionID,
      boundary: "event",
      derived: {
        ...emptyDerived(),
        filesTouched: diff.flatMap((item) => (isRecord(item) && typeof item.file === "string" ? [item.file] : [])),
        recentEvents: diff.flatMap((item) =>
          isRecord(item) && typeof item.file === "string" ? [{ type: "patch", target: item.file, outcome: "unknown" as const }] : [],
        ),
      },
    }
  }
  if (event.type === "session.error") {
    return {
      type: "derived" as const,
      sessionID,
      boundary: "event",
      derived: {
        ...emptyDerived(),
        status: "blocked",
        statusUpdated: true,
        recentEvents: [{ type: "session.error", outcome: "failure" }],
        updatedAt: Date.now(),
      },
    }
  }
  if (event.type === "session.idle") {
    return {
      type: "derived" as const,
      sessionID,
      boundary: "idle",
      derived: {
        ...emptyDerived(),
        status: "on_track",
        statusUpdated: true,
        recentEvents: [{ type: "idle", outcome: "success" }],
        updatedAt: Date.now(),
      },
    }
  }
  if (event.type === "session.status") {
    return {
      type: "derived" as const,
      sessionID,
      boundary: statusFromProperties(event.properties) === "on_track" ? "idle" : "event",
      derived: {
          ...emptyDerived(),
          status: statusFromProperties(event.properties),
          statusUpdated: true,
          recentEvents: [{ type: "session.status", outcome: statusFromProperties(event.properties) === "on_track" ? "success" : "unknown" }],
          updatedAt: Date.now(),
        },
    }
  }
  if (event.type === "message.part.updated" && isRecord(event.properties.part)) {
    return {
      type: "part" as const,
      sessionID,
      part: event.properties.part as MessageV2.Part,
      boundary: "step",
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
