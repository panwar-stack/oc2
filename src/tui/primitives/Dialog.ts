import type { TuiTheme } from "../theme"
import { tuiElement } from "./elements"

export interface TuiDialogProps {
  readonly theme: TuiTheme
  readonly open: boolean
  readonly terminalWidth: number
  readonly title?: string
  readonly size?: "medium" | "large" | "xlarge"
  readonly children?: readonly unknown[]
}

export function getDialogWidth(input: {
  readonly terminalWidth: number
  readonly size?: "medium" | "large" | "xlarge"
}): number {
  const desired = input.size === "xlarge" ? 116 : input.size === "large" ? 88 : 60
  return Math.max(24, Math.min(desired, input.terminalWidth - 4))
}

export function TuiDialog(props: TuiDialogProps): unknown | undefined {
  if (!props.open) return undefined
  return tuiElement(
    "box",
    {
      width: getDialogWidth({ terminalWidth: props.terminalWidth, size: props.size }),
      border: true,
      borderColor: props.theme.borderActive,
      backgroundColor: props.theme.backgroundMenu,
      title: props.title,
      titleColor: props.theme.text,
    },
    [...(props.children ?? [])],
  )
}
