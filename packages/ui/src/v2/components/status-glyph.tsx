import { For, Show, splitProps, type ComponentProps } from "solid-js"
import "./status-glyph.css"

export const STATUS_GLYPHS = {
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
  brand: "›_",
  continuation: "↳",
  separator: "·",
  enter: "⏎",
} as const

export type StatusGlyphName = keyof typeof STATUS_GLYPHS

export interface StatusGlyphProps extends Omit<ComponentProps<"span">, "children"> {
  name: StatusGlyphName
  size?: "small" | "normal" | "large"
  label?: string
}

export function StatusGlyph(props: StatusGlyphProps) {
  const [local, rest] = splitProps(props, ["name", "size", "label", "class", "classList"])

  return (
    <span
      {...rest}
      data-component="status-glyph"
      data-variant={local.name}
      data-size={local.size ?? "normal"}
      role={local.label ? "img" : undefined}
      aria-label={local.label}
      aria-hidden={local.label ? undefined : "true"}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Show when={local.name === "running"} fallback={STATUS_GLYPHS[local.name]}>
        <For each={["◐", "◑", "◓"] as const}>
          {(frame, index) => (
            <span data-slot="status-glyph-frame" data-frame={index()}>
              {frame}
            </span>
          )}
        </For>
      </Show>
    </span>
  )
}
