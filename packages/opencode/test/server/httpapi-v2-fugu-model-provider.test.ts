import { describe, expect } from "bun:test"
import { Log } from "@opencode-ai/core/util/log"
import { Effect, Layer } from "effect"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

void Log.init({ print: false })

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, httpApiLayer))
const projectOptions = { config: { formatter: false, lsp: false } }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function responseData(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.data)) return []
  return value.data
}

describe("v2 fugu model/provider HttpApi", () => {
  it.instance(
    "serves virtual fugu through model and provider endpoints",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const modelResponse = yield* requestInDirectory("/api/model", directory)
      const providerResponse = yield* requestInDirectory("/api/provider", directory)

      expect(modelResponse.status).toBe(200)
      expect(providerResponse.status).toBe(200)

      const modelBody = yield* modelResponse.json
      const providerBody = yield* providerResponse.json
      const fuguModel = responseData(modelBody).find(
        (model) => isRecord(model) && model.id === "fugu" && model.providerID === "fugu",
      )

      expect(isRecord(modelBody) && isRecord(modelBody.location) && modelBody.location.directory).toBe(directory)
      expect(isRecord(providerBody) && isRecord(providerBody.location) && providerBody.location.directory).toBe(directory)
      expect(isRecord(fuguModel)).toBe(true)
      expect(isRecord(fuguModel) && isRecord(fuguModel.capabilities) && fuguModel.capabilities.tools).toBe(true)
      expect(responseData(providerBody).some((provider) => isRecord(provider) && provider.id === "fugu")).toBe(true)
    }),
    projectOptions,
  )
})
