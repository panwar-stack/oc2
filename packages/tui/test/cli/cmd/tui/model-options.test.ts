import { describe, expect, test } from "bun:test"
import { createDialogModelProviderOptions, sortModelOptions } from "../../../../src/component/dialog-model"

const fuguProvider = {
  id: "fugu",
  name: "Fugu",
  models: {
    fugu: {
      id: "fugu",
      providerID: "fugu",
      name: "Fugu",
      status: "active",
      release_date: "",
      cost: { input: 0 },
    },
  },
}

describe("sortModelOptions", () => {
  test("orders provider-scoped model choices by newest release first", () => {
    const sorted = sortModelOptions(
      [
        { title: "GPT 5.2", releaseDate: "2025-12-11" },
        { title: "GPT 5.4", releaseDate: "2026-03-05" },
        { title: "GPT 5.1", releaseDate: "2025-11-13" },
      ],
      true,
    )

    expect(sorted.map((model) => model.title)).toEqual(["GPT 5.4", "GPT 5.2", "GPT 5.1"])
  })

  test("preserves free-first alphabetical ordering for the regular picker", () => {
    const sorted = sortModelOptions(
      [
        { title: "Beta", releaseDate: "2026-01-01" },
        { title: "Alpha", releaseDate: "2025-01-01", footer: "Free" },
        { title: "Gamma", releaseDate: "2024-01-01", footer: "Free" },
      ],
      false,
    )

    expect(sorted.map((model) => model.title)).toEqual(["Alpha", "Gamma", "Beta"])
  })

  test("builds fugu option through the dialog model provider path", () => {
    const options = createDialogModelProviderOptions({
      providers: [fuguProvider],
      favorites: [],
      recents: [],
      connected: true,
      showSections: true,
      onSelect: () => {},
    })

    expect(options).toContainEqual(
      expect.objectContaining({
        value: { providerID: "fugu", modelID: "fugu" },
        title: "Fugu",
        category: "Fugu",
        footer: "Free",
      }),
    )
  })

  test("keeps fugu option in provider-scoped dialog model path", () => {
    const options = createDialogModelProviderOptions({
      providers: [fuguProvider],
      favorites: [],
      recents: [],
      providerID: "fugu",
      connected: true,
      showSections: true,
      onSelect: () => {},
    })

    expect(options.map((option) => option.value)).toEqual([{ providerID: "fugu", modelID: "fugu" }])
  })
})
