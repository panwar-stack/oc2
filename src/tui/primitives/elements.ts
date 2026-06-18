import { createElement, spread } from "@opentui/solid"

export function tuiElement(props: () => Record<string, unknown>): unknown
export function tuiElement(tag: string, props: () => Record<string, unknown>, children?: unknown[]): unknown
export function tuiElement(tag: string, props: Record<string, unknown>, children?: unknown[]): unknown
export function tuiElement(
  tagOrProps: string | (() => Record<string, unknown>),
  props: Record<string, unknown> | (() => Record<string, unknown>) = {},
  children: unknown[] = [],
) {
  if (typeof tagOrProps === "function") {
    const element = createElement("text")
    spread(element, () => ({ ...tagOrProps(), children: [] }))
    return element
  }
  const element = createElement(tagOrProps)
  spread(element, typeof props === "function" ? () => ({ ...props(), children }) : { ...props, children })
  return element
}
