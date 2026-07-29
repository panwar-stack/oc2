/** @jsxImportSource @opentui/solid */
import { expect, mock, spyOn, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { Effect } from "effect"
import { Global } from "@oc2-ai/core/global"
import { Flock } from "@oc2-ai/core/util/flock"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "./fixture/tui-sdk"
import { TestTuiContexts } from "./fixture/tui-environment"
import type { TuiStartupTraceInput } from "@oc2-ai/core/util/tui-startup-profile"
import { createTuiStartupInputTrace, isolateTuiStartupTrace } from "../src/context/runtime"
import { ThemeProvider, startupThemeSettlement, startupThemeState } from "../src/context/theme"
import { captureCriticalBootstrapStartup, reportCriticalBootstrapFailure } from "../src/context/sync"
import { KVProvider } from "../src/context/kv"
import { TuiConfigProvider } from "../src/config"

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
  const critical: TuiStartupTraceInput[] = []
  let destroyed = 0
  let reported: unknown
  const fatalResult = captureCriticalBootstrapStartup({
    workspace: () => {
      throw startupFailure
    },
    start: () => {
      throw new Error("critical requests must not start")
    },
    failed: (error) => {
      reported = error
      reportCriticalBootstrapFailure({
        error,
        fatal: true,
        startedAt: performance.now(),
        trace: (input) => {
          critical.push(input)
          return false
        },
        destroy: () => destroyed++,
        report: () => {},
      })
    },
  })
  expect(fatalResult).toBeUndefined()
  expect(reported).toBe(startupFailure)
  expect(destroyed).toBe(1)
  expect(critical).toMatchObject([{ event: "phase", phase: "bootstrap.critical", outcome: "error" }])
  expect(() =>
    captureCriticalBootstrapStartup({
      workspace: () => {
        throw startupFailure
      },
      start: () => {
        throw new Error("critical requests must not start")
      },
      failed: (error) => {
        reportCriticalBootstrapFailure({
          error,
          fatal: false,
          startedAt: performance.now(),
          destroy: () => destroyed++,
          report: () => {},
        })
      },
    }),
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
  const criticalReady = sync.indexOf('event: "bootstrap.critical.ready"', ready)
  expect(criticalReady).toBeGreaterThan(ready)
  expect(app).not.toContain('event: "theme.settled"')
  const kvReady = theme.indexOf("if (!kv.ready || startupSettled) return")
  const authoritative = theme.indexOf("applyStartupTheme()", kvReady)
  const settled = theme.indexOf('event: "theme.settled"', authoritative)
  expect(kvReady).toBeGreaterThan(-1)
  expect(authoritative).toBeGreaterThan(kvReady)
  expect(settled).toBeGreaterThan(authoritative)
  expect(theme.indexOf('event: "theme.settled"', settled + 1)).toBe(-1)
  const apply = theme.indexOf("apply(mode)")
  const reconciled = theme.indexOf('event: "theme.reconciled"', apply)
  expect(reconciled).toBeGreaterThan(apply)
})

test("OpenTUI editing keys emit input acceptance only after content changes", async () => {
  async function scenario(input: {
    initial: string
    press: (app: Awaited<ReturnType<typeof testRender>>) => void
    cursorEnd?: boolean
    repeat?: boolean
  }) {
    const markers: TuiStartupTraceInput[] = []
    const startupInput = createTuiStartupInputTrace((event) => {
      markers.push(event)
      return false
    })
    const names: string[] = []
    let textarea!: TextareaRenderable
    const app = await testRender(() => (
      <textarea
        focused
        onKeyDown={(event) => {
          names.push(event.name)
          startupInput.key(event)
          if (event.name === "backspace") textarea.deleteCharBackward()
          if (event.name === "delete") textarea.deleteChar()
        }}
        onContentChange={() => startupInput.changed()}
        ref={(value) => {
          textarea = value
          startupInput.mount()
        }}
      />
    ))
    try {
      await app.renderOnce()
      textarea.setText(input.initial)
      await Bun.sleep(1)
      if (input.cursorEnd) textarea.gotoBufferEnd()
      expect(markers.map((event) => event.event)).toEqual(["prompt.mounted"])
      input.press(app)
      if (input.repeat) input.press(app)
      await Bun.sleep(1)
      return { markers, names, text: textarea.plainText }
    } finally {
      startupInput.cleanup()
      app.renderer.destroy()
    }
  }

  const space = await scenario({ initial: "", press: (app) => app.mockInput.pressKey(" "), repeat: true })
  expect(space.names).toEqual(["space", "space"])
  expect(space.text).toBe("  ")
  expect(space.markers.map((event) => event.event)).toEqual(["prompt.mounted", "input.accepted"])

  const backspace = await scenario({ initial: "x", cursorEnd: true, press: (app) => app.mockInput.pressBackspace() })
  expect(backspace.names).toEqual(["backspace"])
  expect(backspace.text).toBe("")
  expect(backspace.markers.map((event) => event.event)).toEqual(["prompt.mounted", "input.accepted"])

  const deleted = await scenario({
    initial: "x",
    press: (app) => app.mockInput.pressKey("DELETE"),
  })
  expect(deleted.names).toEqual(["delete"])
  expect(deleted.text).toBe("")
  expect(deleted.markers.map((event) => event.event)).toEqual(["prompt.mounted", "input.accepted"])

  const navigation = await scenario({ initial: "x", cursorEnd: true, press: (app) => app.mockInput.pressArrow("left") })
  expect(navigation.names).toEqual(["left"])
  expect(navigation.text).toBe("x")
  expect(navigation.markers.map((event) => event.event)).toEqual(["prompt.mounted"])

  const noop = await scenario({ initial: "x", cursorEnd: true, press: (app) => app.mockInput.pressKey("DELETE") })
  expect(noop.names).toEqual(["delete"])
  expect(noop.text).toBe("x")
  expect(noop.markers.map((event) => event.event)).toEqual(["prompt.mounted"])
})

test("theme settlement waits for persisted KV state", async () => {
  const originalWithLock = Flock.withLock.bind(Flock)
  let blockedState: string | undefined
  let readStarted!: () => void
  let releaseRead!: () => void
  const started = new Promise<void>((resolve) => (readStarted = resolve))
  const released = new Promise<void>((resolve) => (releaseRead = resolve))
  const flock = spyOn(Flock, "withLock")
  flock.mockImplementation(
    (async (key, fn, options) => {
      if (blockedState && key.includes(blockedState)) {
        readStarted()
        await released
      }
      return originalWithLock(key, fn, options)
    }) as typeof Flock.withLock,
  )

  async function scenario(input: {
    kv: Record<string, unknown>
    settled: "resolved" | "fallback-final"
    delayed?: boolean
  }) {
    const state = mkdtempSync(path.join(os.tmpdir(), "oc2-theme-settlement-"))
    writeFileSync(path.join(state, "kv.json"), JSON.stringify(input.kv))
    const traces: TuiStartupTraceInput[] = []

    if (input.delayed) blockedState = state
    const rendering = testRender(() => (
      <TestTuiContexts
        paths={{ state }}
        startupTrace={(event) => {
          traces.push(event)
          return false
        }}
      >
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark" settled={input.settled}>
              <box />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ))

    if (input.delayed) {
      await started
      expect(traces.filter((event) => event.event === "theme.settled")).toHaveLength(0)
      releaseRead()
      blockedState = undefined
    }
    const app = await rendering
    try {
      const before = performance.now()
      while (!traces.some((event) => event.event === "theme.settled")) {
        if (performance.now() - before > 2000) throw new Error("timed out waiting for theme settlement")
        await Bun.sleep(10)
      }
      return { traces }
    } finally {
      app.renderer.destroy()
      rmSync(state, { recursive: true, force: true })
    }
  }

  try {
    const locked = await scenario({
      kv: { theme: "dracula", theme_mode_lock: "light" },
      settled: "resolved",
      delayed: true,
    })
    const lockedSettled = locked.traces.filter((event) => event.event === "theme.settled")
    expect(lockedSettled).toHaveLength(1)
    expect(lockedSettled).toMatchObject([
      { outcome: "locked", workspaceGeneration: 0, attemptGeneration: 0 },
    ])
    expect(
      startupThemeState({
        lock: "light",
        savedMode: undefined,
        savedTheme: "dracula",
        rendererMode: "dark",
        fallbackMode: "dark",
      }),
    ).toMatchObject({ lock: "light", mode: "light", active: "dracula" })

    const resolved = await scenario({ kv: {}, settled: "resolved" })
    const resolvedSettled = resolved.traces.filter((event) => event.event === "theme.settled")
    expect(resolvedSettled).toHaveLength(1)
    expect(resolvedSettled).toMatchObject([{ outcome: "resolved" }])

    const fallback = await scenario({ kv: {}, settled: "fallback-final" })
    const fallbackSettled = fallback.traces.filter((event) => event.event === "theme.settled")
    expect(fallbackSettled).toHaveLength(1)
    expect(fallbackSettled).toMatchObject([{ outcome: "fallback-final" }])
  } finally {
    flock.mockRestore()
  }
})
