import type { RGBA } from "@opentui/core"
import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { Locale } from "../util/locale"

export function TurnFooter(props: {
  agent: string
  model: string
  color: RGBA
  duration?: string
  tokens?: number
  interrupted?: boolean
}) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={3} flexShrink={0}>
      <text marginTop={1} wrapMode="none">
        <span style={{ fg: props.interrupted ? theme.textMuted : props.color }}>● </span>
        <span style={{ fg: theme.textMuted }}>
          {Locale.titlecase(props.agent)} · {props.model}
        </span>
        <Show when={props.duration}>
          <span style={{ fg: theme.textFaint }}> · {props.duration}</span>
        </Show>
        <Show when={props.tokens && props.tokens > 0}>
          <span style={{ fg: theme.textFaint }}> · {props.tokens!.toLocaleString()} tokens</span>
        </Show>
        <Show when={props.interrupted}>
          <span style={{ fg: theme.textMuted }}> · interrupted</span>
        </Show>
      </text>
    </box>
  )
}
