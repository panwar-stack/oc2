import type { BoxRenderable, KeyEvent, SyntaxStyle } from "@opentui/core"
import { RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { Show, createMemo, createSignal } from "solid-js"
import { useTheme } from "../context/theme"
import { tint } from "../theme"
import { Glyph } from "./glyph"
import { KeyHint } from "./key-hint"

export function ThinkingRow(props: {
  id: string
  title?: string | null
  trace?: string
  running?: boolean
  duration?: string
  syntaxStyle: SyntaxStyle
  conceal?: boolean
  expanded?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [internal, setInternal] = createSignal(props.expanded ?? false)
  const [focused, setFocused] = createSignal(false)
  let root: BoxRenderable | undefined
  const interactive = () => props.expanded === undefined
  const open = createMemo(() => props.expanded ?? internal())
  const toggle = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    if (props.expanded !== undefined) return
    setInternal((value) => !value)
  }
  const traceColor = createMemo(() =>
    RGBA.fromValues(theme.textMuted.r, theme.textMuted.g, theme.textMuted.b, theme.thinkingOpacity),
  )
  const key = (event: KeyEvent) => {
    if ((event.ctrl && event.name === "e") || event.name === "return") {
      event.preventDefault()
      event.stopPropagation()
      toggle()
    }
  }

  return (
    <box
      id={props.id}
      marginTop={1}
      marginLeft={3}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
      focusable={interactive()}
      backgroundColor={focused() ? theme.backgroundMenu : tint(theme.background, theme.warning, 0.06)}
      ref={(value) => (root = value)}
      on:focused={() => setFocused(true)}
      on:blurred={() => setFocused(false)}
      onKeyDown={key}
      onMouseUp={() => {
        root?.focus()
        toggle()
      }}
    >
      <box flexDirection="row" gap={1}>
        <Show when={props.running} fallback={<text fg={theme.warning}>◐</text>}>
          <Glyph name="running" />
        </Show>
        <text fg={theme.warning} attributes={1}>
          Thought
        </text>
        <text fg={theme.textMuted} flexGrow={1} wrapMode="none">
          {props.title ? `— ${props.title}` : ""}
        </text>
        <Show when={props.duration}>{(value) => <text fg={theme.textFaint}>{value()}</text>}</Show>
        <Show when={interactive()}>
          <KeyHint shortcut="ctrl+e" label={open() ? "collapse" : "expand"} />
        </Show>
      </box>
      <Show when={open() && props.trace}>
        <box paddingLeft={2} paddingTop={1}>
          <code
            filetype="markdown"
            drawUnstyledText={false}
            streaming={props.running}
            syntaxStyle={props.syntaxStyle}
            content={props.trace}
            conceal={props.conceal ?? true}
            fg={traceColor()}
          />
        </box>
      </Show>
    </box>
  )
}
