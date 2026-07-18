import { createStore } from "solid-js/store"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { selectedForeground, tint, useTheme } from "../../context/theme"
import type { QuestionAnswer, QuestionRequest } from "@oc2-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../ui/border"
import { useTuiConfig } from "../../config"
import { useBindings, useOpencodeModeStack } from "../../keymap"
import { Glyph } from "../../component/glyph"
import { KeyHint } from "../../component/key-hint"

const QUESTION_MODE = "question"

export function QuestionPrompt(props: {
  request: QuestionRequest
  directory?: string
  tool?: string
  onResolved?: (summary: { variant: "resolved" | "cancelled"; text: string }) => void
}) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const tuiConfig = useTuiConfig()
  const modeStack = useOpencodeModeStack()
  const dimensions = useTerminalDimensions()
  const questions = createMemo(() => props.request.questions)
  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as QuestionAnswer[],
    custom: [] as string[],
    focused: 0,
    editing: false,
    phase: "waiting" as "waiting" | "submitting" | "resolved" | "cancelled",
  })
  let textarea: TextareaRenderable | undefined

  const question = createMemo(() => questions()[store.tab])
  const options = createMemo(() => question()?.options ?? [])
  const custom = createMemo(() => question()?.custom !== false)
  const total = createMemo(() => options().length + (custom() ? 1 : 0))
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const planApproval = createMemo(() => props.tool === "plan_exit")
  const planDecision = createMemo(() => store.answers[store.tab]?.[0])
  const narrow = createMemo(() => dimensions().width < 80)
  const last = createMemo(() => store.tab >= questions().length - 1)
  const selected = createMemo(() => store.answers[store.tab]?.length ?? 0)
  const selectedTotal = createMemo(() => store.answers.reduce((sum, answer) => sum + (answer?.length ?? 0), 0))
  const customPicked = createMemo(() => {
    const value = input()
    return value ? (store.answers[store.tab]?.includes(value) ?? false) : false
  })

  const reply = (answers: QuestionAnswer[]) => {
    setStore("phase", "submitting")
    void sdk.client.question
      .reply({ requestID: props.request.id, directory: props.directory, answers })
      .then((result) => {
        if (result.error) {
          setStore("phase", "waiting")
          return
        }
        setStore("phase", "resolved")
        props.onResolved?.({ variant: "resolved", text: `Question resolved — ${selectedTotal()} selected` })
      })
      .catch(() => setStore("phase", "waiting"))
  }

  const submit = () => reply(questions().map((_, index) => store.answers[index] ?? []))

  const reject = () => {
    setStore("phase", "submitting")
    void sdk.client.question
      .reject({ requestID: props.request.id, directory: props.directory })
      .then((result) => {
        if (result.error) {
          setStore("phase", "waiting")
          return
        }
        setStore("phase", "cancelled")
        props.onResolved?.({ variant: "cancelled", text: "Question cancelled" })
      })
      .catch(() => setStore("phase", "waiting"))
  }

  const moveQuestion = (index: number) => {
    const count = questions().length
    if (!count) return
    setStore("tab", (index + count) % count)
    setStore("focused", 0)
    setStore("editing", false)
  }

  const moveOption = (index: number) => {
    const count = total()
    if (!count) return
    setStore("focused", (index + count) % count)
  }

  const toggle = (answer: string) => {
    const answers = [...store.answers]
    const current = answers[store.tab] ?? []
    answers[store.tab] = current.includes(answer) ? current.filter((item) => item !== answer) : [...current, answer]
    setStore("answers", answers)
  }

  const pick = (answer: string, own = false) => {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)
    if (own) {
      const values = [...store.custom]
      values[store.tab] = answer
      setStore("custom", values)
    }
  }

  const selectOption = (index = store.focused) => {
    if (store.phase !== "waiting") return
    if (custom() && index === options().length) {
      const value = input()
      if (multi() && value) {
        toggle(value)
        return
      }
      setStore("editing", true)
      return
    }
    const option = options()[index]
    if (!option) return
    if (multi()) {
      toggle(option.label)
      return
    }
    pick(option.label)
  }

  const confirm = () => {
    if (store.phase !== "waiting") return
    if (!multi() && selected() === 0) {
      selectOption()
      return
    }
    if (!last()) {
      moveQuestion(store.tab + 1)
      return
    }
    submit()
  }

  onMount(() => {
    const popMode = modeStack.push(QUESTION_MODE)
    onCleanup(popMode)
  })

  useBindings(() => ({
    mode: QUESTION_MODE,
    enabled: store.editing && store.phase === "waiting",
    commands: [
      {
        name: "prompt.clear",
        title: "Clear answer edit",
        category: "Question",
        run() {
          const text = textarea?.plainText ?? ""
          if (!text) {
            setStore("editing", false)
            return
          }
          textarea?.setText("")
        },
      },
    ],
    bindings: [
      {
        key: "escape",
        desc: "Cancel answer edit",
        group: "Question",
        cmd: () => setStore("editing", false),
      },
      ...tuiConfig.keybinds.get("prompt.clear"),
      {
        key: "return",
        desc: "Submit answer edit",
        group: "Question",
        cmd: () => {
          const text = textarea?.plainText?.trim() ?? ""
          const previous = store.custom[store.tab]
          if (!text) {
            const values = [...store.custom]
            values[store.tab] = ""
            setStore("custom", values)
            if (previous) {
              const answers = [...store.answers]
              answers[store.tab] = (answers[store.tab] ?? []).filter((item) => item !== previous)
              setStore("answers", answers)
            }
            setStore("editing", false)
            return
          }

          if (!multi()) {
            setStore("editing", false)
            pick(text, true)
            return
          }

          const values = [...store.custom]
          values[store.tab] = text
          setStore("custom", values)
          const answers = [...store.answers]
          const current = (answers[store.tab] ?? []).filter((item) => item !== previous)
          answers[store.tab] = current.includes(text) ? current : [...current, text]
          setStore("answers", answers)
          setStore("editing", false)
        },
      },
    ],
  }))

  useBindings(() => ({
    mode: QUESTION_MODE,
    enabled: !store.editing && store.phase === "waiting",
    commands: [
      {
        name: "app.exit",
        title: "Reject question",
        category: "Question",
        run: reject,
      },
    ],
    bindings: [
      { key: "left", desc: "Previous question", group: "Question", cmd: () => moveQuestion(store.tab - 1) },
      { key: "h", desc: "Previous question", group: "Question", cmd: () => moveQuestion(store.tab - 1) },
      { key: "right", desc: "Next question", group: "Question", cmd: () => moveQuestion(store.tab + 1) },
      { key: "l", desc: "Next question", group: "Question", cmd: () => moveQuestion(store.tab + 1) },
      {
        key: "tab",
        desc: "Next question",
        group: "Question",
        cmd: ({ event }: { event: { shift: boolean } }) => moveQuestion(store.tab + (event.shift ? -1 : 1)),
      },
      ...Array.from({ length: Math.min(total(), 9) }, (_, index) => ({
        key: String(index + 1),
        desc: `Select answer ${index + 1}`,
        group: "Question",
        cmd: () => {
          moveOption(index)
          selectOption(index)
        },
      })),
      { key: "up", desc: "Previous answer", group: "Question", cmd: () => moveOption(store.focused - 1) },
      { key: "k", desc: "Previous answer", group: "Question", cmd: () => moveOption(store.focused - 1) },
      { key: "down", desc: "Next answer", group: "Question", cmd: () => moveOption(store.focused + 1) },
      { key: "j", desc: "Next answer", group: "Question", cmd: () => moveOption(store.focused + 1) },
      { key: "space", desc: "Toggle answer", group: "Question", cmd: () => selectOption() },
      { key: "return", desc: "Confirm answer", group: "Question", cmd: confirm },
      { key: "escape", desc: "Reject question", group: "Question", cmd: reject },
      ...tuiConfig.keybinds.get("app.exit"),
    ],
  }))

  return (
    <Show
      when={store.phase === "resolved" || store.phase === "cancelled"}
      fallback={
        <box
          backgroundColor={theme.backgroundPanel}
          border={["left"]}
          borderColor={theme.accent}
          customBorderChars={SplitBorder.customBorderChars}
        >
          <box gap={1} paddingLeft={2} paddingRight={3} paddingTop={1} paddingBottom={1}>
            <box flexDirection={narrow() ? "column" : "row"} gap={1}>
              <box flexDirection="row" gap={1}>
                <Glyph name="needs-you" />
                <text fg={theme.text}>
                  <b>{question()?.header ?? "Question"}</b>
                </text>
                <text fg={theme.accent}>
                  {multi() ? "[multi-select]" : planApproval() ? "[plan approval]" : "[single-select]"}
                </text>
              </box>
              <box flexGrow={1} />
              <text fg={theme.accent}>
                <b>
                  {selected()} of {total()} selected
                </b>
              </text>
            </box>

            <Show when={questions().length > 1}>
              <box flexDirection="row" gap={1} paddingLeft={2}>
                <For each={questions()}>
                  {(item, index) => (
                    <box
                      paddingLeft={1}
                      paddingRight={1}
                      backgroundColor={index() === store.tab ? theme.accent : theme.backgroundPanel}
                      onMouseUp={() => moveQuestion(index())}
                    >
                      <text fg={index() === store.tab ? selectedForeground(theme, theme.accent) : theme.textMuted}>
                        {item.header}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>

            <box paddingLeft={2}>
              <text fg={theme.text}>{question()?.question}</text>
            </box>

            <box paddingLeft={1}>
              <For each={options()}>
                {(option, index) => {
                  const focused = () => index() === store.focused
                  const picked = () => store.answers[store.tab]?.includes(option.label) ?? false
                  return (
                    <box
                      backgroundColor={focused() ? tint(theme.backgroundPanel, theme.accent, 0.12) : undefined}
                      paddingLeft={1}
                      paddingRight={1}
                      onMouseOver={() => moveOption(index())}
                      onMouseDown={() => moveOption(index())}
                      onMouseUp={() => {
                        if (renderer.getSelection()?.getSelectedText()) return
                        selectOption(index())
                      }}
                    >
                      <box flexDirection="row" gap={1}>
                        <text fg={picked() ? theme.accent : theme.textMuted}>
                          {multi() ? `[${picked() ? "✓" : " "}]` : picked() ? "(●)" : "( )"}
                        </text>
                        <text fg={theme.textMuted}>{index() + 1}</text>
                        <text fg={focused() ? theme.accent : picked() ? theme.text : theme.textMuted}>
                          <span style={{ bold: focused() || picked() }}>{option.label}</span>
                        </text>
                      </box>
                      <Show when={option.description}>
                        <box paddingLeft={6}>
                          <text fg={theme.textMuted}>{option.description}</text>
                        </box>
                      </Show>
                    </box>
                  )
                }}
              </For>

              <Show when={custom()}>
                <box
                  backgroundColor={
                    store.focused === options().length ? tint(theme.backgroundPanel, theme.accent, 0.12) : undefined
                  }
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseOver={() => moveOption(options().length)}
                  onMouseDown={() => moveOption(options().length)}
                  onMouseUp={() => {
                    if (renderer.getSelection()?.getSelectedText()) return
                    selectOption(options().length)
                  }}
                >
                  <box flexDirection="row" gap={1}>
                    <text fg={customPicked() ? theme.accent : theme.textMuted}>
                      {multi() ? `[${customPicked() ? "✓" : "┄"}]` : customPicked() ? "(●)" : "(┄)"}
                    </text>
                    <text fg={theme.textMuted}>{options().length + 1}</text>
                    <text fg={store.focused === options().length ? theme.accent : theme.textMuted}>
                      <span style={{ bold: store.focused === options().length }}>Type your own answer</span>
                    </text>
                  </box>
                  <Show when={store.editing}>
                    <box paddingLeft={6}>
                      <textarea
                        ref={(value: TextareaRenderable) => {
                          textarea = value
                          value.traits = { status: "ANSWER" }
                          queueMicrotask(() => {
                            value.focus()
                            value.gotoLineEnd()
                          })
                        }}
                        initialValue={input()}
                        placeholder="Type your own answer"
                        placeholderColor={theme.textMuted}
                        minHeight={1}
                        maxHeight={6}
                        textColor={theme.text}
                        focusedTextColor={theme.text}
                        cursorColor={theme.primary}
                      />
                    </box>
                  </Show>
                  <Show when={!store.editing && input()}>
                    <box paddingLeft={6}>
                      <text fg={theme.textMuted}>{input()}</text>
                    </box>
                  </Show>
                </box>
              </Show>
            </box>
          </box>

          <box
            flexDirection={narrow() ? "column" : "row"}
            flexShrink={0}
            gap={1}
            paddingLeft={2}
            paddingRight={3}
            paddingBottom={1}
            justifyContent="space-between"
          >
            <box flexDirection="row" gap={2}>
              <KeyHint shortcut="↑↓" label="move" />
              <KeyHint shortcut="space" label={multi() ? "toggle" : "select"} />
              <KeyHint shortcut="esc" label="cancel" />
            </box>
            <box
              width={narrow() ? "100%" : undefined}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.accent}
              onMouseUp={confirm}
            >
              <text fg={selectedForeground(theme, theme.accent)}>
                <b>
                  {store.phase === "submitting"
                    ? "◐ Submitting"
                    : `${last() ? (planApproval() ? (planDecision() === "No" ? "Keep planning" : planDecision() === "Yes" ? "Approve plan" : "Choose plan action") : multi() ? `Confirm ${selected()}` : "Confirm answer") : "Next question"} ⏎`}
                </b>
              </text>
            </box>
          </box>
        </box>
      }
    >
      <box backgroundColor={store.phase === "cancelled" ? theme.error : theme.success} paddingLeft={2} paddingRight={2}>
        <text fg={selectedForeground(theme, store.phase === "cancelled" ? theme.error : theme.success)}>
          {store.phase === "cancelled" ? "✕ Question cancelled" : `✓ Question resolved — ${selectedTotal()} selected`}
        </text>
      </box>
    </Show>
  )
}
