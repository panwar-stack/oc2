import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@oc2-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "./fixture/tui-sdk"
import type { TuiStartupTraceInput } from "@oc2-ai/core/util/tui-startup-profile"

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
  const startup: TuiStartupTraceInput[] = []

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        startupTrace(input) {
          startup.push(input)
          return true
        },
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
    expect(startup.filter((item) => item.event === "theme.settled")).toHaveLength(1)
    expect(
      startup.some((item) => item.event === "phase" && item.phase === "plugin.load" && item.outcome === "ok"),
    ).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("startup input markers stay content-free and latch once per prompt mount", async () => {
  const source = await Bun.file(new URL("../src/component/prompt/index.tsx", import.meta.url)).text()
  const sync = await Bun.file(new URL("../src/context/sync.tsx", import.meta.url)).text()
  const theme = await Bun.file(new URL("../src/context/theme.tsx", import.meta.url)).text()
  const change = source.indexOf("onContentChange")
  const store = source.indexOf('setStore("prompt", "input", value)', change)
  const accepted = source.indexOf('event: "input.accepted"', store)
  const ref = source.indexOf("ref={(r: TextareaRenderable)", accepted)
  const mounted = source.indexOf('event: "prompt.mounted"', ref)

  expect(change).toBeGreaterThan(-1)
  expect(store).toBeGreaterThan(change)
  expect(accepted).toBeGreaterThan(store)
  expect(mounted).toBeGreaterThan(ref)
  expect(source.slice(accepted, accepted + 220)).not.toContain("value")
  expect(source.slice(mounted, mounted + 220)).not.toContain("placeholder")
  expect(source).toContain("if (props.startup && !inputMarked)")
  expect(source).toContain("if (props.startup && !mountedMarked)")
  const ready = sync.indexOf('setStore("status", "partial")')
  const critical = sync.indexOf('event: "bootstrap.critical.ready"', ready)
  expect(critical).toBeGreaterThan(ready)
  const apply = theme.indexOf("apply(mode)")
  const reconciled = theme.indexOf('event: "theme.reconciled"', apply)
  expect(reconciled).toBeGreaterThan(apply)
})
