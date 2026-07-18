import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { tint } from "../theme"
import { Locale } from "../util/locale"

export interface TodoItemProps {
  status: string
  content: string
}

export function TodoItem(props: TodoItemProps) {
  const { theme } = useTheme()
  const terminal = () => props.status === "completed" || props.status === "cancelled"
  const color = () =>
    props.status === "in_progress"
      ? theme.warning
      : props.status === "completed"
        ? theme.success
        : props.status === "cancelled"
          ? theme.error
          : theme.textMuted
  const glyph = () =>
    props.status === "in_progress" ? "◐" : props.status === "completed" ? "✓" : props.status === "cancelled" ? "✕" : "○"

  return (
    <box
      flexDirection="row"
      gap={0}
      minWidth={0}
      backgroundColor={props.status === "in_progress" ? tint(theme.background, theme.warning, 0.06) : undefined}
    >
      <text flexShrink={0} fg={color()}>
        {glyph()}{" "}
      </text>
      <text
        flexGrow={1}
        wrapMode="none"
        attributes={
          terminal() ? TextAttributes.STRIKETHROUGH : props.status === "in_progress" ? TextAttributes.BOLD : undefined
        }
        fg={terminal() ? theme.textFaint : color()}
      >
        {Locale.truncate(props.content, 76)}
      </text>
    </box>
  )
}
