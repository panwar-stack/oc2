import type { TuiTheme } from "../theme"
import { tuiElement } from "./elements"

export const DEFAULT_SIDEBAR_WIDTH = 42

export interface TuiSidebarFrameProps {
  readonly theme: TuiTheme
  readonly width?: number
  readonly visible: boolean
  readonly title?: string
  readonly children?: readonly unknown[]
}

export function getSidebarWidth(input: { readonly terminalWidth: number; readonly visible: boolean }): number {
  if (!input.visible || input.terminalWidth < 80) return 0
  return Math.min(DEFAULT_SIDEBAR_WIDTH, Math.max(24, input.terminalWidth - 60))
}

export function TuiSidebarFrame(props: TuiSidebarFrameProps): unknown | undefined {
  if (!props.visible) return undefined
  return tuiElement(
    "box",
    {
      width: props.width ?? DEFAULT_SIDEBAR_WIDTH,
      flexShrink: 0,
      border: true,
      borderColor: props.theme.border,
      backgroundColor: props.theme.backgroundPanel,
      title: props.title,
      titleColor: props.theme.textMuted,
    },
    [...(props.children ?? [])],
  )
}
