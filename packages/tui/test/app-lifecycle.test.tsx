import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { Global } from "@oc2-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "./fixture/tui-sdk"
import type { TuiStartupTraceInput } from "@oc2-ai/core/util/tui-startup-profile"
import { createTuiStartupInputTrace, isolateTuiStartupTrace } from "../src/context/runtime"
import { startupThemeSettlement } from "../src/context/theme"
import { captureSynchronousStartup } from "../src/context/sync"

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
          throw new Error("trace sink failed")
        },
        args: {},
        pluginHost: {
          start() {
            started()
            throw new Error("plugin start failed")
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
      startup.some((item) => item.event === "phase" && item.phase === "plugin.load" && item.outcome === "error"),
    ).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("startup markers use lock-aware and accepted-input boundaries", async () => {
  const markers: TuiStartupTraceInput[] = []
  const trace = isolateTuiStartupTrace((input) => {
    markers.push(input)
    return true
  })
  const input = createTuiStartupInputTrace(trace)

  input.changed()
  input.mount()
  input.changed()
  const end = input.begin()
  await Promise.resolve()
  input.changed()
  end()
  input.begin()
  input.changed()

  expect(markers.map((item) => item.event)).toEqual(["prompt.mounted", "input.accepted"])
  expect(startupThemeSettlement("dark", "fallback-final")).toBe("locked")
  expect(startupThemeSettlement(undefined, "fallback-final")).toBe("fallback-final")

  const startupFailure = new Error("critical startup failed")
  let reported: unknown
  expect(
    captureSynchronousStartup(
      () => {
        throw startupFailure
      },
      (error) => {
        reported = error
      },
    ),
  ).toBeUndefined()
  expect(reported).toBe(startupFailure)
  expect(() =>
    captureSynchronousStartup(
      () => {
        throw startupFailure
      },
      (error) => {
        throw error
      },
    ),
  ).toThrow(startupFailure)

  const source = await Bun.file(new URL("../src/component/prompt/index.tsx", import.meta.url)).text()
  const app = await Bun.file(new URL("../src/app.tsx", import.meta.url)).text()
  const sync = await Bun.file(new URL("../src/context/sync.tsx", import.meta.url)).text()
  const theme = await Bun.file(new URL("../src/context/theme.tsx", import.meta.url)).text()
  const change = source.indexOf("onContentChange")
  const store = source.indexOf('setStore("prompt", "input", value)', change)
  const accepted = source.indexOf("startupInput.changed()", store)
  const ref = source.indexOf("ref={(r: TextareaRenderable)", accepted)
  const mounted = source.indexOf("startupInput.mount()", ref)
  const forwarded = source.indexOf("props.ref?.(ref)", mounted)

  expect(change).toBeGreaterThan(-1)
  expect(store).toBeGreaterThan(change)
  expect(accepted).toBeGreaterThan(store)
  expect(mounted).toBeGreaterThan(ref)
  expect(forwarded).toBeGreaterThan(mounted)
  expect(source).toContain("if (e.name.length === 1 && !e.ctrl && !e.meta) armInput()")
  const pasteCommand = source.indexOf('name: "prompt.paste"')
  const commandOperation = source.indexOf("const endInput = startupInput.begin()", pasteCommand)
  const clipboardRead = source.indexOf("await clipboard.read?.()", commandOperation)
  const commandEnd = source.indexOf("endInput()", clipboardRead)
  expect(commandOperation).toBeGreaterThan(pasteCommand)
  expect(clipboardRead).toBeGreaterThan(commandOperation)
  expect(commandEnd).toBeGreaterThan(clipboardRead)
  const bracketedPaste = source.indexOf("onPaste={async")
  const emptyPaste = source.indexOf('keymap.dispatchCommand("prompt.paste")', bracketedPaste)
  const asyncOperation = source.indexOf("const endInput = startupInput.begin()", bracketedPaste)
  const asyncPaste = source.indexOf("await pasteInputText(normalizedText)", asyncOperation)
  const asyncEnd = source.indexOf("endInput()", asyncPaste)
  expect(emptyPaste).toBeGreaterThan(bracketedPaste)
  expect(emptyPaste).toBeLessThan(asyncOperation)
  expect(asyncOperation).toBeGreaterThan(bracketedPaste)
  expect(asyncPaste).toBeGreaterThan(asyncOperation)
  expect(asyncEnd).toBeGreaterThan(asyncPaste)
  const ready = sync.indexOf('setStore("status", "partial")')
  const critical = sync.indexOf('event: "bootstrap.critical.ready"', ready)
  expect(critical).toBeGreaterThan(ready)
  const captured = sync.indexOf("const started = captureSynchronousStartup")
  const projectStart = sync.indexOf("project.sync()", captured)
  const sdkStart = sync.indexOf("sdk.client.config.providers", projectStart)
  const failedStart = sync.indexOf("}, failBootstrap)", sdkStart)
  expect(captured).toBeGreaterThan(-1)
  expect(projectStart).toBeGreaterThan(captured)
  expect(sdkStart).toBeGreaterThan(projectStart)
  expect(failedStart).toBeGreaterThan(sdkStart)
  expect(app).not.toContain('event: "theme.settled"')
  const lock = theme.indexOf("draft.lock = lock")
  const settled = theme.indexOf('event: "theme.settled"', lock)
  expect(settled).toBeGreaterThan(lock)
  expect(theme.indexOf('event: "theme.settled"', settled + 1)).toBe(-1)
  const apply = theme.indexOf("apply(mode)")
  const reconciled = theme.indexOf('event: "theme.reconciled"', apply)
  expect(reconciled).toBeGreaterThan(apply)
})
