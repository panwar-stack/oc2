import { RGBA, TextAttributes } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import type { SessionStatus } from "@oc2-ai/sdk/v2"
import { Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogAlert } from "../ui/dialog-alert"
import { formatDuration } from "../util/format"

export type ComposerFooterPresentation = {
  state: "idle" | "working" | "queued"
  action: "send" | "steer" | "queue" | "queued"
}

export function composerFooterPresentation(input: {
  working: boolean
  activeTurn?: boolean
  delivery: "steer" | "queue"
  queued: number
  hasDraft: boolean
}): ComposerFooterPresentation {
  if (input.delivery === "queue" && input.queued > 0 && !input.hasDraft) return { state: "queued", action: "queued" }
  if (!input.working) return { state: "idle", action: "send" }
  if (input.activeTurn === false) return { state: "working", action: "send" }
  return { state: "working", action: input.delivery }
}

function fadeColor(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

type ComposerFooterProps = {
  mode: "normal" | "shell"
  leader: boolean
  status: SessionStatus
  working: boolean
  activeTurn: boolean
  teammateWorking: boolean
  delivery: "steer" | "queue"
  queued: number
  hasDraft: boolean
  interrupt: number
  interruptible: boolean
  elapsed?: string
  agent?: { label: string; color: RGBA; alpha: number }
  model?: { label: string; provider: string; alpha: number }
  variant?: { label: string; alpha: number }
  spinner: JSX.Element
  left: JSX.Element
  meta: JSX.Element
  right?: JSX.Element
  onAgentClick?: () => void
  onModelClick?: () => void
  onVariantClick?: () => void
}

export function ComposerFooter(props: ComposerFooterProps) {
  const { theme } = useTheme()
  const presentation = createMemo(() =>
    composerFooterPresentation({
      working: props.working,
      activeTurn: props.activeTurn,
      delivery: props.delivery,
      queued: props.queued,
      hasDraft: props.hasDraft,
    }),
  )

  return (
    <>
      <box
        flexDirection="row"
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        gap={1}
        justifyContent="space-between"
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" gap={1}>
          <Show when={props.agent} fallback={<box height={1} />}>
            {(agent) => (
              <>
                <box onMouseUp={() => props.onAgentClick?.()}>
                  <text bg={theme.backgroundMenu} fg={fadeColor(agent().color, agent().alpha)} wrapMode="none">
                    {` ${props.mode === "shell" ? "Shell" : agent().label} `}
                  </text>
                </box>
                <Show when={props.mode === "normal" && props.model}>
                  {(model) => (
                    <>
                      <box onMouseUp={() => props.onModelClick?.()}>
                        <text
                          bg={theme.backgroundMenu}
                          fg={fadeColor(props.leader ? theme.textMuted : theme.text, model().alpha)}
                          wrapMode="none"
                        >
                          {` ${model().label} `}
                        </text>
                      </box>
                      <text fg={fadeColor(theme.textMuted, model().alpha)} wrapMode="none">
                        {model().provider}
                      </text>
                    </>
                  )}
                </Show>
                <Show when={props.mode === "normal" && props.variant}>
                  {(variant) => (
                    <box onMouseUp={() => props.onVariantClick?.()}>
                      <text
                        bg={theme.backgroundMenu}
                        fg={fadeColor(theme.warning, variant().alpha)}
                        attributes={TextAttributes.BOLD}
                        wrapMode="none"
                      >
                        {` ${variant().label} `}
                      </text>
                    </box>
                  )}
                </Show>
              </>
            )}
          </Show>
        </box>
        <Show when={props.right}>
          <box flexDirection="row" gap={1} alignItems="center">
            {props.right}
          </box>
        </Show>
      </box>
      <box width="100%" flexDirection="row" justifyContent="space-between">
        <Switch>
          <Match when={presentation().state === "queued"}>
            <box paddingLeft={1} flexDirection="row" gap={1}>
              <text fg={theme.text}>✓ queued</text>
              <text fg={theme.textMuted}>· sends next</text>
            </box>
          </Match>
          <Match when={presentation().state === "working"}>
            <box flexDirection="row" gap={1} flexGrow={1}>
              {props.spinner}
              <box flexDirection="row" gap={1} flexShrink={0}>
                <text fg={theme.warning} wrapMode="none">
                  {props.teammateWorking && props.status.type === "idle" ? "team working" : "working"}
                </text>
                <Show when={props.elapsed}>
                  {(elapsed) => (
                    <text fg={theme.textMuted} wrapMode="none">
                      · {elapsed()}
                    </text>
                  )}
                </Show>
                <Show when={props.hasDraft}>
                  <text fg={theme.textMuted} wrapMode="none">
                    · enter {presentation().action === "queue" ? "queues" : "steers"}
                  </text>
                </Show>
                <RetryStatus status={props.status} />
              </box>
              <Show when={props.interruptible && props.status.type !== "idle"}>
                <text fg={props.interrupt > 0 ? theme.primary : theme.text} wrapMode="none">
                  esc{" "}
                  <span style={{ fg: props.interrupt > 0 ? theme.primary : theme.textMuted }}>
                    {props.interrupt > 0 ? "again to interrupt" : "interrupt"}
                  </span>
                </text>
              </Show>
            </box>
          </Match>
          <Match when={true}>{props.left}</Match>
        </Switch>
        <box gap={2} flexDirection="row">
          <Show when={props.status.type !== "retry"}>{props.meta}</Show>
          <text
            bg={presentation().action === "send" ? theme.primary : theme.backgroundMenu}
            fg={presentation().action === "send" ? theme.selectedListItemText : theme.textMuted}
            wrapMode="none"
          >
            {` ${
              props.mode === "shell"
                ? "Run ⏎"
                : presentation().action === "queued"
                  ? "Queued ✓"
                  : presentation().action === "queue"
                    ? "Queue ⏎"
                    : presentation().action === "steer"
                      ? "Steer ⏎"
                      : "Send ⏎"
            } `}
          </text>
        </box>
      </box>
    </>
  )
}

function RetryStatus(props: { status: SessionStatus }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const retry = createMemo(() => (props.status.type === "retry" ? props.status : undefined))
  const message = createMemo(() => {
    const value = retry()?.message
    if (!value) return
    if (value.includes("exceeded your current quota") && value.includes("gemini"))
      return "gemini is way too hot right now"
    if (value.length > 80) return value.slice(0, 80) + "..."
    return value
  })
  const [seconds, setSeconds] = createSignal(0)

  onMount(() => {
    const timer = setInterval(() => {
      const next = retry()?.next
      if (next) setSeconds(Math.round((next - Date.now()) / 1000))
    }, 1000)
    onCleanup(() => clearInterval(timer))
  })

  const retryText = () => {
    const value = retry()
    if (!value) return ""
    const truncated = value.message.length > 120
    const duration = formatDuration(seconds())
    return `${message()}${truncated ? " (click to expand)" : ""} [retrying ${duration ? `in ${duration} ` : ""}attempt #${value.attempt}]`
  }

  return (
    <Show when={retry()}>
      <box
        onMouseUp={() => {
          const value = retry()
          if (!value || value.message.length <= 120) return
          void DialogAlert.show(dialog, "Retry Error", value.message)
        }}
      >
        <text fg={theme.error}>{retryText()}</text>
      </box>
    </Show>
  )
}
