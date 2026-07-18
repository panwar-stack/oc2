import { createMemo } from "solid-js"
import { useTheme } from "../context/theme"

export function Gauge(props: { value: number; max?: number; label: string; width?: number }) {
  const { theme } = useTheme()
  const max = createMemo(() => ((props.max ?? 0) > 0 ? props.max! : 100))
  const percentage = createMemo(() => Math.round((Math.min(Math.max(props.value, 0), max()) / max()) * 100))
  const width = createMemo(() => Math.max(1, props.width ?? 8))
  const filled = createMemo(() => Math.round((percentage() / 100) * width()))
  const color = createMemo(() =>
    percentage() >= 90 ? theme.error : percentage() >= 70 ? theme.warning : theme.success,
  )
  return (
    <text wrapMode="none">
      <span style={{ fg: theme.textMuted }}>{props.label} </span>
      <span style={{ fg: color() }}>{"▰".repeat(filled())}</span>
      <span style={{ fg: theme.textFaint }}>{"▱".repeat(width() - filled())}</span>
      <span style={{ fg: color() }}> {percentage()}%</span>
    </text>
  )
}
