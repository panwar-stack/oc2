import { describe, expect, test } from "bun:test"
import type { DesktopTheme } from "./types"
import { resolveTheme } from "./resolve"
import { resolveThemeV2 } from "./v2/resolve"
import oc2ThemeJson from "./themes/oc-2.json"

const paths = await Array.fromAsync(new Bun.Glob("themes/*.json").scan({ cwd: import.meta.dir }))
const themes = await Promise.all(
  paths.map(async (path) => ({ path, theme: (await Bun.file(`${import.meta.dir}/${path}`).json()) as DesktopTheme })),
)
const oc2Theme = oc2ThemeJson as DesktopTheme

describe("theme resolution", () => {
  test("resolves every bundled theme in both modes", () => {
    expect(themes.length).toBeGreaterThan(1)

    for (const entry of themes) {
      const legacy = resolveTheme(entry.theme)
      const v2 = resolveThemeV2(entry.theme)

      for (const tokens of [legacy.light, legacy.dark, v2.light, v2.dark]) {
        expect(Object.keys(tokens).length, entry.path).toBeGreaterThan(0)
        expect(Object.values(tokens).every(Boolean), entry.path).toBe(true)
      }
    }
  })

  test("keeps OC-2 overrides semantic and mode-complete", () => {
    const light = oc2Theme.light.v2Overrides ?? {}
    const dark = oc2Theme.dark.v2Overrides ?? {}
    const structural =
      /^(v2-space-|v2-radius-|v2-border-width-|v2-font-family-|v2-font-size-|v2-line-height-|v2-letter-spacing-|v2-duration-|v2-ease-|v2-z-|v2-breakpoint-|v2-sidebar-width$|v2-timeline-max-width$|v2-diff-split-min-width$)/
    const primitive = /^v2-(grey|red|orange|yellow|green|cyan|blue|purple|pink)-\d+$/

    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort())
    expect(Object.keys(light).some((key) => structural.test(key) || primitive.test(key))).toBe(false)

    for (const key of [
      "v2-state-fg-thinking",
      "v2-state-fg-tool",
      "v2-state-fg-decision",
      "v2-shadow-dialog",
      "v2-syntax-function",
      "v2-markdown-text",
      "v2-diff-added",
      "v2-terminal-ansi-15",
      "v2-agent-8",
    ]) {
      expect(light[key], key).toBeDefined()
      expect(dark[key], key).toBeDefined()
    }
  })

  test("meets contrast for essential OC-2 semantic pairs", () => {
    const resolved = resolveThemeV2(oc2Theme)
    const pairs = [
      ["v2-text-text-base", "v2-background-bg-base"],
      ["v2-text-text-muted", "v2-background-bg-base"],
      ["v2-text-text-accent", "v2-background-bg-base"],
      ["v2-state-fg-thinking", "v2-background-bg-base"],
      ["v2-state-fg-tool", "v2-background-bg-base"],
      ["v2-state-fg-decision", "v2-background-bg-base"],
      ["v2-state-fg-success", "v2-background-bg-base"],
      ["v2-state-fg-danger", "v2-background-bg-base"],
      ["v2-text-text-inverse", "v2-state-fill-decision"],
      ["v2-text-text-contrast", "v2-background-bg-accent"],
      ["v2-state-fg-danger", "v2-pill-bg-red"],
    ] as const

    for (const [mode, tokens] of Object.entries(resolved)) {
      for (const [foreground, background] of pairs) {
        expect(
          contrast(tokens[foreground]!, tokens[background]!),
          `${mode}: ${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
      expect(
        contrast(tokens["v2-text-text-faint"]!, tokens["v2-background-bg-base"]!),
        `${mode}: decorative tertiary text`,
      ).toBeGreaterThanOrEqual(3)
    }
  })
})

describe("v2 theme CSS", () => {
  test("declares every referenced v2 variable", async () => {
    const theme = await Bun.file(`${import.meta.dir}/../v2/styles/theme.css`).text()
    const primitives = await Bun.file(`${import.meta.dir}/../v2/styles/colors.css`).text()
    const paths = await Array.fromAsync(new Bun.Glob("v2/**/*.css").scan({ cwd: `${import.meta.dir}/..` }))
    const styles = await Promise.all(paths.map((path) => Bun.file(`${import.meta.dir}/../${path}`).text()))
    const declarations = new Set(
      [...`${theme}\n${primitives}`.matchAll(/--(v2-[\w-]+)\s*:/g)].map((match) => match[1]!),
    )
    const references = [...styles.join("\n").matchAll(/var\(--(v2-[\w-]+)/g)].map((match) => match[1]!)

    expect([...new Set(references)].filter((key) => !declarations.has(key))).toEqual([])
  })

  test("bridges additive color tokens to Tailwind", async () => {
    const tailwind = await Bun.file(`${import.meta.dir}/../styles/tailwind/colors.css`).text()

    for (const key of [
      "v2-state-fg-thinking",
      "v2-pill-bg-purple",
      "v2-syntax-function",
      "v2-markdown-link",
      "v2-diff-added",
      "v2-terminal-ansi-15",
      "v2-agent-8",
    ]) {
      expect(tailwind, key).toContain(`--color-${key}: var(--${key});`)
    }
  })

  test("reduces every v2 motion duration", async () => {
    const theme = await Bun.file(`${import.meta.dir}/../v2/styles/theme.css`).text()

    expect(theme).toContain("@media (prefers-reduced-motion: reduce)")
    for (const key of ["instant", "fast", "base", "slow", "caret", "spinner-frame"])
      expect(theme, key).toContain(`--v2-duration-${key}: 0.01ms;`)
    expect(theme).toContain("animation-iteration-count: 1 !important;")
    expect(theme).toContain("scroll-behavior: auto !important;")
  })

  test("switches the legacy bridge with the shared color-scheme attribute", async () => {
    const legacy = await Bun.file(`${import.meta.dir}/../styles/theme.css`).text()

    expect(legacy).toContain('[data-color-scheme="dark"]')
    expect(legacy).not.toContain("@media (prefers-color-scheme: dark)")

    const keys = [
      "background-base",
      "background-weak",
      "surface-raised-base",
      "surface-raised-strong",
      "surface-raised-stronger",
      "surface-brand-base",
      "text-strong",
      "text-base",
      "text-weak",
      "text-weaker",
      "text-interactive-base",
      "text-invert-base",
      "text-on-brand-base",
      "border-base",
      "border-weaker-base",
      "border-strong-base",
      "border-focus",
      "text-on-critical-base",
      "surface-critical-base",
      "border-critical-base",
      "text-on-warning-base",
      "surface-warning-base",
      "border-warning-base",
      "text-on-success-base",
      "surface-success-base",
      "border-success-base",
      "text-on-info-base",
      "surface-info-base",
      "border-info-base",
    ]

    for (const [mode, selector] of [
      ["light", ":root"],
      ["dark", '[data-color-scheme="dark"]'],
    ] as const) {
      const declarations = Object.fromEntries(
        [...cssBlock(legacy, selector).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]),
      )
      const overrides = oc2Theme[mode].overrides ?? {}
      for (const key of keys)
        expect(declarations[key]?.toLowerCase(), `${mode}: ${key}`).toBe(overrides[key]?.toLowerCase())
    }
  })
})

function contrast(foreground: string, background: string) {
  const luminance = (value: string) => {
    const channels = value
      .slice(1, 7)
      .match(/.{2}/g)!
      .map((channel) => parseInt(channel, 16) / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
  }
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function cssBlock(css: string, selector: string) {
  const selectorIndex = css.indexOf(selector)
  const start = css.indexOf("{", selectorIndex)
  let depth = 1
  let end = start + 1
  while (depth && end < css.length) {
    if (css[end] === "{") depth++
    if (css[end] === "}") depth--
    end++
  }
  return css.slice(start + 1, end - 1)
}
