/** @jsxImportSource solid-js */
import { afterEach, describe, expect, mock, test } from "bun:test"
import type { Provider } from "@oc2-ai/sdk/v2"
import { createComponent, createRoot } from "solid-js"

const storage = new Map<string, string>()

mock.module("@solidjs/router", () => ({
  useParams: () => ({}),
}))

mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    platform: "web",
    openLink() {},
    async restart() {},
    back() {},
    forward() {},
    async notify() {},
    storage: () => ({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    }),
  }),
}))

mock.module("@/context/server-sync", () => ({
  useServerSync: () => ({
    data: {
      provider: {
        all: new Map([
          ["anthropic", provider("anthropic", { "claude-sonnet-4": model("claude-sonnet-4") })],
          ["fugu", provider("fugu", { fugu: model("fugu") })],
        ]),
        connected: ["anthropic", "fugu"],
        default: { anthropic: "claude-sonnet-4" },
      },
    },
    child: () => [{ provider_ready: false }],
  }),
}))

mock.module("@/utils/persist", () => ({
  Persist: {
    global: () => "model",
  },
  persisted: (_persist: unknown, store: [unknown, unknown]) => [store[0], store[1], undefined, true],
}))

mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: (input: { init: (props?: unknown) => unknown }) => {
    let value: unknown
    return {
      use: () => value,
      provider: (props: { children?: unknown }) => {
        value = input.init(props)
        return props.children
      },
    }
  },
}))

afterEach(() => {
  storage.clear()
})

describe("ModelsProvider", () => {
  test("lists connected provider models", async () => {
    const { ModelsProvider, useModels } = await import("./models")
    let listed: ReturnType<ReturnType<typeof useModels>["list"]> = []
    let visible = false

    function Probe() {
      const models = useModels()
      listed = models.list()
      visible =
        models.visible({ providerID: "anthropic", modelID: "claude-sonnet-4" }) &&
        models.visible({ providerID: "fugu", modelID: "fugu" })
      return undefined
    }

    const dispose = createRoot((dispose) => {
      createComponent(ModelsProvider, {
        get children() {
          return createComponent(Probe, {})
        },
      })
      return dispose
    })

    try {
      expect(listed.some((item) => item.provider.id === "anthropic" && item.id === "claude-sonnet-4")).toBe(true)
      expect(listed.some((item) => item.provider.id === "fugu" && item.id === "fugu")).toBe(true)
      expect(visible).toBe(true)
    } finally {
      dispose()
    }
  })
})

function provider(id: string, models: Provider["models"]): Provider {
  return {
    id,
    name: id,
    source: "api",
    env: [],
    options: {},
    models,
  }
}

function model(id: string): Provider["models"][string] {
  return {
    id,
    providerID: "test",
    api: { id: "test", url: "", npm: "" },
    name: id,
    family: id,
    release_date: "",
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 16_384 },
    status: "active",
    options: {},
    headers: {},
  }
}
