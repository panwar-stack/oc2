import { DateTime, Effect, Scope, Stream } from "effect"
import { Catalog } from "../catalog"
import { EventV2 } from "../event"
import { ModelV2 } from "../model"
import { ModelRequest } from "../model-request"
import { ModelsDev } from "../models-dev"
import { PluginV2 } from "../plugin"
import { ProviderV2 } from "../provider"

function released(date: string) {
  const time = Date.parse(date)
  return DateTime.makeUnsafe(Number.isFinite(time) ? time : 0)
}

export function modelCost(input: ModelsDev.Model["cost"]): ModelV2.Cost[] {
  if (!input) return []
  const base = {
    input: input.input,
    output: input.output,
    cache: {
      read: input.cache_read ?? 0,
      write: input.cache_write ?? 0,
    },
  }
  return [
    base,
    ...(input.tiers ?? []).map((item) => ({
      tier: item.tier,
      input: item.input,
      output: item.output,
      cache: {
        read: item.cache_read ?? 0,
        write: item.cache_write ?? 0,
      },
    })),
    ...(input.context_over_200k
      ? [
          {
            tier: {
              type: "context" as const,
              size: 200_000,
            },
            input: input.context_over_200k.input,
            output: input.context_over_200k.output,
            cache: {
              read: input.context_over_200k.cache_read ?? 0,
              write: input.context_over_200k.cache_write ?? 0,
            },
          },
        ]
      : []),
  ]
}

export function modelVariants(model: ModelsDev.Model, packageName?: string) {
  return Object.entries(model.experimental?.modes ?? {}).map(([id, item]) => {
    const request = ModelRequest.normalizeAiSdkOptions(packageName, item.provider?.body ?? {})
    return {
      id: ModelV2.VariantID.make(id),
      headers: { ...(item.provider?.headers ?? {}) },
      ...request,
      cost: item.cost ? modelCost(item.cost) : undefined,
    }
  })
}

export const ModelsDevPlugin = PluginV2.define({
  id: PluginV2.ID.make("models-dev"),
  effect: Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const modelsDev = yield* ModelsDev.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    const transform = yield* catalog.transform()
    const refresh = Effect.fn("ModelsDevPlugin.refresh")(function* () {
      const data = yield* modelsDev.get()
      yield* transform((catalog) => {
        for (const item of Object.values(data)) {
          const providerID = ProviderV2.ID.make(item.id)
          catalog.provider.update(providerID, (provider) => {
            provider.name = item.name
            provider.env = [...item.env]
            provider.api = item.npm
              ? {
                  type: "aisdk",
                  package: item.npm,
                  url: item.api,
                }
              : {
                  type: "native",
                  url: item.api,
                  settings: {},
                }
          })

          for (const model of Object.values(item.models)) {
            const modelID = ModelV2.ID.make(model.id)
            catalog.model.update(providerID, modelID, (draft) => {
              draft.name = model.name
              draft.family = model.family ? ModelV2.Family.make(model.family) : undefined
              draft.api = model.provider?.npm
                ? {
                    id: draft.api.id,
                    type: "aisdk",
                    package: model.provider?.npm,
                    url: model.provider.api,
                  }
                : {
                    id: draft.api.id,
                    type: "native",
                    url: model.provider?.api,
                    settings: {},
                  }
              draft.capabilities = {
                tools: model.tool_call,
                input: [...(model.modalities?.input ?? [])],
                output: [...(model.modalities?.output ?? [])],
              }
              draft.variants = modelVariants(model, model.provider?.npm ?? item.npm)
              draft.time.released = released(model.release_date)
              draft.cost = modelCost(model.cost)
              draft.status = model.status ?? "active"
              draft.enabled = true
              draft.limit = {
                context: model.limit.context,
                input: model.limit.input,
                output: model.limit.output,
              }
            })
          }
        }
      })
    })
    yield* refresh()
    yield* events.subscribe(ModelsDev.Event.Refreshed).pipe(
      Stream.runForEach(() => refresh()),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
