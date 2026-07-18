import { TextAttributes, type RGBA } from "@opentui/core"
import { For, Show, createMemo, createSignal } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { tint } from "../../theme"

const CONTENT_WIDTH = 28

export function SidebarSectionHeader(props: { title: string; detail?: string; detailColor?: RGBA }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" justifyContent="space-between" minWidth={0}>
      <text fg={theme.text} wrapMode="none">
        <b>{props.title.toUpperCase()}</b>
      </text>
      <Show when={props.detail}>
        <text fg={props.detailColor ?? theme.textMuted} wrapMode="none">
          {props.detail}
        </text>
      </Show>
    </box>
  )
}

export function SidebarSessionSection(props: {
  title: string
  sessionID: string
  channel?: string
  onCopy?: () => void
  onRename?: () => void
}) {
  const { theme } = useTheme()
  const suffix = " copy rename"
  return (
    <box>
      <SidebarSectionHeader title="Session" detail="auto-saved" />
      <text fg={theme.text} wrapMode="none">
        <b>{Locale.truncate(props.title, CONTENT_WIDTH)}</b>
      </text>
      <box flexDirection="row" minWidth={0}>
        <text width={Math.max(1, CONTENT_WIDTH - Bun.stringWidth(suffix))} fg={theme.textMuted} wrapMode="none">
          {Locale.truncateMiddle(props.sessionID, Math.max(1, CONTENT_WIDTH - Bun.stringWidth(suffix)))}
        </text>
        <text fg={theme.primary} onMouseDown={props.onCopy}>
          {" "}
          copy
        </text>
        <text fg={theme.primary} onMouseDown={props.onRename}>
          {" "}
          rename
        </text>
      </box>
      <Show when={props.channel}>
        <text fg={theme.textFaint} wrapMode="none">
          {props.channel}
        </text>
      </Show>
    </box>
  )
}

export function contextGaugeState(tokens: number, limit?: number) {
  if (!limit || limit <= 0) return { level: "normal" as const, label: `${Locale.number(tokens)} tokens` }
  const percent = Math.min(100, Math.max(0, Math.floor((tokens / limit) * 100)))
  const cells = Math.round((percent / 100) * 8)
  const level = percent >= 90 ? ("danger" as const) : percent >= 70 ? ("warning" as const) : ("normal" as const)
  return {
    level,
    percent,
    gauge: `${"▰".repeat(cells)}${"▱".repeat(8 - cells)}`,
    action: level === "danger" ? "fork or new session" : level === "warning" ? "compact suggested" : undefined,
    label: `${Locale.number(tokens)} / ${Locale.number(limit)} tok`,
  }
}

export function SidebarContextSection(props: { tokens?: number; limit?: number; cost?: number }) {
  const { theme } = useTheme()
  const state = createMemo(() =>
    props.tokens === undefined ? undefined : contextGaugeState(props.tokens, props.limit),
  )
  const color = () =>
    state()?.level === "danger" ? theme.error : state()?.level === "warning" ? theme.warning : theme.success
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
  return (
    <Show when={state()}>
      {(value) => (
        <box>
          <SidebarSectionHeader
            title="Context"
            detail={value().percent === undefined ? undefined : `${value().percent}%`}
            detailColor={color()}
          />
          <Show when={value().gauge}>
            {(gauge) => (
              <text fg={color()} wrapMode="none">
                {gauge()} <span style={{ fg: theme.textMuted }}>{value().label}</span>
              </text>
            )}
          </Show>
          <Show when={!value().gauge}>
            <text fg={theme.textMuted} wrapMode="none">
              {value().label}
            </text>
          </Show>
          <Show when={props.cost !== undefined}>
            <text fg={theme.textFaint} wrapMode="none">
              {money.format(props.cost!)} spent
            </text>
          </Show>
          <Show when={value().action}>
            {(action) => (
              <text fg={color()} wrapMode="none">
                {value().level === "danger" ? "✕" : "▲"} {action()}
              </text>
            )}
          </Show>
        </box>
      )}
    </Show>
  )
}

export function orderSidebarTodos(items: ReadonlyArray<{ content: string; status: string }>) {
  const rank = (status: string) =>
    status === "in_progress" ? 0 : status === "pending" ? 1 : status === "completed" ? 2 : 3
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => rank(left.item.status) - rank(right.item.status) || left.index - right.index)
}

export function SidebarTodoSection(props: {
  items: ReadonlyArray<{ content: string; status: string }>
  limit?: number
}) {
  const { theme } = useTheme()
  const [expanded, setExpanded] = createSignal(false)
  const limit = () => props.limit ?? 5
  const ordered = createMemo(() => orderSidebarTodos(props.items))
  const completed = createMemo(() => props.items.filter((item) => item.status === "completed").length)
  const gauge = createMemo(() => {
    const cells = props.items.length ? Math.round((completed() / props.items.length) * 8) : 0
    return `${"▰".repeat(cells)}${"▱".repeat(8 - cells)}`
  })
  return (
    <Show when={props.items.length > 0}>
      <box>
        <SidebarSectionHeader title="Todo" detail={`${completed()} / ${props.items.length}`} />
        <text fg={theme.success} wrapMode="none">
          {gauge()}
        </text>
        <For each={expanded() ? ordered() : ordered().slice(0, limit())}>
          {({ item }) => {
            const terminal = item.status === "completed" || item.status === "cancelled"
            const glyph =
              item.status === "in_progress"
                ? "◐"
                : item.status === "completed"
                  ? "✓"
                  : item.status === "cancelled"
                    ? "✕"
                    : "○"
            const color =
              item.status === "in_progress"
                ? theme.warning
                : item.status === "completed"
                  ? theme.success
                  : item.status === "cancelled"
                    ? theme.error
                    : theme.textMuted
            return (
              <box
                flexDirection="row"
                gap={1}
                minWidth={0}
                backgroundColor={
                  item.status === "in_progress" ? tint(theme.background, theme.warning, 0.06) : undefined
                }
              >
                <text flexShrink={0} fg={color}>
                  {glyph}
                </text>
                <text
                  fg={terminal ? theme.textFaint : color}
                  wrapMode="none"
                  attributes={terminal ? TextAttributes.STRIKETHROUGH : undefined}
                >
                  {Locale.truncate(item.content, CONTENT_WIDTH - 2)}
                </text>
              </box>
            )
          }}
        </For>
        <Show when={props.items.length > limit()}>
          <text fg={theme.primary} wrapMode="none" onMouseDown={() => setExpanded((value) => !value)}>
            {expanded() ? "▴ collapse" : `+ ${props.items.length - limit()} more · expand ▾`}
          </text>
        </Show>
      </box>
    </Show>
  )
}
