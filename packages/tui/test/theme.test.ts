import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TerminalColors } from "@opentui/core"
import {
  DEFAULT_THEMES,
  addTheme,
  allThemes,
  generateSystem,
  hasTheme,
  resolveTheme,
  terminalMode,
  type ThemeJson,
} from "../src/theme"
import { discoverThemes } from "../src/context/theme"
import { resolveAgentColor } from "../src/context/local"
import { tmpdir } from "./fixture/fixture"

const LEGACY_THEME_KEYS = [
  "primary",
  "secondary",
  "accent",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "selectedListItemText",
  "background",
  "backgroundPanel",
  "backgroundElement",
  "backgroundMenu",
  "borderSubtle",
  "border",
  "borderActive",
  "diffAdded",
  "diffRemoved",
  "diffContext",
  "diffHunkHeader",
  "diffHighlightAdded",
  "diffHighlightRemoved",
  "diffAddedBg",
  "diffRemovedBg",
  "diffContextBg",
  "diffLineNumber",
  "diffAddedLineNumberBg",
  "diffRemovedLineNumberBg",
  "markdownText",
  "markdownHeading",
  "markdownLink",
  "markdownLinkText",
  "markdownCode",
  "markdownBlockQuote",
  "markdownEmph",
  "markdownStrong",
  "markdownHorizontalRule",
  "markdownListItem",
  "markdownListEnumeration",
  "markdownImage",
  "markdownImageText",
  "markdownCodeBlock",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOpacity",
] as const

test("addTheme writes into module theme store", () => {
  const name = `plugin-theme-${Date.now()}`
  expect(addTheme(name, DEFAULT_THEMES.oc2)).toBe(true)
  expect(allThemes()[name]).toBeDefined()
})

test("addTheme keeps first theme for duplicate names", () => {
  const name = `plugin-theme-keep-${Date.now()}`
  const one = structuredClone(DEFAULT_THEMES.oc2)
  const two = structuredClone(DEFAULT_THEMES.oc2)
  one.theme.primary = "#101010"
  two.theme.primary = "#fefefe"

  expect(addTheme(name, one)).toBe(true)
  expect(addTheme(name, two)).toBe(false)
  expect(allThemes()[name]!.theme.primary).toBe("#101010")
})

test("addTheme ignores entries without a theme object", () => {
  const name = `plugin-theme-invalid-${Date.now()}`
  expect(addTheme(name, { defs: { a: "#ffffff" } })).toBe(false)
  expect(allThemes()[name]).toBeUndefined()
})

test("hasTheme checks theme presence", () => {
  const name = `plugin-theme-has-${Date.now()}`
  expect(hasTheme(name)).toBe(false)
  expect(addTheme(name, DEFAULT_THEMES.oc2)).toBe(true)
  expect(hasTheme(name)).toBe(true)
})

test("resolveTheme rejects circular color refs", () => {
  const item = structuredClone(DEFAULT_THEMES.oc2)
  item.defs = { ...item.defs, one: "two", two: "one" }
  item.theme.primary = "one"
  expect(() => resolveTheme(item, "dark")).toThrow("Circular color reference")
})

test("every bundled theme resolves in dark and light modes", () => {
  for (const [name, item] of Object.entries(DEFAULT_THEMES)) {
    for (const mode of ["dark", "light"] as const) {
      const theme = resolveTheme(item, mode)
      expect(theme.agentColorRamp, `${name} ${mode} agent ramp`).toHaveLength(8)
      expect(theme.diffSplitCols, `${name} ${mode} diff split columns`).toBeNumber()
      expect(theme.scrim, `${name} ${mode} scrim`).toBeDefined()
      expect(theme.scrimLight, `${name} ${mode} light scrim`).toBeDefined()
      expect(theme.textFaint, `${name} ${mode} faint text`).toBeDefined()
    }
  }
})

test("legacy themes retain old optional behavior and receive new fallbacks", () => {
  const item: ThemeJson = structuredClone(DEFAULT_THEMES.aura)
  delete item.theme.selectedListItemText
  delete item.theme.backgroundMenu
  delete item.theme.thinkingOpacity
  delete item.theme.scrim
  delete item.theme.scrimLight
  delete item.theme.textFaint
  delete item.theme.agentColorRamp
  delete item.theme.diffSplitCols

  const theme = resolveTheme(item, "dark")
  expect(theme.selectedListItemText.toInts()).toEqual(theme.background.toInts())
  expect(theme.backgroundMenu.toInts()).toEqual(theme.backgroundElement.toInts())
  expect(theme.thinkingOpacity).toBe(0.6)
  expect(theme.scrim.toInts()).toEqual([0, 0, 0, 150])
  expect(theme.scrimLight.toInts()).toEqual([0, 0, 0, 70])
  expect(theme.textFaint.toInts()).toEqual(theme.textMuted.toInts())
  expect(theme.agentColorRamp.map((color) => color.toInts())).toEqual(
    [
      theme.secondary,
      theme.accent,
      theme.success,
      theme.warning,
      theme.primary,
      theme.error,
      theme.info,
      theme.secondary,
    ].map((color) => color.toInts()),
  )
  expect(theme.diffSplitCols).toBe(120)
})

test("agent color ramp rejects malformed present values", () => {
  const sparse = Array.from({ length: 8 }, () => "primary")
  Reflect.deleteProperty(sparse, "3")
  for (const ramp of [Array.from({ length: 7 }, () => "primary"), Array.from({ length: 9 }, () => "primary"), sparse]) {
    const item: ThemeJson = structuredClone(DEFAULT_THEMES.oc2)
    Reflect.set(item.theme, "agentColorRamp", ramp)
    expect(() => resolveTheme(item, "dark")).toThrow("agentColorRamp must contain exactly 8 colors")
  }
})

test("agent color ramp resolves defs references", () => {
  const item: ThemeJson = structuredClone(DEFAULT_THEMES.oc2)
  item.defs = { ...item.defs, rampColor: "#010203" }
  item.theme.agentColorRamp = ["rampColor", "primary", "secondary", "accent", "success", "warning", "error", "info"]
  expect(resolveTheme(item, "dark").agentColorRamp[0].toInts()).toEqual([1, 2, 3, 255])
})

test("oc2 resolves canonical house tokens in both modes", () => {
  expect(Object.keys(DEFAULT_THEMES.oc2.theme)).toHaveLength(58)
  const additions = new Set(["scrim", "scrimLight", "textFaint", "agentColorRamp", "diffSplitCols"])
  expect(
    Object.keys(DEFAULT_THEMES.oc2.theme)
      .filter((key) => !additions.has(key))
      .toSorted(),
  ).toEqual(LEGACY_THEME_KEYS.toSorted())
  const cases = {
    dark: {
      background: [10, 13, 18, 255],
      backgroundPanel: [15, 19, 26, 255],
      backgroundElement: [21, 27, 37, 255],
      backgroundMenu: [28, 36, 49, 255],
      text: [232, 235, 240, 255],
      textMuted: [154, 164, 178, 255],
      textFaint: [92, 102, 117, 255],
      primary: [91, 147, 255, 255],
      secondary: [62, 189, 180, 255],
      accent: [167, 139, 250, 255],
      scrim: [0, 0, 0, 150],
      scrimLight: [0, 0, 0, 69],
      agentColorRamp: [
        [91, 147, 255, 255],
        [62, 189, 180, 255],
        [167, 139, 250, 255],
        [67, 178, 111, 255],
        [232, 163, 61, 255],
        [229, 83, 75, 255],
        [79, 195, 232, 255],
        [242, 123, 167, 255],
      ],
    },
    light: {
      background: [255, 255, 255, 255],
      backgroundPanel: [243, 245, 249, 255],
      backgroundElement: [233, 237, 244, 255],
      backgroundMenu: [220, 227, 238, 255],
      text: [22, 27, 36, 255],
      textMuted: [82, 94, 112, 255],
      textFaint: [103, 113, 127, 255],
      primary: [46, 91, 184, 255],
      secondary: [12, 110, 103, 255],
      accent: [109, 79, 194, 255],
      scrim: [22, 27, 36, 115],
      scrimLight: [22, 27, 36, 56],
      agentColorRamp: [
        [46, 91, 184, 255],
        [12, 110, 103, 255],
        [109, 79, 194, 255],
        [28, 110, 64, 255],
        [143, 90, 14, 255],
        [190, 56, 48, 255],
        [11, 107, 132, 255],
        [181, 62, 113, 255],
      ],
    },
  }

  for (const mode of ["dark", "light"] as const) {
    const theme = resolveTheme(DEFAULT_THEMES.oc2, mode)
    for (const key of [
      "background",
      "backgroundPanel",
      "backgroundElement",
      "backgroundMenu",
      "text",
      "textMuted",
      "textFaint",
      "primary",
      "secondary",
      "accent",
      "scrim",
      "scrimLight",
    ] as const) {
      expect([...theme[key].toInts()], `${mode} ${key}`).toEqual(cases[mode][key])
    }
    expect(
      theme.agentColorRamp.map((color) => [...color.toInts()]),
      `${mode} agent ramp`,
    ).toEqual(cases[mode].agentColorRamp)
    expect(theme.diffSplitCols).toBe(120)
    expect(theme.thinkingOpacity).toBe(0.7)
  }
})

test("generateSystem maps semantic hues to ANSI slots", () => {
  const palette = Array.from({ length: 16 }, (_, index) => `#${index.toString(16).repeat(6)}`)
  const theme = resolveTheme(generateSystem(terminalColors("#010101", palette), "dark"), "dark")
  expect(theme.primary.toInts()).toEqual([68, 68, 68, 255])
  expect(theme.info.toInts()).toEqual([68, 68, 68, 255])
  expect(theme.borderActive.toInts()).toEqual([68, 68, 68, 255])
  expect(theme.secondary.toInts()).toEqual([102, 102, 102, 255])
  expect(theme.accent.toInts()).toEqual([85, 85, 85, 255])
  expect(theme.error.toInts()).toEqual([17, 17, 17, 255])
  expect(theme.success.toInts()).toEqual([34, 34, 34, 255])
  expect(theme.warning.toInts()).toEqual([51, 51, 51, 255])
})

test("generateSystem uses canonical ANSI-256 neutral spreads", () => {
  const darkPalette = Array<string | null>(256).fill(null)
  darkPalette[0] = "#000000"
  darkPalette[7] = "#ffffff"
  darkPalette[234] = "#111111"
  darkPalette[235] = "#222222"
  darkPalette[236] = "#333333"
  darkPalette[237] = "#444444"
  const dark = resolveTheme(generateSystem(terminalColors("#010101", darkPalette), "dark"), "dark")
  expect(dark.backgroundPanel.toInts()).toEqual([17, 17, 17, 255])
  expect(dark.backgroundElement.toInts()).toEqual([34, 34, 34, 255])
  expect(dark.backgroundMenu.toInts()).toEqual([51, 51, 51, 255])
  expect(dark.borderSubtle.toInts()).toEqual([68, 68, 68, 255])
  expect(dark.border.toInts()).toEqual([68, 68, 68, 255])

  const lightPalette = Array<string | null>(256).fill(null)
  lightPalette[0] = "#000000"
  lightPalette[7] = "#ffffff"
  lightPalette[250] = "#aaaaaa"
  lightPalette[251] = "#bbbbbb"
  lightPalette[253] = "#cccccc"
  lightPalette[254] = "#dddddd"
  lightPalette[255] = "#eeeeee"
  const light = resolveTheme(generateSystem(terminalColors("#fefefe", lightPalette), "light"), "light")
  expect(light.backgroundPanel.toInts()).toEqual([238, 238, 238, 255])
  expect(light.backgroundElement.toInts()).toEqual([221, 221, 221, 255])
  expect(light.backgroundMenu.toInts()).toEqual([204, 204, 204, 255])
  expect(light.borderSubtle.toInts()).toEqual([187, 187, 187, 255])
  expect(light.border.toInts()).toEqual([170, 170, 170, 255])
})

test("generateSystem falls back to canonical xterm neutrals when the 256 palette is partial", () => {
  const palette = Array<string | null>(16).fill(null)
  palette[0] = "#000000"
  palette[7] = "#ffffff"

  const dark = resolveTheme(generateSystem(terminalColors("#010101", palette), "dark"), "dark")
  expect(dark.backgroundPanel.toInts()).toEqual([28, 28, 28, 255])
  expect(dark.backgroundElement.toInts()).toEqual([38, 38, 38, 255])
  expect(dark.backgroundMenu.toInts()).toEqual([48, 48, 48, 255])
  expect(dark.border.toInts()).toEqual([58, 58, 58, 255])

  const light = resolveTheme(generateSystem(terminalColors("#fefefe", palette), "light"), "light")
  expect(light.backgroundPanel.toInts()).toEqual([238, 238, 238, 255])
  expect(light.backgroundElement.toInts()).toEqual([228, 228, 228, 255])
  expect(light.backgroundMenu.toInts()).toEqual([218, 218, 218, 255])
  expect(light.borderSubtle.toInts()).toEqual([198, 198, 198, 255])
  expect(light.border.toInts()).toEqual([188, 188, 188, 255])
})

test("system theme requests the full ANSI-256 palette", async () => {
  const context = await Bun.file(`${import.meta.dir}/../src/context/theme.tsx`).text()
  expect(context).toContain("getPalette({ size: 256 })")
})

test("agent colors are deterministic by name and configured colors take precedence", () => {
  const theme = resolveTheme(DEFAULT_THEMES.oc2, "dark")
  const names = Array.from({ length: 64 }, (_, index) => `agent-${index}`)
  const forward = Object.fromEntries(names.map((name) => [name, resolveAgentColor(theme, name).toInts()]))
  const reordered = Object.fromEntries(
    names.toReversed().map((name) => [name, resolveAgentColor(theme, name).toInts()]),
  )
  const used = new Set(Object.values(forward).map(String))
  expect(reordered).toEqual(forward)
  expect([...used].toSorted()).toEqual(theme.agentColorRamp.map((color) => String(color.toInts())).toSorted())
  expect(used.size).toBe(8)
  expect(resolveAgentColor(theme, "build", "warning").toInts()).toEqual(theme.warning.toInts())
  expect(resolveAgentColor(theme, "build", "#010203").toInts()).toEqual([1, 2, 3, 255])
})

function terminalColors(defaultBackground: string | null, palette: Array<string | null> = []): TerminalColors {
  return {
    palette,
    defaultForeground: null,
    defaultBackground,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test("terminalMode derives mode from refreshed background", () => {
  expect(terminalMode(terminalColors("#fbf1c7"))).toBe("light")
  expect(terminalMode(terminalColors("#1a1b26"))).toBe("dark")
})

test("terminalMode does not derive mode from ANSI slot zero", () => {
  expect(terminalMode(terminalColors(null, ["#000000"]))).toBeUndefined()
})

test("custom theme precedence follows directory order", async () => {
  await using tmp = await tmpdir()
  const global = path.join(tmp.path, "global")
  const project = path.join(tmp.path, "project")
  await mkdir(path.join(global, "themes"), { recursive: true })
  await mkdir(path.join(project, "themes"), { recursive: true })
  await writeFile(path.join(global, "themes", "custom.json"), JSON.stringify({ source: "global" }))
  await writeFile(path.join(project, "themes", "custom.json"), JSON.stringify({ source: "project" }))

  await expect(discoverThemes([global, project])).resolves.toEqual({ custom: { source: "project" } })
})
