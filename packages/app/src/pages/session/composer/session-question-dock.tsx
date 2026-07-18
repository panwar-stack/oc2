import { For, Show, createMemo, onCleanup, onMount, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { DockPrompt } from "@oc2-ai/ui/dock-prompt"
import { Icon } from "@oc2-ai/ui/icon"
import { KeyHintV2 } from "@oc2-ai/ui/v2/key-hint-v2"
import { PillV2 } from "@oc2-ai/ui/v2/pill-v2"
import { StatusGlyph } from "@oc2-ai/ui/v2/status-glyph"
import { showToast } from "@/utils/toast"
import type { QuestionAnswer, QuestionRequest } from "@oc2-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { ScopedKey } from "@/utils/server-scope"
import {
  decisionKey,
  questionConfirmAction,
  questionDecisionPresentation,
} from "@/pages/session/composer/session-decision"

const cache = new Map<string, { tab: number; answers: QuestionAnswer[]; custom: string[]; customOn: boolean[] }>()

function Mark(props: { multi: boolean; picked: boolean; onClick?: (event: MouseEvent) => void }) {
  return (
    <span data-slot="question-option-check" aria-hidden="true" onClick={props.onClick}>
      <span data-slot="question-option-box" data-type={props.multi ? "checkbox" : "radio"} data-picked={props.picked}>
        <Show when={props.multi} fallback={<span data-slot="question-option-radio-dot" />}>
          <Icon name="check-small" size="small" />
        </Show>
      </span>
    </span>
  )
}

function Option(props: {
  multi: boolean
  picked: boolean
  index: number
  label: string
  description?: string
  disabled: boolean
  ref?: (el: HTMLButtonElement) => void
  onFocus?: VoidFunction
  onClick: VoidFunction
}) {
  return (
    <button
      type="button"
      ref={props.ref}
      data-slot="question-option"
      data-picked={props.picked}
      data-option-index={props.index + 1}
      role={props.multi ? "checkbox" : "radio"}
      aria-checked={props.picked}
      disabled={props.disabled}
      onFocus={props.onFocus}
      onClick={props.onClick}
    >
      <Mark multi={props.multi} picked={props.picked} />
      <span data-slot="question-option-main">
        <span data-slot="option-label">{props.label}</span>
        <Show when={props.description}>
          <span data-slot="option-description">{props.description}</span>
        </Show>
      </span>
    </button>
  )
}

export const SessionQuestionDock: Component<{
  request: QuestionRequest
  onSubmit: () => void
  onResolved?: (summary: { variant: "resolved" | "cancelled"; text: string }) => void
}> = (props) => {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const sync = useSync()
  const language = useLanguage()
  const cacheKey = ScopedKey.from(serverSDK.scope, props.request.id)

  const questions = createMemo(() => props.request.questions)
  const total = createMemo(() => questions().length)

  const cached = cache.get(cacheKey)
  const [store, setStore] = createStore({
    tab: cached?.tab ?? 0,
    answers: cached?.answers ?? ([] as QuestionAnswer[]),
    custom: cached?.custom ?? ([] as string[]),
    customOn: cached?.customOn ?? ([] as boolean[]),
    editing: false,
    focus: 0,
    phase: "waiting" as "waiting" | "submitting" | "resolved" | "cancelled",
  })

  let root: HTMLDivElement | undefined
  let customRef: HTMLButtonElement | undefined
  let optsRef: HTMLButtonElement[] = []
  let replied = false
  let focusFrame: number | undefined

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const customEnabled = createMemo(() => store.customOn[store.tab] === true)
  const customPicked = createMemo(() => customEnabled() && input().trim().length > 0)
  const multi = createMemo(() => question()?.multiple === true)
  const custom = createMemo(() => question()?.custom !== false)
  const planApproval = createMemo(() => {
    const tool = props.request.tool
    if (!tool) return false
    return sync.data.part[tool.messageID]?.some(
      (part) => part.type === "tool" && part.callID === tool.callID && part.tool === "plan_exit",
    )
  })
  const count = createMemo(() => options().length + (custom() ? 1 : 0))
  const selected = createMemo(() => store.answers[store.tab]?.length ?? 0)
  const presentation = createMemo(() =>
    questionDecisionPresentation({
      multiple: multi(),
      selected: selected(),
      total: count(),
      last: store.tab >= total() - 1,
      planApproval: planApproval(),
      planDecision: store.answers[store.tab]?.[0],
    }),
  )

  const summary = createMemo(() => {
    const n = Math.min(store.tab + 1, total())
    return language.t("session.question.progress", { current: n, total: total() })
  })

  const customLabel = () => language.t("ui.messagePart.option.typeOwnAnswer")
  const customPlaceholder = () => language.t("ui.question.custom.placeholder")
  const questionLabelID = () => `decision-question-${props.request.id}-${store.tab}`
  const selectionStatusID = () => `decision-selection-${props.request.id}-${store.tab}`

  const customUpdate = (value: string, selected: boolean = customEnabled()) => {
    const prev = input().trim()
    const next = value.trim()

    setStore("custom", store.tab, value)
    if (!selected) return

    if (multi()) {
      setStore("answers", store.tab, (current = []) => {
        const removed = prev ? current.filter((item) => item.trim() !== prev) : current
        if (!next) return removed
        if (removed.some((item) => item.trim() === next)) return removed
        return [...removed, next]
      })
      return
    }

    setStore("answers", store.tab, next ? [next] : [])
  }

  const measure = () => {
    if (!root) return

    const scroller = document.querySelector(".scroll-view__viewport")
    const head = scroller instanceof HTMLElement ? scroller.firstElementChild : undefined
    const top =
      head instanceof HTMLElement && head.classList.contains("sticky") ? head.getBoundingClientRect().bottom : 0
    if (!top) {
      root.style.removeProperty("--question-prompt-max-height")
      return
    }

    const dock = root.closest('[data-component="session-prompt-dock"]')
    if (!(dock instanceof HTMLElement)) return

    const dockBottom = dock.getBoundingClientRect().bottom
    const below = Math.max(0, dockBottom - root.getBoundingClientRect().bottom)
    const gap = 8
    const max = Math.max(240, Math.floor(dockBottom - top - gap - below))
    root.style.setProperty("--question-prompt-max-height", `${max}px`)
  }

  const clamp = (i: number) => Math.max(0, Math.min(count() - 1, i))

  const pickFocus = (tab: number = store.tab) => {
    const list = questions()[tab]?.options ?? []
    if (store.customOn[tab] === true) return list.length
    return Math.max(
      0,
      list.findIndex((item) => store.answers[tab]?.includes(item.label) ?? false),
    )
  }

  const focus = (i: number) => {
    const next = clamp(i)
    setStore("focus", next)
    if (store.editing) return
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      const el = next === options().length ? customRef : optsRef[next]
      el?.focus()
    })
  }

  onMount(() => {
    let raf: number | undefined
    const update = () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = undefined
        measure()
      })
    }

    update()

    makeEventListener(window, "resize", update)

    const dock = root?.closest('[data-component="session-prompt-dock"]')
    const scroller = document.querySelector(".scroll-view__viewport")
    createResizeObserver([dock, scroller], update)

    onCleanup(() => {
      if (raf !== undefined) cancelAnimationFrame(raf)
    })

    focus(pickFocus())
  })

  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    if (replied) return
    cache.set(cacheKey, {
      tab: store.tab,
      answers: store.answers.map((a) => (a ? [...a] : [])),
      custom: store.custom.map((s) => s ?? ""),
      customOn: store.customOn.map((b) => b ?? false),
    })
  })

  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    showToast({ variant: "error", title: language.t("common.requestFailed"), description: message })
  }

  const replyMutation = useMutation(() => ({
    mutationFn: (answers: QuestionAnswer[]) => sdk.client.question.reply({ requestID: props.request.id, answers }),
    onMutate: () => {
      props.onSubmit()
    },
    onSuccess: () => {
      replied = true
      cache.delete(cacheKey)
      setStore("phase", "resolved")
      props.onResolved?.({
        variant: "resolved",
        text: language.t("session.decision.questionResolved", { count: answerCount() }),
      })
    },
    onError: (err) => {
      setStore("phase", "waiting")
      fail(err)
    },
  }))

  const rejectMutation = useMutation(() => ({
    mutationFn: () => sdk.client.question.reject({ requestID: props.request.id }),
    onMutate: () => {
      props.onSubmit()
    },
    onSuccess: () => {
      replied = true
      cache.delete(cacheKey)
      setStore("phase", "cancelled")
      props.onResolved?.({ variant: "cancelled", text: language.t("session.decision.questionCancelled") })
    },
    onError: (err) => {
      setStore("phase", "waiting")
      fail(err)
    },
  }))

  const sending = createMemo(() => replyMutation.isPending || rejectMutation.isPending)

  const reply = (answers: QuestionAnswer[]) => {
    if (sending()) return
    setStore("phase", "submitting")
    replyMutation.mutate(answers)
  }

  const reject = () => {
    if (sending()) return
    setStore("phase", "submitting")
    rejectMutation.mutate()
  }

  const submit = () => reply(questions().map((_, i) => store.answers[i] ?? []))
  const answerCount = () => store.answers.reduce((sum, answers) => sum + (answers?.length ?? 0), 0)

  const answered = (i: number) => {
    if ((store.answers[i]?.length ?? 0) > 0) return true
    return store.customOn[i] === true && (store.custom[i] ?? "").trim().length > 0
  }

  const picked = (answer: string) => store.answers[store.tab]?.includes(answer) ?? false

  const pick = (answer: string, custom: boolean = false) => {
    setStore("answers", store.tab, [answer])
    if (custom) setStore("custom", store.tab, answer)
    if (!custom) setStore("customOn", store.tab, false)
    setStore("editing", false)
  }

  const toggle = (answer: string) => {
    setStore("answers", store.tab, (current = []) => {
      if (current.includes(answer)) return current.filter((item) => item !== answer)
      return [...current, answer]
    })
  }

  const customToggle = () => {
    if (sending()) return
    setStore("focus", options().length)

    if (!multi()) {
      setStore("customOn", store.tab, true)
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const next = !customEnabled()
    setStore("customOn", store.tab, next)
    if (next) {
      setStore("editing", true)
      customUpdate(input(), true)
      return
    }

    const value = input().trim()
    if (value) setStore("answers", store.tab, (current = []) => current.filter((item) => item.trim() !== value))
    setStore("editing", false)
    focus(options().length)
  }

  const customOpen = () => {
    if (sending()) return
    setStore("focus", options().length)
    if (!customEnabled()) setStore("customOn", store.tab, true)
    setStore("editing", true)
    customUpdate(input(), true)
  }

  const move = (step: number) => {
    if (store.editing || sending()) return
    focus(store.focus + step)
  }

  const nav = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return

    const mod = (event.metaKey || event.ctrlKey) && !event.altKey
    if (mod && event.key === "Enter") {
      if (event.repeat) return
      event.preventDefault()
      next()
      return
    }

    const target =
      event.target instanceof HTMLElement ? event.target.closest('[data-slot="question-options"]') : undefined
    const action = decisionKey(event.key, count())
    if (action?.type === "cancel") {
      event.preventDefault()
      reject()
      return
    }
    if (store.editing) return
    if (!(target instanceof HTMLElement)) return
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (!action) return
    event.preventDefault()
    if (action.type === "move") {
      move(action.step)
      return
    }
    if (action.type === "index") {
      focus(action.index)
      return
    }
    if (action.type === "pick") {
      focus(action.index)
      selectOption(action.index)
      return
    }
    if (action.type === "toggle") {
      selectOption(store.focus)
      return
    }
    if (action.type === "confirm") next()
  }

  const selectOption = (optIndex: number) => {
    if (sending()) return

    if (custom() && optIndex === options().length) {
      customOpen()
      return
    }

    const opt = options()[optIndex]
    if (!opt) return
    if (multi()) {
      setStore("editing", false)
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const commitCustom = () => {
    setStore("editing", false)
    customUpdate(input())
    focus(options().length)
  }

  const resizeInput = (el: HTMLTextAreaElement) => {
    el.style.height = "0px"
    el.style.height = `${el.scrollHeight}px`
  }

  const focusCustom = (el: HTMLTextAreaElement) => {
    setTimeout(() => {
      el.focus()
      resizeInput(el)
    }, 0)
  }

  const toggleCustomMark = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    customToggle()
  }

  const next = () => {
    if (sending()) return
    if (store.editing) commitCustom()

    const action = questionConfirmAction({ multiple: multi(), selected: selected(), last: store.tab >= total() - 1 })
    if (action === "select") {
      selectOption(store.focus)
      return
    }

    if (action === "submit") {
      submit()
      return
    }

    const tab = store.tab + 1
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const back = () => {
    if (sending()) return
    if (store.tab <= 0) return
    const tab = store.tab - 1
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  const jump = (tab: number) => {
    if (sending()) return
    setStore("tab", tab)
    setStore("editing", false)
    focus(pickFocus(tab))
  }

  return (
    <Show
      when={store.phase === "resolved" || store.phase === "cancelled"}
      fallback={
        <DockPrompt
          kind="question"
          ref={(el) => (root = el)}
          onKeyDown={nav}
          header={
            <>
              <div data-slot="decision-head-main">
                <StatusGlyph name="needs-you" size="normal" />
                <div data-slot="question-header-title">
                  {question()?.header || language.t("notification.question.title")}
                </div>
                <PillV2 variant="purple" size="small">
                  {multi()
                    ? language.t("session.decision.multiSelect")
                    : planApproval()
                      ? language.t("session.decision.planApproval")
                      : language.t("session.decision.singleSelect")}
                </PillV2>
                <div
                  id={selectionStatusID()}
                  data-slot="decision-selection-count"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {presentation().selection}
                </div>
              </div>
              <Show when={questions().length > 1}>
                <div data-slot="question-progress-wrap">
                  <span data-slot="question-progress-label">{summary()}</span>
                  <div data-slot="question-progress">
                    <For each={questions()}>
                      {(_, i) => (
                        <button
                          type="button"
                          data-slot="question-progress-segment"
                          data-active={i() === store.tab}
                          data-answered={answered(i())}
                          disabled={sending()}
                          onClick={() => jump(i())}
                          aria-current={i() === store.tab ? "step" : undefined}
                          aria-label={`${language.t("ui.tool.questions")} ${i() + 1}`}
                        />
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </>
          }
          footer={
            <>
              <div data-slot="decision-key-hints">
                <KeyHintV2 shortcut="↑↓" label={language.t("session.decision.move")} decorative />
                <KeyHintV2
                  shortcut="space"
                  label={multi() ? language.t("session.decision.toggle") : language.t("session.decision.select")}
                  decorative
                />
                <KeyHintV2
                  shortcut="esc"
                  label={language.t("session.decision.cancel")}
                  disabled={sending()}
                  onClick={reject}
                  aria-keyshortcuts="Escape"
                />
              </div>
              <div data-slot="question-footer-actions">
                <Show when={store.tab > 0}>
                  <button type="button" data-slot="decision-back" disabled={sending()} onClick={back}>
                    {language.t("ui.common.back")}
                  </button>
                </Show>
                <button
                  type="button"
                  data-slot="decision-confirm"
                  disabled={sending()}
                  onClick={next}
                  aria-keyshortcuts="Enter Meta+Enter Control+Enter"
                >
                  <Show when={sending()}>
                    <StatusGlyph name="running" size="small" />
                  </Show>
                  <span>{sending() ? language.t("session.decision.submitting") : presentation().confirm}</span>
                  <Show when={!sending()}>
                    <StatusGlyph name="enter" size="small" />
                  </Show>
                </button>
              </div>
            </>
          }
        >
          <div id={questionLabelID()} data-slot="question-text" class="overflow-auto">
            {question()?.question}
          </div>
          <div
            data-slot="question-options"
            role={presentation().groupRole}
            aria-labelledby={questionLabelID()}
            aria-describedby={selectionStatusID()}
          >
            <For each={options()}>
              {(opt, i) => (
                <Option
                  multi={multi()}
                  picked={picked(opt.label)}
                  index={i()}
                  label={opt.label}
                  description={opt.description}
                  disabled={sending()}
                  ref={(el) => (optsRef[i()] = el)}
                  onFocus={() => setStore("focus", i())}
                  onClick={() => selectOption(i())}
                />
              )}
            </For>

            <Show when={custom()}>
              <Show
                when={store.editing}
                fallback={
                  <button
                    type="button"
                    ref={customRef}
                    data-slot="question-option"
                    data-custom="true"
                    data-option-index={options().length + 1}
                    data-picked={customPicked()}
                    role={presentation().optionRole}
                    aria-checked={customPicked()}
                    disabled={sending()}
                    onFocus={() => setStore("focus", options().length)}
                    onClick={customOpen}
                  >
                    <Mark multi={multi()} picked={customPicked()} onClick={toggleCustomMark} />
                    <span data-slot="question-option-main">
                      <span data-slot="option-label">{customLabel()}</span>
                      <span data-slot="option-description">{input() || customPlaceholder()}</span>
                    </span>
                  </button>
                }
              >
                <form
                  data-slot="question-option"
                  data-custom="true"
                  data-option-index={options().length + 1}
                  data-picked={customPicked()}
                  role={presentation().optionRole}
                  aria-checked={customPicked()}
                  onMouseDown={(e) => {
                    if (sending()) {
                      e.preventDefault()
                      return
                    }
                    if (e.target instanceof HTMLTextAreaElement) return
                    const input = e.currentTarget.querySelector('[data-slot="question-custom-input"]')
                    if (input instanceof HTMLTextAreaElement) input.focus()
                  }}
                  onSubmit={(e) => {
                    e.preventDefault()
                    commitCustom()
                  }}
                >
                  <Mark multi={multi()} picked={customPicked()} onClick={toggleCustomMark} />
                  <span data-slot="question-option-main">
                    <span data-slot="option-label">{customLabel()}</span>
                    <textarea
                      ref={focusCustom}
                      data-slot="question-custom-input"
                      placeholder={customPlaceholder()}
                      value={input()}
                      rows={1}
                      disabled={sending()}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault()
                          e.stopPropagation()
                          setStore("editing", false)
                          focus(options().length)
                          return
                        }
                        if ((e.metaKey || e.ctrlKey) && !e.altKey) return
                        if (e.key !== "Enter" || e.shiftKey) return
                        e.preventDefault()
                        commitCustom()
                      }}
                      onInput={(e) => {
                        customUpdate(e.currentTarget.value)
                        resizeInput(e.currentTarget)
                      }}
                    />
                  </span>
                </form>
              </Show>
            </Show>
          </div>
        </DockPrompt>
      }
    >
      <div data-component="decision-resolved" data-variant={store.phase === "cancelled" ? "cancelled" : "resolved"}>
        <StatusGlyph name={store.phase === "cancelled" ? "failed" : "done"} size="normal" />
        <span>
          {store.phase === "cancelled"
            ? language.t("session.decision.questionCancelled")
            : language.t("session.decision.questionResolved", { count: answerCount() })}
        </span>
      </div>
    </Show>
  )
}
