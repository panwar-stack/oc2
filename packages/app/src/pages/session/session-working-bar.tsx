import { KeyHintV2 } from "@oc2-ai/ui/v2/key-hint-v2"
import { StatusGlyph } from "@oc2-ai/ui/v2/status-glyph"
import { Show, onCleanup, onMount } from "solid-js"

export function SessionWorkingBar(props: {
  working: boolean
  blocked: boolean
  team: boolean
  task?: string
  elapsed?: string
  queued?: number
  onInterrupt?: () => void
}) {
  onMount(() => {
    const interrupt = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || !props.working || !props.onInterrupt) return
      event.preventDefault()
      props.onInterrupt()
    }
    document.addEventListener("keydown", interrupt)
    onCleanup(() => document.removeEventListener("keydown", interrupt))
  })
  const visible = () => props.working || props.blocked
  const label = () => (props.blocked ? "Waiting on you" : props.team ? "Team working" : "Working")
  const summary = () => (props.blocked ? "answer the decision above" : props.task || "processing the current turn")

  return (
    <Show when={visible()}>
      <div
        data-component="session-working-bar"
        data-variant={props.blocked ? "needs-you" : "working"}
        role="status"
        aria-live="polite"
        class="h-8 mb-2 px-3 flex items-center gap-2 overflow-hidden rounded-[var(--v2-radius-group)] border font-mono text-[length:var(--v2-font-size-meta)]"
        style={{
          color: props.blocked ? "var(--v2-state-fg-decision)" : "var(--v2-state-fg-thinking)",
          background: props.blocked ? "var(--v2-state-bg-decision)" : "var(--v2-state-bg-thinking)",
          "border-color": props.blocked ? "var(--v2-state-border-decision)" : "var(--v2-state-border-thinking)",
        }}
      >
        <StatusGlyph name={props.blocked ? "needs-you" : "running"} label={label()} />
        <strong class="shrink-0">{label()}</strong>
        <span aria-hidden="true">·</span>
        <span class="min-w-0 flex-1 truncate" title={summary()}>
          {summary()}
        </span>
        <Show when={props.queued && props.queued! > 0}>
          <span class="shrink-0 text-[var(--v2-text-text-faint)]">· {props.queued} queued</span>
        </Show>
        <Show when={!props.blocked && props.elapsed}>
          {(elapsed) => (
            <span class="shrink-0 tabular-nums text-[var(--v2-text-text-faint)]" aria-hidden="true">
              {elapsed()}
            </span>
          )}
        </Show>
        <Show when={!props.blocked && props.onInterrupt}>
          {(interrupt) => (
            <KeyHintV2 shortcut="esc" label="interrupt" aria-label="Interrupt active turn" onClick={interrupt()} />
          )}
        </Show>
      </div>
    </Show>
  )
}
