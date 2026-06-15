import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"

import { defaultConfig } from "../../src"
import type { ModelContext, ModelEvent, ModelInfo, ModelProvider, ModelRequest } from "../../src/model/provider"
import { createSessionRunService } from "../../src/session/run"
import { renderTui } from "../../src/tui/app"
import { applyModelPickerSelection, createInitialTuiState, openModelPicker, setModelOptions } from "../../src/tui/state"

test("renders model picker loading, filtered rows, selection marker, and truncation", () => {
  const state = {
    ...setModelOptions(openModelPicker(createInitialTuiState(true)), [
      {
        providerId: "anthropic",
        providerName: "Anthropic",
        model: {
          id: "claude-sonnet-4-with-a-very-long-id",
          name: "Claude Sonnet 4 With A Very Long Display Name",
          supportsTools: true,
          supportsReasoning: true,
        },
      },
      { providerId: "fake", providerName: "Fake", model: { id: "test", name: "Fake Test" } },
    ]),
    modelPickerQuery: "sonnet",
    modelPickerSelectedIndex: 0,
  }
  const output = renderTui(state, "", { width: 48 })

  expect(output).toContain("--- model picker ---")
  expect(output).toContain("Search: sonnet")
  expect(output).toContain("> Anthropic/Claude Sonnet 4 With A Very Long ...")
  expect(output).toContain("Up/Down move | Enter select | Esc close | Ctrl+V cycle variant")
  expect(output).not.toContain("Fake/Fake Test")
  expect(output).not.toContain("--- side panel ---")
})

test("renders loading, empty, no match, and partial failure states", () => {
  expect(renderTui({ ...openModelPicker(createInitialTuiState(false)), modelPickerLoading: true })).toContain(
    "Loading models...",
  )
  expect(renderTui(openModelPicker(createInitialTuiState(false)))).toContain("No providers configured")
  expect(renderTui({ ...openModelPicker(createInitialTuiState(false)), modelProviderCount: 1 })).toContain(
    "No models available",
  )

  const noMatch = {
    ...setModelOptions(openModelPicker(createInitialTuiState(false)), [modelOption("fake", "Fake")]),
    modelPickerQuery: "zzz",
  }
  expect(renderTui(noMatch)).toContain("No matching models")

  expect(renderTui({ ...noMatch, modelPickerError: "1 provider failed to list" })).toContain(
    "1 provider failed to list",
  )
})

test("renders variant picker rows and active model in footer/sidebar", () => {
  const state = applyModelPickerSelection(
    setModelOptions(openModelPicker(createInitialTuiState(true)), [
      {
        providerId: "fake",
        providerName: "Fake",
        model: {
          id: "test",
          name: "Fake Test",
          variants: [{ id: "fast", name: "Fast", description: "lower latency" }],
        },
      },
    ]),
  )
  const output = renderTui({ ...state, modelPickerSelectedIndex: 1 }, "")

  expect(output).toContain("Select variant for fake/test")
  expect(output).toContain("  Default")
  expect(output).toContain("> Fast  lower latency")
  expect(output).toContain("model fake/test")
})

test("narrow terminal keeps model picker visible and hides slash/side panels", () => {
  const output = renderTui(
    {
      ...setModelOptions(openModelPicker(createInitialTuiState(true)), [modelOption("fake", "Fake")]),
      slashActive: true,
      slashMatches: [{ name: "review", display: "/review", description: "review", source: "builtin" }],
    },
    "/rev",
    { width: 60 },
  )

  expect(output).toContain("--- model picker ---")
  expect(output).not.toContain("--- side panel ---")
  expect(output).not.toContain("/review")
})

test("initial unknown model selection falls back to ids in footer", () => {
  const output = renderTui(createInitialTuiState(false, { config: defaultConfig, launchModel: "missing/unknown" }))

  expect(output).toContain("model missing/unknown")
})

test("session run service lists model options with per-provider failures", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "oc2-model-list-"))
  const service = createSessionRunService({
    config: defaultConfig,
    cwd: "/repo",
    dataDir,
    providers: [
      listingProvider("z-provider", "Z Provider", [{ id: "zeta", name: "Zeta" }]),
      failingListingProvider("bad", "Bad Provider"),
      listingProvider("a-provider", "A Provider", [{ id: "alpha", name: "Alpha" }]),
    ],
  })

  try {
    const result = await service.listModelOptions()

    expect(result.providerCount).toBe(3)
    expect(result.failedProviderCount).toBe(1)
    expect(result.errors[0]).toContain("cannot list")
    expect(result.options.map((option) => `${option.providerId}/${option.model.id}`)).toEqual([
      "a-provider/alpha",
      "z-provider/zeta",
    ])
  } finally {
    service.database?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

function modelOption(providerId: string, providerName: string) {
  return { providerId, providerName, model: { id: "test", name: "Fake Test" } }
}

function listingProvider(id: string, name: string, models: readonly ModelInfo[]): ModelProvider {
  return {
    id,
    name,
    async listModels() {
      return models
    },
    async *stream(_request: ModelRequest, _context: ModelContext): AsyncIterable<ModelEvent> {},
  }
}

function failingListingProvider(id: string, name: string): ModelProvider {
  return {
    id,
    name,
    async listModels() {
      throw new Error("cannot list SECRET_TOKEN")
    },
    async *stream(_request: ModelRequest, _context: ModelContext): AsyncIterable<ModelEvent> {},
  }
}
