import { Show, splitProps, type ComponentProps } from "solid-js"
import { StatusGlyph, type StatusGlyphName } from "./status-glyph"
import "./pill-v2.css"

export type PillV2Variant = "neutral" | "blue" | "amber" | "teal" | "purple" | "green" | "red"

export interface PillV2Props extends ComponentProps<"span"> {
  variant?: PillV2Variant
  size?: "small" | "normal"
  glyph?: StatusGlyphName
}

export function PillV2(props: PillV2Props) {
  const [local, rest] = splitProps(props, ["variant", "size", "glyph", "class", "classList", "children"])

  return (
    <span
      {...rest}
      data-component="pill-v2"
      data-variant={local.variant ?? "neutral"}
      data-size={local.size ?? "normal"}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Show when={local.glyph}>{(glyph) => <StatusGlyph name={glyph()} size="small" />}</Show>
      {local.children}
    </span>
  )
}
