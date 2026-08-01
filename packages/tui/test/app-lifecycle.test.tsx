import { expect, mock, test } from "bun:test"
import { CliRenderEvents } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { Effect } from "effect"
import { Global } from "@oc2-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "./fixture/tui-sdk"
import { TestTuiContexts } from "./fixture/tui-environment"
import { TuiConfigProvider } from "../src/config"
import { KVProvider } from "../src/context/kv"
import { ThemeProvider, useTheme } from "../src/context/theme"

async function waitFor(check: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(Global.defaultLayer)),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("late terminal theme mode reconciles unless the user locks the mode", async () => {
  let theme: ReturnType<typeof useTheme> | undefined

  function CaptureTheme() {
    theme = useTheme()
    return null
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
            <CaptureTheme />
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </TestTuiContexts>
  ))

  try {
    await waitFor(() => theme !== undefined)
    expect(theme?.mode()).toBe("dark")

    app.renderer.emit(CliRenderEvents.THEME_MODE, "light")
    expect(theme?.mode()).toBe("light")

    theme?.setMode("dark")
    expect(theme?.locked()).toBe(true)
    app.renderer.emit(CliRenderEvents.THEME_MODE, "light")
    expect(theme?.mode()).toBe("dark")
  } finally {
    theme?.unlock()
    app.renderer.destroy()
  }
})
