import type { SessionStatus } from "@oc2-ai/sdk/v2"
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { Glyph } from "../../component/glyph"

export type SessionContextUsage = { tokens: number; limit?: number }

export type SessionActivityState =
  | { type: "waiting"; interruptible: false; who?: string }
  | { type: "compacting"; interruptible: true; started?: number }
  | { type: "retry"; interruptible: true; retry: Extract<SessionStatus, { type: "retry" }> }
  | { type: "session"; interruptible: true; who?: string; task?: string; started?: number }
  | { type: "team"; interruptible: false; who: string; task?: string; started?: number }

export function sessionContextHealth(input: SessionContextUsage) {
  if (!input.limit || input.limit <= 0) return { level: "normal" as const, label: `ctx ${Locale.number(input.tokens)}` }
  const percent = Math.min(100, Math.max(0, Math.floor((input.tokens / input.limit) * 100)))
  const level = percent >= 90 ? ("danger" as const) : percent >= 70 ? ("warning" as const) : ("normal" as const)
  const cells = Math.round((percent / 100) * 8)
  return {
    level,
    percent,
    gauge: `${"▰".repeat(cells)}${"▱".repeat(8 - cells)}`,
    action: level === "danger" ? "fork/new" : level === "warning" ? "compact" : undefined,
    label: `ctx ${Locale.number(input.tokens)} ${"▰".repeat(cells)}${"▱".repeat(8 - cells)} ${percent}%`,
  }
}

export function sessionActivity(input: {
  waiting: boolean
  compacting?: boolean
  status?: SessionStatus
  teammate?: { name: string; task?: string; started?: number }
  task?: string
  started?: number
}): SessionActivityState | undefined {
  if (input.waiting) return { type: "waiting", interruptible: false }
  if (input.compacting) return { type: "compacting", interruptible: true, started: input.started }
  if (input.status?.type === "retry") return { type: "retry", interruptible: true, retry: input.status }
  if (input.status?.type === "busy")
    return { type: "session", interruptible: true, task: input.task, started: input.started }
  if (input.teammate)
    return {
      type: "team",
      interruptible: false,
      who: input.teammate.name,
      task: input.teammate.task,
      started: input.teammate.started,
    }
}

export function sessionActivityLabel(activity: SessionActivityState, now = Date.now()) {
  if (activity.type === "waiting") return "Waiting on you · answer above"
  if (activity.type === "compacting") return "Compacting session"
  if (activity.type === "retry") {
    const remaining = Math.max(0, activity.retry.next - now)
    return `Retrying · attempt ${activity.retry.attempt} · ${Locale.duration(remaining)} · ${activity.retry.message}`
  }
  const label = activity.type === "team" ? `Team working · ${activity.who}` : "Working"
  return [label, activity.task].filter(Boolean).join(" · ")
}

export function SessionWorkingLine(props: {
  width: number
  activity: SessionActivityState
  interruptShortcut?: string
}) {
  const { theme } = useTheme()
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const label = createMemo(() => sessionActivityLabel(props.activity, now()))
  const started = () => ("started" in props.activity ? props.activity.started : undefined)
  const elapsed = createMemo(() => (started() ? Locale.duration(Math.max(0, now() - started()!)) : undefined))
  const hint = createMemo(() =>
    props.activity.interruptible && props.interruptShortcut ? `${props.interruptShortcut}×2 interrupt` : undefined,
  )
  const right = createMemo(() => [elapsed(), hint()].filter(Boolean).join(" · "))
  const rightWidth = createMemo(() => Math.min(Bun.stringWidth(right()), Math.max(0, props.width - 8)))
  const labelWidth = createMemo(() => Math.max(0, props.width - rightWidth() - 6))
  const color = () => (props.activity.type === "waiting" ? theme.accent : theme.warning)

  return (
    <box
      id="session-working-line"
      height={1}
      minWidth={0}
      flexDirection="row"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundElement}
    >
      <box width={2} flexShrink={0}>
        <Glyph name={props.activity.type === "waiting" ? "needs-you" : "running"} color={color()} />
      </box>
      <text width={labelWidth()} wrapMode="none" fg={color()}>
        <b>{Locale.truncate(label(), labelWidth())}</b>
      </text>
      <box flexGrow={1} minWidth={1} />
      <Show when={right()}>
        {(value) => (
          <text width={rightWidth()} wrapMode="none" flexShrink={0} fg={theme.textFaint}>
            {Locale.truncateLeft(value(), rightWidth())}
          </text>
        )}
      </Show>
    </box>
  )
}

export function SessionStatusLine(props: {
  width: number
  agent: string
  title: string
  workingAgents: number
  context?: SessionContextUsage
  paletteShortcut?: string
  waiting: boolean
  lspCount: number
  mcpCount: number
  mcpIssueCount: number
}) {
  const { theme } = useTheme()
  const health = createMemo(() => (props.context ? sessionContextHealth(props.context) : undefined))
  const right = createMemo(() => {
    if (props.waiting) return "▲ waiting on you"
    return [
      props.workingAgents ? `◐ ${props.workingAgents} agents` : undefined,
      health()?.label,
      `${props.lspCount} LSP`,
      props.mcpCount ? `${props.mcpCount} MCP` : undefined,
      props.mcpIssueCount ? `✕ ${props.mcpIssueCount} MCP` : undefined,
      props.paletteShortcut,
    ]
      .filter(Boolean)
      .join(" · ")
  })
  const rightWidth = createMemo(() => Math.min(Bun.stringWidth(right()), Math.max(0, props.width - 8)))
  const leftWidth = createMemo(() => Math.max(0, props.width - rightWidth() - 3))
  const agentWidth = createMemo(() =>
    Math.min(Bun.stringWidth(props.agent), Math.max(0, Math.floor(leftWidth() * 0.35))),
  )
  const titleWidth = createMemo(() => Math.max(0, leftWidth() - agentWidth() - 3))
  const contextColor = () =>
    health()?.level === "danger" ? theme.error : health()?.level === "warning" ? theme.warning : theme.success

  return (
    <box
      id="session-status-line"
      height={1}
      minWidth={0}
      flexDirection="row"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundPanel}
    >
      <text width={agentWidth()} wrapMode="none" fg={theme.textMuted}>
        <b>{Locale.truncate(props.agent, agentWidth())}</b>
      </text>
      <text width={titleWidth() + 3} wrapMode="none" fg={theme.textFaint}>
        {" "}
        · {Locale.truncate(props.title, titleWidth())}
      </text>
      <box flexGrow={1} minWidth={1} />
      <Show when={right()}>
        <text width={rightWidth()} wrapMode="none" flexShrink={0} fg={theme.textMuted}>
          <Show
            when={props.waiting}
            fallback={
              <>
                <Show when={props.workingAgents > 0}>
                  <span style={{ fg: theme.warning }}>◐ {props.workingAgents} agents · </span>
                </Show>
                <Show when={health()}>{(value) => <span style={{ fg: contextColor() }}>{value().label} · </span>}</Show>
                <span style={{ fg: theme.textMuted }}>{props.lspCount} LSP</span>
                <Show when={props.mcpCount}>
                  <span style={{ fg: theme.textMuted }}> · {props.mcpCount} MCP</span>
                </Show>
                <Show when={props.mcpIssueCount}>
                  <span style={{ fg: theme.error }}> · ✕ {props.mcpIssueCount} MCP</span>
                </Show>
                <Show when={props.paletteShortcut}> · {props.paletteShortcut}</Show>
              </>
            }
          >
            <span style={{ fg: theme.accent }}>▲ waiting on you</span>
          </Show>
        </text>
      </Show>
    </box>
  )
}
