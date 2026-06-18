import { homedir } from "node:os"

import type { TuiTheme } from "../theme"
import { tuiElement } from "./elements"

export interface TuiFooterProps {
  readonly theme: TuiTheme
  readonly rootLabel: string | (() => string)
  readonly status?: string | (() => string | undefined)
  readonly hints?: readonly string[] | (() => readonly string[])
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
  return tuiElement(
    "box",
    {
      flexShrink: 0,
      border: true,
      borderColor: props.theme.borderSubtle,
      backgroundColor: props.theme.backgroundPanel,
    },
    [tuiElement(() => ({ content: formatFooterContent(props), fg: props.theme.textMuted }))],
  )
}

function formatFooterContent(props: TuiFooterProps): string {
  const rootLabel = typeof props.rootLabel === "function" ? props.rootLabel() : props.rootLabel
  const status = typeof props.status === "function" ? props.status() : props.status
  const hints = typeof props.hints === "function" ? props.hints() : (props.hints ?? [])
  return ["oc2", rootLabel, status ? `status=${status}` : undefined, ...hints].filter(Boolean).join("  ")
}

function abbreviateHome(path: string, home: string): string {
  if (!home || path === home) return path === home ? "~" : path
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}
