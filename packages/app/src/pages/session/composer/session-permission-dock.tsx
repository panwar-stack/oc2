import { For, Show, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest } from "@oc2-ai/sdk/v2"
import { DockPrompt } from "@oc2-ai/ui/dock-prompt"
import { KeyHintV2 } from "@oc2-ai/ui/v2/key-hint-v2"
import { PillV2 } from "@oc2-ai/ui/v2/pill-v2"
import { StatusGlyph } from "@oc2-ai/ui/v2/status-glyph"
import { useLanguage } from "@/context/language"
import { decisionKey } from "@/pages/session/composer/session-decision"

type PermissionDecision = "once" | "always" | "reject"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: PermissionDecision) => Promise<boolean> | undefined
  onResolved?: (summary: { variant: "resolved" | "cancelled"; text: string }) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    focused: 0,
    selected: 0,
  })
  let options: HTMLButtonElement[] = []

  const choices = createMemo(() => [
    {
      value: "once" as const,
      label: language.t("ui.permission.allowOnce"),
      description: language.t("session.decision.allowOnceDescription"),
    },
    {
      value: "always" as const,
      label: language.t("ui.permission.allowAlways"),
      description: language.t("session.decision.allowAlwaysDescription"),
    },
    {
      value: "reject" as const,
      label: language.t("ui.permission.deny"),
      description: language.t("session.decision.denyDescription"),
    },
  ])
  const selected = () => choices()[store.selected]!
  const labelID = () => `decision-permission-${props.request.id}`
  const statusID = () => `decision-permission-status-${props.request.id}`

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  const focus = (index: number) => {
    const next = Math.max(0, Math.min(choices().length - 1, index))
    setStore("focused", next)
    options[next]?.focus()
  }

  const decide = (decision: PermissionDecision = selected().value) => {
    if (props.responding) return
    const result = props.onDecide(decision)
    if (!result) return
    void result.then((resolved) => {
      if (!resolved) return
      props.onResolved?.({
        variant: decision === "reject" ? "cancelled" : "resolved",
        text:
          decision === "reject"
            ? language.t("session.decision.permissionDenied")
            : language.t("session.decision.permissionResolved", { decision: selected().label }),
      })
    })
  }

  const nav = (event: KeyboardEvent) => {
    if (event.defaultPrevented || props.responding) return
    const action = decisionKey(event.key, choices().length)
    if (action?.type === "cancel") {
      event.preventDefault()
      decide("reject")
      return
    }
    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-slot="permission-options"]') : undefined
    if (!(target instanceof HTMLElement)) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (!action) return
    event.preventDefault()
    if (action.type === "move") {
      focus(store.focused + action.step)
      return
    }
    if (action.type === "index") {
      focus(action.index)
      return
    }
    if (action.type === "pick") {
      setStore("selected", action.index)
      focus(action.index)
      return
    }
    if (action.type === "toggle") {
      setStore("selected", store.focused)
      return
    }
    if (action.type === "confirm") decide()
  }

  onMount(() => queueMicrotask(() => focus(store.selected)))

  return (
    <DockPrompt
      kind="permission"
      onKeyDown={nav}
      header={
        <div data-slot="decision-head-main">
          <StatusGlyph name="needs-you" size="normal" />
          <div id={labelID()} data-slot="permission-header-title">
            {language.t("notification.permission.title")}
          </div>
          <PillV2 variant="purple" size="small">
            {language.t("session.decision.permissionGate")}
          </PillV2>
          <div id={statusID()} data-slot="decision-selection-count" role="status" aria-live="polite">
            1 of {choices().length} selected
          </div>
        </div>
      }
      footer={
        <>
          <div data-slot="decision-key-hints">
            <KeyHintV2 shortcut="↑↓" label={language.t("session.decision.move")} decorative />
            <KeyHintV2 shortcut="space" label={language.t("session.decision.select")} decorative />
            <KeyHintV2
              shortcut="esc"
              label={language.t("session.decision.cancel")}
              disabled={props.responding}
              onClick={() => decide("reject")}
              aria-keyshortcuts="Escape"
            />
          </div>
          <button
            type="button"
            data-slot="decision-confirm"
            data-danger={selected().value === "reject"}
            disabled={props.responding}
            onClick={() => decide()}
            aria-keyshortcuts="Enter"
          >
            <Show when={props.responding}>
              <StatusGlyph name="running" size="small" />
            </Show>
            <span>{props.responding ? language.t("session.decision.submitting") : selected().label}</span>
            <Show when={!props.responding}>
              <StatusGlyph name="enter" size="small" />
            </Show>
          </button>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-hint">{toolDescription()}</div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-patterns">
          <For each={props.request.patterns}>
            {(pattern) => <code class="text-12-regular text-v2-text-text-base break-all">{pattern}</code>}
          </For>
        </div>
      </Show>

      <div data-slot="permission-options" role="radiogroup" aria-labelledby={labelID()} aria-describedby={statusID()}>
        <For each={choices()}>
          {(choice, index) => (
            <button
              type="button"
              ref={(element) => (options[index()] = element)}
              data-slot="permission-option"
              data-picked={store.selected === index()}
              role="radio"
              aria-checked={store.selected === index()}
              disabled={props.responding}
              onFocus={() => setStore("focused", index())}
              onClick={() => setStore("selected", index())}
            >
              <span data-slot="permission-option-mark" aria-hidden="true">
                {store.selected === index() ? "●" : "○"}
              </span>
              <span data-slot="permission-option-main">
                <span data-slot="option-label">{choice.label}</span>
                <span data-slot="option-description">{choice.description}</span>
              </span>
            </button>
          )}
        </For>
      </div>
    </DockPrompt>
  )
}
