import { useTheme } from "../context/theme"

export function KeyHint(props: { shortcut: string; label?: string; active?: boolean }) {
  const { theme } = useTheme()
  return (
    <text wrapMode="none">
      <span style={{ fg: props.active ? theme.text : theme.textMuted, bg: theme.backgroundMenu, bold: true }}>
        {` ${props.shortcut} `}
      </span>
      {props.label ? <span style={{ fg: theme.textMuted }}> {props.label}</span> : null}
    </text>
  )
}
