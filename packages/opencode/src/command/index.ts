import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { SessionID, MessageID } from "@/session/schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { EventV2 } from "@oc2-ai/core/event"
import PROMPT_CLARIFY from "./template/clarify.txt"
import PROMPT_SPAWN from "./template/spawn.txt"
import PROMPT_IMPLEMENT_SPEC_PR from "./template/spec-implement.txt"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_LEARN from "./template/learn.txt"
import PROMPT_LOCAL_FUSION from "./template/local-fusion.txt"
import PROMPT_SPEC_PLANNER from "./template/spec-planner.txt"
import PROMPT_USE_TEAM from "./template/use-team.txt"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: EventV2.define({
    type: "command.executed",
    schema: {
      name: Schema.String,
      sessionID: SessionID,
      arguments: Schema.String,
      messageID: MessageID,
    },
  }),
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  CLARIFY: "clarify",
  IMPLEMENT_SPEC_PR: "spec:implement",
  INIT: "init",
  LEARN: "learn",
  LOCAL_FUSION: "local:fusion",
  SPAWN: "spawn",
  SPEC_PLANNER: "spec:planner",
  USE_TEAM: "use-team",
} as const

export const Model = {
  SMALL: "small_model",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup with required engineering principles",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.LEARN] = {
        name: Default.LEARN,
        description: "Extract non-obvious learnings from session to AGENTS.md files to build codebase understanding",
        source: "command",
        get template() {
          return PROMPT_LEARN
        },
        hints: hints(PROMPT_LEARN),
      }
      commands[Default.LOCAL_FUSION] = {
        name: Default.LOCAL_FUSION,
        description: "Run a named local_fusion config with a prompt.",
        source: "command",
        get template() {
          return PROMPT_LOCAL_FUSION
        },
        hints: hints(PROMPT_LOCAL_FUSION),
      }
      commands[Default.CLARIFY] = {
        name: Default.CLARIFY,
        description: "Clarify underspecified requests before planning or implementation.",
        source: "command",
        get template() {
          return PROMPT_CLARIFY
        },
        hints: hints(PROMPT_CLARIFY),
      }
      commands[Default.USE_TEAM] = {
        name: Default.USE_TEAM,
        description: "use agent team to accomplish the task",
        source: "command",
        get template() {
          return PROMPT_USE_TEAM
        },
        hints: hints(PROMPT_USE_TEAM),
      }
      commands[Default.SPAWN] = {
        name: Default.SPAWN,
        description: "run a prompt in a background subtask",
        source: "command",
        model: Model.SMALL,
        get template() {
          return PROMPT_SPAWN
        },
        subtask: true,
        hints: hints(PROMPT_SPAWN),
      }
      commands[Default.SPEC_PLANNER] = {
        name: Default.SPEC_PLANNER,
        description:
          "Convert rough requirements, feature ideas, bug themes, or implementation goals into concrete engineering specs.",
        source: "command",
        get template() {
          return PROMPT_SPEC_PLANNER
        },
        hints: hints(PROMPT_SPEC_PLANNER),
      }
      commands[Default.IMPLEMENT_SPEC_PR] = {
        name: Default.IMPLEMENT_SPEC_PR,
        description: "Understand a specification thoroughly and implement only the requested PR slice.",
        source: "command",
        get template() {
          return PROMPT_IMPLEMENT_SPEC_PR
        },
        hints: hints(PROMPT_IMPLEMENT_SPEC_PR),
      }
      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (item.name === "spec-planner" || commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            return item.content
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Command from "."
