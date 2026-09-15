import { Effect, Layer } from "effect"
import type { SessionPrompt } from "@/session/prompt"
import { InstanceStore } from "./instance-store"

const makeLayer = (promptLayer?: Layer.Layer<SessionPrompt.Service>): Layer.Layer<InstanceStore.Service> =>
  Layer.unwrap(
    Effect.promise(async () => {
      const { InstanceBootstrap } = await import("./bootstrap")
      const bootstrapLayer = promptLayer
        ? InstanceBootstrap.layerWithPrompt(promptLayer)
        : InstanceBootstrap.defaultLayer
      return InstanceStore.defaultLayer.pipe(Layer.provide(bootstrapLayer))
    }).pipe(Effect.orDie),
  )

export const layerWithPrompt = (promptLayer: Layer.Layer<SessionPrompt.Service>) => makeLayer(promptLayer)

export const layer = makeLayer()

export * as InstanceLayer from "./instance-layer"
