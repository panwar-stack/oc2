#!/usr/bin/env bun

import type { DesktopTheme } from "../src/theme/types"

const themePath = import.meta.dir + "/../src/theme/themes/oc-2.json"
const theme = (await Bun.file(themePath).json()) as DesktopTheme
const css = await Bun.file(import.meta.dir + "/../src/v2/styles/theme.css").text()

const light = readTokens("light")
const dark = readTokens("dark")

const required = [
  "v2-state-fg-thinking",
  "v2-state-fg-tool",
  "v2-state-fg-decision",
  "v2-state-fill-decision",
  "v2-pill-bg-blue",
  "v2-overlay-scrim-light",
  "v2-focus-ring",
  "v2-shadow-dialog",
  "v2-syntax-function",
  "v2-markdown-text",
  "v2-diff-added",
  "v2-terminal-ansi-15",
  "v2-agent-8",
]

for (const [mode, tokens] of Object.entries({ light, dark })) {
  const missing = required.filter((key) => !(key in tokens))
  if (missing.length) throw new Error(`Missing ${mode} OC-2 tokens: ${missing.join(", ")}`)
}

const next: DesktopTheme = {
  ...theme,
  light: { ...theme.light, v2Overrides: light },
  dark: { ...theme.dark, v2Overrides: dark },
}

await Bun.write(themePath, JSON.stringify(next, null, 2) + "\n")
console.log("Updated oc-2.json v2Overrides", Object.keys(light).length, "tokens per mode")

function readTokens(mode: "light" | "dark") {
  const selector = `[data-color-scheme="${mode}"]`
  const selectorIndex = css.indexOf(selector)
  const start = css.indexOf("{", selectorIndex)
  if (selectorIndex < 0 || start < 0) throw new Error(`Missing ${mode} OC-2 tokens`)

  let depth = 1
  let end = start + 1
  while (depth && end < css.length) {
    if (css[end] === "{") depth++
    if (css[end] === "}") depth--
    end++
  }
  if (depth) throw new Error(`Unclosed ${mode} OC-2 token block`)

  const block = css.slice(start + 1, end - 1)
  return Object.fromEntries(
    [...block.matchAll(/--(v2-[\w-]+):\s*([^;]+);/g)]
      .filter(([, key]) => !isStructural(key!))
      .map(([, key, value]) => [key, value!.replace(/\s+/g, " ").trim()]),
  )
}

function isStructural(key: string) {
  return (
    /^(v2-space-|v2-radius-|v2-border-width-|v2-font-family-|v2-font-size-|v2-line-height-|v2-letter-spacing-|v2-duration-|v2-ease-|v2-z-|v2-breakpoint-)/.test(
      key,
    ) ||
    key === "v2-sidebar-width" ||
    key === "v2-timeline-max-width" ||
    key === "v2-diff-split-min-width"
  )
}
