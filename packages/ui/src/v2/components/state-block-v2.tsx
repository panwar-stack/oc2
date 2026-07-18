import { type JSXElement, Show, splitProps } from "solid-js"
import { StatusGlyph, type StatusGlyphName } from "./status-glyph"
import "./state-block-v2.css"

export interface StateBlockV2Props {
  variant: "empty" | "error" | "loading"
  title: JSXElement
  description?: JSXElement
  action?: JSXElement
  hint?: JSXElement
  scale?: "section" | "full"
}

export function StateBlockV2(props: StateBlockV2Props) {
  const [local] = splitProps(props, ["variant", "title", "description", "action", "hint", "scale"])
  const glyph = (): StatusGlyphName =>
    local.variant === "error" ? "failed" : local.variant === "loading" ? "running" : "pending"

  return (
    <div
      data-component="state-block-v2"
      data-variant={local.variant}
      data-scale={local.scale ?? "section"}
      role={local.variant === "error" ? "alert" : local.variant === "loading" ? "status" : undefined}
      aria-live={local.variant === "loading" ? "polite" : undefined}
      aria-busy={local.variant === "loading" ? "true" : undefined}
    >
      <StatusGlyph name={glyph()} />
      <div data-slot="state-block-v2-copy">
        <strong data-slot="state-block-v2-title">{local.title}</strong>
        <Show when={local.description}>
          <span data-slot="state-block-v2-description">{local.description}</span>
        </Show>
      </div>
      <Show when={local.action || local.hint}>
        <div data-slot="state-block-v2-actions">
          {local.action}
          {local.hint}
        </div>
      </Show>
    </div>
  )
}
