/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import type { SupervisorSettingsPatch, SupervisorState } from "@opencode-ai/sdk/v2"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { createExit, ExitProvider } from "../../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { RouteProvider } from "../../../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider } from "../../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../../src/cli/cmd/tui/context/tui-config"
import {
  OpencodeKeymapProvider,
  registerOpencodeKeymap,
  useCommandSlashes,
  useOpencodeKeymap,
} from "../../../../src/cli/cmd/tui/keymap"
import { SessionSupervisorCommand } from "../../../../src/cli/cmd/tui/routes/session"
import { DialogProvider } from "../../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider, useToast } from "../../../../src/cli/cmd/tui/ui/toast"
import { createEventSource, directory, json, wait } from "./sync-fixture"

const sessionID = "ses_supervisor_command"

test("registers /supervisor only for session routes", async () => {
  const session = await mount({ route: { type: "session", sessionID } })
  try {
    await wait(() => session.slashes().some((entry) => entry.display === "/supervisor"))
    expect(session.slashes().find((entry) => entry.display === "/supervisor")?.description).toBe(
      "Configure supervisor",
    )
  } finally {
    await session.cleanup()
  }

  const home = await mount({ route: { type: "home" } })
  try {
    expect(home.slashes().some((entry) => entry.display === "/supervisor")).toBe(false)
    home.keymap.dispatchCommand("session.supervisor")
    await wait(() => home.toast.currentToast?.variant === "error")
    expect(home.toast.currentToast?.message).toBe("Open a session to configure supervisor")
  } finally {
    await home.cleanup()
  }
})

test("sends API payloads for mode changes, reset, toggle, and runtime params", async () => {
  expect(
    await patchFrom((supervisor) => {
      supervisor.keymap.dispatchCommand("dialog.select.submit")
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.submit")
    }),
  ).toMatchObject({ mode: "observe" })

  expect(
    await patchFrom((supervisor) => {
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.submit")
    }),
  ).toMatchObject({ insert_recommendations: false })

  expect(
    await patchFrom((supervisor) => {
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.submit")
      supervisor.app.mockInput.pressEnter()
    }),
  ).toMatchObject({ recommendation_model: "test/supervisor" })

  expect(
    await patchFrom((supervisor) => {
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.submit")
      supervisor.app.mockInput.pressEnter()
    }),
  ).toMatchObject({ recommendation_variant: "fast" })

  expect(
    await patchFrom((supervisor) => {
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.submit")
      supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.submit")
    }),
  ).toMatchObject({ review_cadence: "event" })

  expect(
    await patchFrom((supervisor) => {
      for (let i = 0; i < 5; i++) supervisor.keymap.dispatchCommand("dialog.select.next")
      supervisor.keymap.dispatchCommand("dialog.select.submit")
      supervisor.app.mockInput.pressEnter()
    }),
  ).toMatchObject({ recommendation_timeout_ms: 15000 })

  expect(
    await patchFrom((supervisor) => {
      supervisor.keymap.dispatchCommand("dialog.select.end")
      supervisor.keymap.dispatchCommand("dialog.select.submit")
      supervisor.app.mockInput.pressEnter()
    }),
  ).toMatchObject({ reset: true })
})

test("shows error toast on local validation and API failure", async () => {
  const validation = await mount({ route: { type: "session", sessionID } })
  try {
    await open(validation)
    for (let i = 0; i < 5; i++) validation.keymap.dispatchCommand("dialog.select.next")
    validation.keymap.dispatchCommand("dialog.select.submit")
    await wait(() => validation.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = validation.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")
    textarea.clear()
    validation.app.mockInput.pressEnter()
    await wait(() => validation.toast.currentToast?.variant === "error")
    expect(validation.toast.currentToast?.message).toBe("Enter a positive integer")
    expect(validation.patches).toEqual([])
  } finally {
    await validation.cleanup()
  }

  const api = await mount({ route: { type: "session", sessionID }, failUpdates: true })
  try {
    await open(api)
    api.keymap.dispatchCommand("dialog.select.next")
    api.keymap.dispatchCommand("dialog.select.submit")
    await wait(() => api.toast.currentToast?.variant === "error")
    expect(api.toast.currentToast?.message).toContain("update failed")
  } finally {
    await api.cleanup()
  }
})

async function open(harness: Awaited<ReturnType<typeof mount>>) {
  await wait(() => harness.slashes().some((entry) => entry.display === "/supervisor"))
  const previousGets = harness.gets
  harness.slashes().find((entry) => entry.display === "/supervisor")?.onSelect()
  await wait(() => harness.gets > previousGets)
  await Bun.sleep(100)
}

async function patchFrom(action: (supervisor: Awaited<ReturnType<typeof mount>>) => void) {
  const supervisor = await mount({ route: { type: "session", sessionID } })
  try {
    await open(supervisor)
    action(supervisor)
    await wait(() => supervisor.patches.length > 0)
    return supervisor.patches[0]
  } finally {
    await supervisor.cleanup()
  }
}

async function mount(input: { route: { type: "session"; sessionID: string } | { type: "home" }; failUpdates?: boolean }) {
  const previous = Global.Path.state
  const tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const patches: SupervisorSettingsPatch[] = []
  let gets = 0
  let slashes!: ReturnType<typeof useCommandSlashes>
  let keymap!: ReturnType<typeof useOpencodeKeymap>
  let toast!: ReturnType<typeof useToast>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  const fetch = (async (request: RequestInfo | URL) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    const method = request instanceof Request ? request.method : "GET"
    if (url.pathname === `/session/${sessionID}/supervisor` && method === "GET") {
      gets++
      return json(state())
    }
    if (url.pathname === `/session/${sessionID}/supervisor` && method === "PATCH") {
      if (input.failUpdates) return json({ message: "update failed" }, { status: 400 })
      if (!(request instanceof Request)) throw new Error("expected request body")
      patches.push((await request.json()) as SupervisorSettingsPatch)
      return json(state())
    }
    if (url.pathname === "/session") return json([session()])
    if (url.pathname === `/session/${sessionID}`) return json(session())
    if (/^\/session\/[^/]+\/root$/.test(url.pathname)) return json([])
    switch (url.pathname) {
      case "/agent":
      case "/command":
      case "/experimental/workspace":
      case "/experimental/workspace/status":
      case "/formatter":
      case "/lsp":
        return json([])
      case "/config":
      case "/experimental/resource":
      case "/mcp":
      case "/provider/auth":
      case "/session/status":
        return json({})
      case "/config/providers":
        return json({ providers: {}, default: {} })
      case "/experimental/console":
        return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
      case "/path":
        return json({ home: "", state: "", config: "", worktree: "/tmp/opencode", directory })
      case "/project/current":
        return json({ id: "proj_test" })
      case "/provider":
        return json({ all: [], default: {}, connected: [] })
      case "/vcs":
        return json({ branch: "main" })
    }
    throw new Error(`unexpected request: ${url.pathname}`)
  }) as typeof globalThis.fetch

  function Probe() {
    slashes = useCommandSlashes()
    keymap = useOpencodeKeymap()
    toast = useToast()
    onMount(ready)
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const localKeymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(localKeymap, renderer, config)
    onCleanup(off)

    return (
      <OpencodeKeymapProvider keymap={localKeymap}>
        <ArgsProvider>
          <ExitProvider exit={createExit(async () => {})}>
            <KVProvider>
              <ToastProvider>
                <RouteProvider initialRoute={input.route}>
                  <TuiConfigProvider config={config}>
                    <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                      <ProjectProvider>
                        <SyncProvider>
                          <ThemeProvider mode="dark">
                            <DialogProvider>
                              <SessionSupervisorCommand />
                              <Probe />
                            </DialogProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </ProjectProvider>
                    </SDKProvider>
                  </TuiConfigProvider>
                </RouteProvider>
              </ToastProvider>
            </KVProvider>
          </ExitProvider>
        </ArgsProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />)
  await mounted

  return {
    app,
    get gets() {
      return gets
    },
    keymap,
    patches,
    slashes,
    toast,
    async cleanup() {
      app.renderer.destroy()
      Global.Path.state = previous
      await tmp[Symbol.asyncDispose]()
    },
  }
}

function session() {
  return {
    id: sessionID,
    title: "Supervisor",
    time: { created: 1, updated: 1 },
    version: "1.0.0",
    directory,
    project_id: "proj_test",
    cost: 0,
    supervisor: {
      mode: "advise" as const,
      recommendation_model: "test/supervisor",
      recommendation_variant: "fast",
      insert_recommendations: true,
      updatedAt: 1,
    },
  }
}

function state(): SupervisorState {
  return {
    sessionID,
    mode: "advise",
    config: {
      modeSource: "session",
      globalMode: "off",
      session: session().supervisor,
      effective: {
        mode: "advise",
        recommendation_model: "test/supervisor",
        recommendation_variant: "fast",
        recommendation_timeout_ms: 15000,
        review_cadence: "step",
        min_review_interval_ms: 10000,
        max_recommendation_chars: 800,
        max_repeated_command_failures: 3,
        broad_diff_file_limit: 5,
        sensitive_path_globs: [],
        validation_command_patterns: [],
        insert_recommendations: true,
        max_recommendations_per_session: 8,
      },
    },
    status: "on_track",
    filesTouched: [],
    commandsRun: [],
    validationsRun: [],
    risks: [],
    updatedAt: 1,
  }
}
