import { TextAttributes, type BoxRenderable, type KeyEvent, type RGBA } from "@opentui/core"
import { useRenderer, type JSX } from "@opentui/solid"
import { For, Show, createMemo, createSignal } from "solid-js"
import {
  isDeniedToolError,
  toolAggregate,
  toolDetails,
  toolErrorSummary,
  toolState,
  toolSummary,
} from "@oc2-ai/ui/tool-summary"
import { useTheme } from "../context/theme"
import { Locale } from "../util/locale"
import { Glyph } from "./glyph"

export type TranscriptToolStatus = "pending" | "running" | "completed" | "error"

export function ToolRow(props: {
  id: string
  width: number
  status: TranscriptToolStatus
  tool: string
  name: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  duration?: string
  error?: string
  approval?: boolean
  children?: JSX.Element
  onActivate?: () => void
  ref?: (value: BoxRenderable) => void
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  let root: BoxRenderable | undefined
  const denied = createMemo(() => isDeniedToolError(props.error))
  const state = createMemo(() => toolState(props.status, denied()))
  const summary = createMemo(() => toolSummary({ tool: props.tool, input: props.input, metadata: props.metadata }))
  const details = createMemo(() => toolDetails({ tool: props.tool, input: props.input, metadata: props.metadata }))
  const expandable = createMemo(() => Boolean(props.error || details().length || "children" in props))
  const nameColor = createMemo(() => (denied() ? theme.error : props.approval ? theme.accent : theme.secondary))
  const toggleDetails = () => {
    if (expandable()) setExpanded((value) => !value)
  }
  const activate = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    if (!props.onActivate) {
      toggleDetails()
      return
    }
    if (expandable()) setExpanded(true)
    props.onActivate()
  }
  const key = (event: KeyEvent) => {
    if (event.ctrl && event.name === "e") {
      event.preventDefault()
      event.stopPropagation()
      toggleDetails()
      return
    }
    if (event.name !== "return") return
    event.preventDefault()
    event.stopPropagation()
    activate()
  }

  return (
    <box
      id={props.id}
      paddingLeft={3}
      flexShrink={0}
      focusable={expandable() || Boolean(props.onActivate)}
      backgroundColor={focused() ? theme.backgroundMenu : undefined}
      ref={(value) => {
        root = value
        props.ref?.(value)
      }}
      on:focused={() => setFocused(true)}
      on:blurred={() => setFocused(false)}
      onKeyDown={key}
      onMouseUp={() => {
        root?.focus()
        activate()
      }}
    >
      <box flexDirection="row" gap={1}>
        <Glyph name={props.approval ? "needs-you" : (state()?.glyph ?? "tool-group")} />
        <text
          fg={nameColor()}
          attributes={denied() ? TextAttributes.STRIKETHROUGH : TextAttributes.BOLD}
          wrapMode="none"
        >
          {props.name}
        </text>
        <text fg={theme.textMuted} flexGrow={1} wrapMode="none">
          {props.approval
            ? "approval required"
            : summary()
              ? Locale.truncate(summary()!, Math.max(1, props.width - props.name.length - 12))
              : ""}
        </text>
        <Show when={props.duration}>{(value) => <text fg={theme.textFaint}>{value()}</text>}</Show>
        <Show when={expandable()}>
          <text fg={props.error ? theme.error : theme.textMuted}>ctrl+e {expanded() ? "▾" : "▸"}</text>
        </Show>
      </box>
      <Show when={props.error}>
        <text fg={theme.error} paddingLeft={2} wrapMode="none">
          ↳ {toolErrorSummary(props.error)}
        </text>
      </Show>
      <Show when={expanded()}>
        <box paddingLeft={2} backgroundColor={theme.backgroundPanel}>
          <For each={details()}>
            {(detail) => (
              <text wrapMode="none">
                <span style={{ fg: theme.textFaint }}>{detail.key}: </span>
                <span style={{ fg: theme.textMuted }}>
                  {Locale.truncate(detail.value, Math.max(1, props.width - detail.key.length - 8))}
                </span>
              </text>
            )}
          </For>
          <Show when={props.error}>{(error) => <text fg={theme.error}>↳ {error()}</text>}</Show>
          {props.children}
        </box>
      </Show>
    </box>
  )
}

export function ToolGroupHeader(props: {
  name: string
  items: ReadonlyArray<{ status: unknown; error?: string; approval?: boolean }>
  collapsed?: boolean
  onCollapsedChange?: (value: boolean) => void
}) {
  const { theme } = useTheme()
  const aggregate = createMemo(() => toolAggregate(props.items))
  const [focused, setFocused] = createSignal(false)
  let root: BoxRenderable | undefined
  const color = createMemo(() => {
    if (aggregate().tone === "red") return theme.error
    if (aggregate().tone === "amber") return theme.warning
    if (aggregate().tone === "green") return theme.success
    if (aggregate().tone === "purple") return theme.accent
    return theme.textMuted
  })
  const toggle = () => props.onCollapsedChange?.(!props.collapsed)
  const key = (event: KeyEvent) => {
    if ((event.ctrl && event.name === "e") || event.name === "return") {
      event.preventDefault()
      event.stopPropagation()
      toggle()
    }
  }
  return (
    <box
      paddingLeft={3}
      marginTop={1}
      flexDirection="row"
      gap={1}
      focusable={Boolean(props.onCollapsedChange)}
      backgroundColor={focused() ? theme.backgroundMenu : undefined}
      ref={(value) => (root = value)}
      on:focused={() => setFocused(true)}
      on:blurred={() => setFocused(false)}
      onKeyDown={key}
      onMouseUp={() => {
        root?.focus()
        toggle()
      }}
    >
      <Glyph name="tool-group" />
      <text fg={theme.secondary} attributes={TextAttributes.BOLD}>
        {props.name}
      </text>
      <text fg={theme.textMuted} flexGrow={1}>
        · {props.items.length} tool call{props.items.length === 1 ? "" : "s"}
      </text>
      <text fg={color()}>
        {aggregate().glyph === "done"
          ? "✓"
          : aggregate().glyph === "running"
            ? "◐"
            : aggregate().glyph === "failed"
              ? "✕"
              : aggregate().glyph === "needs-you"
                ? "▲"
                : "○"}{" "}
        {aggregate().label}
      </text>
      <text fg={theme.textMuted}>{props.collapsed ? "▸" : "▾"}</text>
    </box>
  )
}

export function toolRowDuration(state: unknown, now = Date.now()) {
  if (!state || typeof state !== "object" || Array.isArray(state) || !("time" in state)) return
  const time = state.time
  if (!time || typeof time !== "object" || Array.isArray(time) || !("start" in time)) return
  if (typeof time.start !== "number") return
  const end = "end" in time && typeof time.end === "number" ? time.end : now
  return Locale.duration(Math.max(0, end - time.start))
}

export function v2ToolRowDuration(time: { created: number; ran?: number; completed?: number }, now = Date.now()) {
  return Locale.duration(Math.max(0, (time.completed ?? now) - (time.ran ?? time.created)))
}
