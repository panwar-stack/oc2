import type { RGBA } from "@opentui/core"
import { Show } from "solid-js"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import "opentui-spinner/solid"

export const GLYPHS = {
  pending: "○",
  running: "◐",
  done: "✓",
  failed: "✕",
  "needs-you": "▲",
  collapsed: "▸",
  expanded: "▾",
  live: "●",
  mailbox: "✉",
  "tool-group": "⌗",
  attachment: "▤",
  "gauge-full": "▰",
  "gauge-empty": "▱",
  continuation: "↳",
} as const

export const BUSY_GLYPH_FRAMES = ["◐", "◑", "◓"] as const

export type GlyphName = keyof typeof GLYPHS

export function reduceTuiMotion(animationsEnabled: boolean, env = process.env.OC2_TUI_REDUCE_MOTION) {
  const value = env?.toLowerCase()
  return !animationsEnabled || value === "1" || value === "true" || value === "yes"
}

export function Glyph(props: { name: GlyphName; color?: RGBA }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => {
    if (props.color) return props.color
    if (props.name === "running") return theme.warning
    if (props.name === "done" || props.name === "live") return theme.success
    if (props.name === "failed") return theme.error
    if (props.name === "needs-you") return theme.accent
    if (props.name === "tool-group") return theme.secondary
    return theme.textMuted
  }
  const reduced = () => reduceTuiMotion(kv.get("animations_enabled", true))

  return (
    <Show when={props.name === "running" && !reduced()} fallback={<text fg={color()}>{GLYPHS[props.name]}</text>}>
      <spinner frames={[...BUSY_GLYPH_FRAMES]} interval={200} color={color()} />
    </Show>
  )
}
