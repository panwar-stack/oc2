/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import type { QuestionRequest } from "@oc2-ai/sdk/v2"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { SDKProvider } from "../../../src/context/sdk"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { QuestionPrompt } from "../../../src/routes/session/question"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createFetch, eventSource, json } from "../../fixture/tui-sdk"

let app: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  app?.renderer.destroy()
  app = undefined
})

const request = {
  id: "question-1",
  sessionID: "session-1",
  questions: [
    {
      header: "Priorities",
      question: "Which areas should the redesign prioritize?",
      multiple: true,
      custom: false,
      options: [
        { label: "Information hierarchy", description: "Improve grouping and density" },
        { label: "Tool activity", description: "Clarify running and completed states" },
        { label: "Composer workflow", description: "Improve prompts and approvals" },
      ],
    },
  ],
} satisfies QuestionRequest

const planRequest = {
  id: "plan-1",
  sessionID: "session-1",
  tool: { messageID: "message-1", callID: "call-1" },
  questions: [
    {
      header: "Build Agent",
      question: "The plan is complete. Start implementing?",
      custom: false,
      options: [
        { label: "Yes", description: "Approve the plan and start implementation" },
        { label: "No", description: "Keep refining the plan" },
      ],
    },
  ],
} satisfies QuestionRequest

const singleRequest = {
  id: "single-1",
  sessionID: "session-1",
  questions: [
    {
      header: "Mode",
      question: "Which mode should be used?",
      custom: false,
      options: [
        { label: "Safe", description: "Use safe mode" },
        { label: "Fast", description: "Use fast mode" },
      ],
    },
  ],
} satisfies QuestionRequest

async function waitFor(check: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for decision card")
    await app?.renderOnce()
    await Bun.sleep(10)
  }
}

async function mount(input: { request?: QuestionRequest; tool?: string; width?: number } = {}) {
  const calls: string[] = []
  const config = createTuiResolvedConfig({ theme: "oc2" })
  const requestFetch = createFetch((url) => {
    if (!url.pathname.startsWith("/question/")) return
    calls.push(url.pathname)
    return json(true)
  })

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const dispose = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(dispose)
    return (
      <TestTuiContexts>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <SDKProvider url="http://test" events={eventSource()} fetch={requestFetch.fetch}>
                  <box width={input.width ?? 76}>
                    <QuestionPrompt request={input.request ?? request} tool={input.tool} />
                  </box>
                </SDKProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  app = await testRender(() => <Harness />, { width: input.width ?? 76, height: 18, kittyKeyboard: true })
  await waitFor(() => app!.captureCharFrame().includes(input.request?.questions[0]?.header ?? "Priorities"))
  return calls
}

describe("TUI decision cards", () => {
  test("shows the decision grammar, live selection count, and consequence label", async () => {
    await mount()
    let frame = app!.captureCharFrame()
    expect(frame).toContain("▲ Priorities [multi-select]")
    expect(frame).toContain("0 of 3 selected")
    expect(frame).toContain("space  toggle")
    expect(frame).toContain("Confirm 0 ⏎")

    app!.mockInput.pressKey("2")
    await waitFor(() => app!.captureCharFrame().includes("1 of 3 selected"))
    frame = app!.captureCharFrame()
    expect(frame).toContain("[✓] 2 Tool activity")
    expect(frame).toContain("1 of 3 selected")
    expect(frame).toContain("Confirm 1 ⏎")
  })

  test("enter confirms selected answers and escape cancels", async () => {
    const calls = await mount()
    app!.mockInput.pressKey("1")
    app!.mockInput.pressEnter()
    await waitFor(() => calls.includes("/question/question-1/reply"))
    expect(calls).toContain("/question/question-1/reply")

    app!.renderer.destroy()
    app = undefined
    const cancelled = await mount()
    app!.mockInput.pressEscape()
    await waitFor(() => cancelled.includes("/question/question-1/reject"))
    expect(cancelled).toContain("/question/question-1/reject")
  })

  test("plan approval carries the selected consequence and stays usable when narrow", async () => {
    const calls = await mount({ request: planRequest, tool: "plan_exit", width: 60 })
    let frame = app!.captureCharFrame()
    expect(frame).toContain("[plan approval]")
    expect(frame).toContain("Choose plan action ⏎")

    app!.mockInput.pressKey("2")
    await waitFor(() => app!.captureCharFrame().includes("Keep planning ⏎"))
    frame = app!.captureCharFrame()
    expect(frame).toContain("Keep planning ⏎")
    expect(calls).not.toContain("/question/plan-1/reply")

    app!.mockInput.pressEnter()
    await waitFor(() => calls.includes("/question/plan-1/reply"))
  })

  test("does not reply when Enter only selects the focused plan action", async () => {
    const calls = await mount({ request: planRequest, tool: "plan_exit" })
    app!.mockInput.pressEnter()
    await waitFor(() => app!.captureCharFrame().includes("Approve plan ⏎"))
    expect(calls).not.toContain("/question/plan-1/reply")

    app!.mockInput.pressEnter()
    await waitFor(() => calls.includes("/question/plan-1/reply"))
  })

  test("ordinary single-select waits for the displayed confirmation", async () => {
    const calls = await mount({ request: singleRequest })
    app!.mockInput.pressKey("2")
    await waitFor(() => app!.captureCharFrame().includes("1 of 2 selected"))
    expect(calls).not.toContain("/question/single-1/reply")

    app!.mockInput.pressEnter()
    await waitFor(() => calls.includes("/question/single-1/reply"))
  })

  test("permission prompt keeps purple waiting, consequence, and cancellation channels", async () => {
    const source = await Bun.file(new URL("../../../src/routes/session/permission.tsx", import.meta.url)).text()
    expect(source).toContain('<Glyph name="needs-you" />')
    expect(source).toContain("borderColor={theme.accent}")
    expect(source).toContain('options={{ once: "Allow once", always: "Allow always", reject: "Deny" }}')
    expect(source).toContain('escapeKey="reject"')
    expect(source).toContain('key: "space"')
    expect(source).toContain('key: "up"')
    expect(source).toContain("enabled: !store.submitting")
    expect(source).toContain('backgroundColor={String(store.selected) === "reject" ? theme.error : theme.accent}')
    expect(source).toContain("`${props.options[store.selected]} ⏎`")
  })
})
