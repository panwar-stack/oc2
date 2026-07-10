import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommandV2 } from "@oc2-ai/core/command"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { testEffect } from "./lib/effect"

const it = testEffect(CommandV2.locationLayer)

describe("CommandV2", () => {
  it.effect("applies command transforms and preserves later overrides", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      const transform = yield* command.transform()
      yield* transform((editor) => {
        editor.update("deploy", (command) => {
          command.template = "First"
          command.description = "Deploy code"
        })
        editor.update("deploy", (command) => {
          command.template = "Second"
          command.model = {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          }
        })
      })

      expect(yield* command.get("deploy")).toEqual(
        new CommandV2.Info({
          name: "deploy",
          template: "Second",
          description: "Deploy code",
          model: {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          },
        }),
      )
      expect(yield* command.list()).toEqual([
        new CommandV2.Info({
          name: "deploy",
          template: "Second",
          description: "Deploy code",
          model: {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          },
        }),
      ])
    }),
  )
})
