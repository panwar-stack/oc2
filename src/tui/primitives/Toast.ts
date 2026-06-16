import type { TuiTheme, TuiThemeToast } from "../theme"
import { tuiElement } from "./elements"

export type TuiToast = TuiThemeToast

export interface TuiToastOverlayProps {
  readonly theme: TuiTheme
  readonly toasts: readonly TuiToast[]
  readonly width: number
}

export function toastColor(theme: TuiTheme, variant: TuiToast["variant"]): string {
  return theme[variant]
}

export function TuiToastOverlay(props: TuiToastOverlayProps): unknown | undefined {
  const toast = props.toasts[0]
  if (!toast) return undefined
  const title = toast.title ? `${toast.title}: ` : ""
  return tuiElement(
    "box",
    {
      width: Math.min(50, Math.max(24, props.width - 4)),
      flexShrink: 0,
      border: true,
      borderColor: toastColor(props.theme, toast.variant),
      backgroundColor: props.theme.backgroundMenu,
    },
    [tuiElement("text", { content: `${title}${toast.message}`, fg: props.theme.text })],
  )
}
