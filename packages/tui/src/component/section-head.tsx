import { Show } from "solid-js"
import { useTheme } from "../context/theme"

export function SectionHead(props: { label: string; aggregate?: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme.textFaint} attributes={1}>
        {props.label.toUpperCase()}
      </text>
      <Show when={props.aggregate}>{(value) => <text fg={theme.textMuted}>{value()}</text>}</Show>
    </box>
  )
}
