import { homedir } from "node:os"

import type { TuiTheme } from "../theme"
import { tuiElement } from "./elements"

export interface TuiFooterProps {
  readonly theme: TuiTheme
  readonly rootLabel: string
  readonly status?: string
  readonly hints?: readonly string[]
}

export function formatRootLabel(input: {
  readonly roots: readonly string[]
  readonly cwd: string
  readonly home?: string
}): string {
  const primary = input.roots[0] ?? input.cwd
  const home = input.home ?? homedir()
  const label = abbreviateHome(primary, home)
  const extra = input.roots.length > 1 ? ` +${input.roots.length - 1} roots` : ""
  return `${label}${extra}`
}

export function TuiFooter(props: TuiFooterProps): unknown {
  const text = [
    "footer placeholder",
    props.rootLabel,
    props.status ? `status=${props.status}` : undefined,
    ...(props.hints ?? []),
  ]
    .filter(Boolean)
    .join("  ")
  return tuiElement(
    "box",
    {
      flexShrink: 0,
      border: true,
      borderColor: props.theme.borderSubtle,
      backgroundColor: props.theme.backgroundPanel,
    },
    [tuiElement("text", { content: text, fg: props.theme.textMuted })],
  )
}

function abbreviateHome(path: string, home: string): string {
  if (!home || path === home) return path === home ? "~" : path
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}
