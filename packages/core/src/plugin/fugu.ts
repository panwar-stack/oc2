export * as FuguPlugin from "./fugu"

import { Effect } from "effect"
import { Catalog } from "../catalog"
import { ModelV2 } from "../model"
import { PluginV2 } from "../plugin"
import { ProviderV2 } from "../provider"

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("fugu"),
  effect: Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const transform = yield* catalog.transform()

    yield* transform((catalog) => {
      const providerID = ProviderV2.ID.make("fugu")
      const modelID = ModelV2.ID.make("fugu")

      catalog.provider.update(providerID, (provider) => {
        provider.name = "Fugu"
        provider.enabled = { via: "custom", data: {} }
        provider.env = []
        provider.api = { type: "native", settings: {} }
        provider.request.headers = {}
        provider.request.body = {}
      })

      catalog.model.update(providerID, modelID, (model) => {
        model.name = "Fugu"
        model.family = ModelV2.Family.make("virtual")
        model.api = { id: modelID, type: "native", settings: {} }
        model.capabilities = {
          tools: true,
          input: ["text", "audio", "image", "video", "pdf"],
          output: ["text"],
        }
        model.variants = []
        model.cost = [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]
        model.status = "active"
        model.enabled = true
        model.limit = {
          context: 128_000,
          output: 16_384,
        }
      })
    })
  }),
})
