/** @jsxImportSource @opentui/solid */
import { describe, expect, mock, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { Global } from "@oc2-ai/core/global"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { createEventSource, createFetch, directory } from "../fixture/tui-sdk"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createPauseStartCommands, type PauseStartAction } from "../../src/command/session-pause"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../../src/keymap"
import { ArgsProvider } from "../../src/context/args"
import { KVProvider } from "../../src/context/kv"
import { ToastProvider } from "../../src/ui/toast"
import { RouteProvider } from "../../src/context/route"
import { TuiConfigProvider } from "../../src/config"
import { SDKProvider } from "../../src/context/sdk"
import { ProjectProvider } from "../../src/context/project"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { LocalProvider } from "../../src/context/local"
import { PromptStashProvider } from "../../src/component/prompt/stash"
import { DialogProvider } from "../../src/ui/dialog"
import { PromptHistoryProvider } from "../../src/component/prompt/history"
import { ClipboardProvider } from "../../src/context/clipboard"
import { EditorContextProvider } from "../../src/context/editor"

// Regression test: submitting a deprecated slash alias (e.g. `/start` for
// `/unpause`) must dispatch the command through the REAL prompt submit path in
// packages/tui/src/component/prompt/index.tsx (`submitInner`). The local
// `matchLocalSlash` mirror in test/command/session-pause.test.ts checks aliases,
// but `submitInner` used to resolve only `entry.display`, so `/start` fell
// through to the model prompt while a paused session queued input.
//
// This file mounts the real `Prompt` component with the real keymap and drives
// Enter through the real keymap binding, so a regression in `submitInner`
// (e.g. dropping the alias fallback) fails here. Only the autocomplete popup is
// stubbed out (it is imported only by the prompt, so the mock cannot leak into
// other test files).

const SESSION = "ses_prompt_alias"

type PromptHandle = {
  reset(): void
  current: { input: string; parts: unknown[] }
}

const dispatched: PauseStartAction[] = []

mock.module("../../src/component/prompt/autocomplete", () => ({
  Autocomplete: () => <box />,
}))

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountPrompt() {
  const { Prompt } = await import("../../src/component/prompt")
  const events = createEventSource()
  const calls = createFetch()
  let sync!: ReturnType<typeof useSync>
  let prompt!: PromptHandle
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 2_000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    function Probe() {
      // Register the pause/unpause commands the same way the session route does
      // (src/routes/session/index.tsx `sessionCommands()`), so the real
      // `useCommandSlashes` surfaces `/unpause` with its `/start` alias.
      const pauseCommands = createPauseStartCommands({
        sessionID: () => SESSION,
        pauseState: () => ({ paused: true }),
        run: (action) => dispatched.push(action),
      }).map((command) => ({
        namespace: "palette",
        name: command.value,
        desc: "description" in command ? command.description : undefined,
        slashName: "slash" in command ? command.slash?.name : undefined,
        slashAliases: "slash" in command ? command.slash?.aliases : undefined,
        ...command,
      }))
      useBindings(() => ({ commands: pauseCommands }))

      sync = useSync()
      onMount(ready)
      return (
        <Prompt
          ref={(value) => {
            if (value) prompt = value
          }}
        />
      )
    }

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TestTuiContexts paths={{ state: Global.Path.state }}>
          <ArgsProvider>
            <KVProvider>
              <ToastProvider>
                <RouteProvider>
                  <TuiConfigProvider config={resolvedConfig}>
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                      <ProjectProvider>
                        <SyncProvider>
                          <ThemeProvider mode="dark">
                            <LocalProvider>
                              <PromptStashProvider>
                                <DialogProvider>
                                  <PromptHistoryProvider>
                                    <ClipboardProvider>
                                      <EditorContextProvider>
                                        <box width={100} height={8}>
                                          <Probe />
                                        </box>
                                      </EditorContextProvider>
                                    </ClipboardProvider>
                                  </PromptHistoryProvider>
                                </DialogProvider>
                              </PromptStashProvider>
                            </LocalProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </ProjectProvider>
                    </SDKProvider>
                  </TuiConfigProvider>
                </RouteProvider>
              </ToastProvider>
            </KVProvider>
          </ArgsProvider>
        </TestTuiContexts>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 8 })

  await mounted
  await wait(() => sync.status === "complete")
  return { app, prompt }
}

async function submitAlias(alias: string) {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  dispatched.length = 0
  const { app, prompt } = await mountPrompt()
  try {
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused prompt textarea")

    textarea.insertText(alias)
    await wait(() => prompt.current.input === alias)

    // Enter through the real keymap: `input_submit` / `prompt.submit` both
    // converge on `submit()` in the real Prompt component. The textarea's
    // native onSubmit defers `submit()` by two macrotasks, so allow a short
    // settle before reading the final store state (a dispatched slash clears
    // the input; a non-match leaves it unchanged).
    app.mockInput.pressEnter()
    await Bun.sleep(50)

    return { input: prompt.current.input }
  } finally {
    // reset() clears the store so the module-level prompt stash does not leak
    // this mount's input into the next mount in the same test file.
    prompt.reset()
    app.renderer.destroy()
    Global.Path.state = previous
  }
}

describe("prompt submit dispatch for slash aliases", () => {
  test("the /start alias dispatches the unpause command through the real submit path", async () => {
    const { input } = await submitAlias("/start")
    expect(dispatched).toEqual(["unpause"])
    // A dispatched internal slash clears the prompt input.
    expect(input).toBe("")
  })

  test("the misspelled /starte does not dispatch a local slash command", async () => {
    const { input } = await submitAlias("/starte")
    expect(dispatched).toEqual([])
    expect(input).toBe("/starte")
  })

  test("the misspelled /started does not dispatch a local slash command", async () => {
    const { input } = await submitAlias("/started")
    expect(dispatched).toEqual([])
    expect(input).toBe("/started")
  })
})
