#!/usr/bin/env bun

const tokens = [
  { token: "surface.app", web: "--v2-background-bg-base", tui: "background" },
  { token: "surface.bar", web: "--v2-background-bg-layer-01", tui: "backgroundPanel" },
  { token: "surface.card", web: "--v2-background-bg-layer-02", tui: "backgroundElement" },
  { token: "text.primary", web: "--v2-text-text-base", tui: "text" },
  { token: "text.secondary", web: "--v2-text-text-muted", tui: "textMuted" },
  { token: "text.accent", web: "--v2-text-text-accent", tui: "primary" },
  { token: "state.thinking.fg", web: "--v2-state-fg-thinking", tui: "warning" },
  { token: "state.tool.fg", web: "--v2-state-fg-tool", tui: "secondary" },
  { token: "state.decision.fg", web: "--v2-state-fg-decision", tui: "accent" },
  { token: "scrim", web: "--v2-overlay-simple-overlay-scrim", tui: "scrim" },
] as const

type Input = {
  master: string
  web: string
  tui: string
}

export function checkTokenParity(input: Input) {
  const master: unknown = JSON.parse(input.master)
  const tui: unknown = JSON.parse(input.tui)
  const semantic = isRecord(master) && isRecord(master.semantic) ? master.semantic : undefined
  const defs = isRecord(tui) && isRecord(tui.defs) ? tui.defs : undefined
  const theme = isRecord(tui) && isRecord(tui.theme) ? tui.theme : undefined
  const blocks = {
    light: input.web.match(/:root,\s*\[data-color-scheme="light"\]\s*\{([\s\S]*?)\n\s*\}/)?.[1],
    dark: input.web.match(/\[data-color-scheme="dark"\]\s*\{([\s\S]*?)\n\s*\}/)?.[1],
  }
  const errors: string[] = []

  for (const item of tokens) {
    const definitions = [...input.web.matchAll(new RegExp(`${item.web}\\s*:`, "g"))].length
    if (definitions !== 2) errors.push(`web: ${item.web} must have one definition per mode, found ${definitions}`)
  }

  for (const mode of ["light", "dark"] as const) {
    const block = blocks[mode]
    if (!block) {
      errors.push(`web ${mode}: mode block is missing`)
      continue
    }
    const web = new Map(
      [...block.matchAll(/^\s*(--v2-[\w-]+):\s*([^;]+);/gm)].map((match) => [match[1]!, match[2]!.trim()]),
    )

    for (const item of tokens) {
      const source = semantic?.[item.token]
      if (!isRecord(source) || typeof source[mode] !== "string") {
        errors.push(`master ${mode}: ${item.token} is missing`)
        continue
      }
      const expected = source[mode]
      if (source.web !== item.web || (source.tui !== item.tui && source.tui !== `${item.tui} (proposed)`)) {
        errors.push(
          `master ${mode}: ${item.token} mapping is ${String(source.web)} / ${String(source.tui)}, expected ${item.web} / ${item.tui}`,
        )
        continue
      }

      const entry = theme?.[item.tui]
      const reference = typeof entry === "string" ? entry : isRecord(entry) ? entry[mode] : undefined
      const definition = typeof reference === "string" ? defs?.[reference] : undefined
      const tuiValue =
        typeof definition === "string" ? definition : typeof reference === "string" ? reference : undefined
      const expectedColor = normalize(expected)
      const webValue = web.get(item.web)

      if (!webValue) errors.push(`web ${mode}: ${item.web} for ${item.token} is missing`)
      else if (normalize(webValue) !== expectedColor)
        errors.push(`web ${mode}: ${item.token} is ${webValue}, expected ${expected}`)

      if (!tuiValue) errors.push(`tui ${mode}: ${item.tui} for ${item.token} is missing`)
      else if (normalize(tuiValue) !== expectedColor)
        errors.push(`tui ${mode}: ${item.token} is ${tuiValue}, expected ${expected}`)
    }
  }

  if (errors.length > 0) throw new Error(`Token parity failed:\n${errors.map((error) => `- ${error}`).join("\n")}`)
  return tokens.length
}

function normalize(value: string) {
  const color = value.trim().toLowerCase()
  const hex = color.match(/^#([\da-f]{6})([\da-f]{2})?$/)
  if (hex) {
    const rgb = hex[1]!
    return [rgb.slice(0, 2), rgb.slice(2, 4), rgb.slice(4, 6), hex[2] ?? "ff"]
      .map((part) => Number.parseInt(part, 16))
      .join(",")
  }

  const rgba = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(\d*\.?\d+))?\s*\)$/)
  if (rgba) {
    const alpha = rgba[4] === undefined ? 255 : Math.round(Number.parseFloat(rgba[4]) * 255)
    return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), alpha].join(",")
  }

  throw new Error(`Unsupported parity color: ${value}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

if (import.meta.main) {
  const root = `${import.meta.dir}/..`
  const count = checkTokenParity({
    master: await Bun.file(`${root}/design-system/tokens.json`).text(),
    web: await Bun.file(`${root}/packages/ui/src/v2/styles/theme.css`).text(),
    tui: await Bun.file(`${root}/packages/tui/src/theme/assets/oc2.json`).text(),
  })
  console.log(`Token parity verified: ${count} shared tokens across light and dark web/TUI themes.`)
}
