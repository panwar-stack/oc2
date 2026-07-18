import { TextAttributes, type RGBA } from "@opentui/core"
import { Show, type JSX } from "solid-js"
import type { Theme } from "../theme"

export interface StateBlockProps {
  theme: Pick<Theme, "text" | "textMuted" | "textFaint" | "error" | "warning">
  variant: "empty" | "error" | "loading"
  title: string
  description?: string
  action?: JSX.Element
  hint?: JSX.Element
  scale?: "inline" | "full"
}

export function StateBlock(props: StateBlockProps) {
  const glyph = () => (props.variant === "error" ? "✕" : props.variant === "loading" ? "◐" : "○")
  const color = (): RGBA =>
    props.variant === "error"
      ? props.theme.error
      : props.variant === "loading"
        ? props.theme.warning
        : props.theme.textFaint

  return (
    <box
      flexDirection={props.scale === "inline" ? "row" : "column"}
      alignItems={props.scale === "inline" ? "flex-start" : "center"}
      justifyContent="center"
      maxWidth={props.scale === "inline" ? undefined : 44}
      flexShrink={props.scale === "inline" ? 1 : 0}
      gap={props.scale === "inline" ? 1 : 0}
      border={props.variant === "error" && props.scale !== "inline" ? ["left"] : undefined}
      borderColor={props.variant === "error" ? props.theme.error : undefined}
      paddingLeft={props.variant === "error" && props.scale !== "inline" ? 2 : 0}
      paddingRight={props.variant === "error" && props.scale !== "inline" ? 2 : 0}
    >
      <text fg={color()}>{glyph()}</text>
      <text fg={props.theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
        {props.title}
      </text>
      <Show when={props.description}>
        {(description) => (
          <text fg={props.theme.textMuted} wrapMode="none">
            {description()}
          </text>
        )}
      </Show>
      <Show when={props.action || props.hint}>
        <box
          flexDirection={props.scale === "inline" ? "row" : "column"}
          gap={props.scale === "inline" ? 2 : 0}
          paddingTop={props.scale === "inline" ? 0 : 1}
        >
          {props.action}
          {props.hint}
        </box>
      </Show>
    </box>
  )
}
