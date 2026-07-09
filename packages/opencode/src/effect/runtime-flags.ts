import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("OC2_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@opencode/RuntimeFlags", {
  pure: bool("OC2_PURE"),
  disableDefaultPlugins: bool("OC2_DISABLE_DEFAULT_PLUGINS"),
  disableEmbeddedWebUi: bool("OC2_DISABLE_EMBEDDED_WEB_UI"),
  disableExternalSkills: bool("OC2_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("OC2_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("OC2_DISABLE_CLAUDE_CODE"),
    direct: bool("OC2_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("OC2_DISABLE_CLAUDE_CODE"),
    direct: bool("OC2_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("OC2_ENABLE_EXA"),
    legacy: bool("OC2_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("OC2_ENABLE_PARALLEL"),
    legacy: bool("OC2_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("OC2_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("OC2_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("OC2_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("OC2_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("OC2_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("OC2_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("OC2_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("OC2_EXPERIMENTAL_PLAN_MODE"),
  experimentalEventSystem: enabledByExperimental("OC2_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("OC2_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("OC2_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("OC2_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("OC2_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  experimentalNativeLlm: bool("OC2_EXPERIMENTAL_NATIVE_LLM"),
  experimentalWebSockets: bool("OC2_EXPERIMENTAL_WEBSOCKETS"),
  client: Config.string("OC2_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.defaultLayer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const defaultLayer = Service.defaultLayer.pipe(Layer.orDie)

export * as RuntimeFlags from "./runtime-flags"
