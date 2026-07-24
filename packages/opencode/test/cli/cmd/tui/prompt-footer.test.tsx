/** @jsxImportSource @opentui/solid */
import { describe, expect, mock, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createBindingLookup } from "@opentui/keymap/extras"
import { Global } from "@oc2-ai/core/global"
import { onMount } from "solid-js"
import { tmpdir } from "../../../fixture/fixture"

type PromptCommand = {
  name: string
  run(ctx: { event: { preventDefault(): void; stopPropagation(): void } }): void | Promise<void>
}

const promptCommands = new Map<string, PromptCommand>()

mock.module("../../../../../tui/src/keymap", () => ({
  OC2_BASE_MODE: "base",
  formatKeyBindings: () => "",
  OpencodeKeymapProvider: (props: { children: unknown }) => props.children,
  registerOpencodeKeymap: () => {},
  useBindings: (get: () => { commands?: PromptCommand[] }) => {
    for (const command of get().commands ?? []) promptCommands.set(command.name, command)
  },
  useCommandShortcut: (command: string) => () => (command === "command.palette.show" ? "ctrl+p" : "tab"),
  useCommandSlashes: () => () => [],
  useLeaderActive: () => () => false,
  useKeymapSelector: () => () => new Map(),
  useOpencodeModeStack: () => ({ push: () => () => {} }),
  useOpencodeKeymap: () => ({
    pending: () => [],
  }),
}))

mock.module("../../../../../tui/src/component/prompt/autocomplete", () => ({
  Autocomplete: () => <box />,
}))

mock.module("../../../../../tui/src/context/command-palette", () => ({
  CommandPaletteProvider: (props: { children: unknown }) => props.children,
  useCommandPalette: () => ({
    hide: () => {},
    matcher: { get: () => true },
    run: () => {},
    show: () => {},
    toggle: () => {},
    visible: () => false,
  }),
}))

const {
  ArgsProvider,
  ClipboardProvider,
  createEventSource,
  DialogProvider,
  directory,
  EditorContextProvider,
  json,
  KVProvider,
  LocalProvider,
  ProjectProvider,
  PromptHistoryProvider,
  PromptStashProvider,
  RouteProvider,
  SDKProvider,
  SyncProvider,
  TestTuiContexts,
  ThemeProvider,
  ToastProvider,
  TuiConfigProvider,
  useSync,
  wait,
  worktree,
} = await import("@oc2-ai/tui/testing")

const sessionID = "ses_prompt_footer"
const teammateID = "ses_prompt_footer_teammate"
const created = Date.now() - 62_000

const sessionPayload = {
  id: sessionID,
  title: "Prompt footer",
  time: { created, updated: created, processing: 62_000 },
  version: "1.0.0",
  directory,
  project_id: "proj_test",
  cost: 0.05,
}

const teammatePayload = {
  ...sessionPayload,
  id: teammateID,
  title: "Teammate",
  parentID: sessionID,
}

const messagesPayload = [
  {
    info: {
      id: "msg_assistant",
      role: "assistant",
      sessionID,
      providerID: "test",
      modelID: "model",
      mode: "build",
      path: { cwd: directory, root: worktree },
      cost: 0.05,
      tokens: {
        input: 1_000,
        output: 200,
        reasoning: 30,
        cache: { read: 400, write: 5 },
      },
      time: { created, completed: created + 1_000 },
    },
    parts: [],
  },
]

const fetchForPrompt = (async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input))

  switch (url.pathname) {
    case "/agent":
      return json([{ name: "build", mode: "primary", hidden: false }])
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
      return json({
        providers: [
          {
            id: "test",
            name: "Test",
            models: {
              model: {
                id: "model",
                name: "Model",
                limit: { context: 10_000 },
              },
            },
          },
        ],
        default: { test: "model" },
      })
    case "/experimental/console":
      return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
    case "/path":
      return json({ home: "", state: "", config: "", worktree, directory })
    case "/project/current":
      return json({ id: "proj_test" })
    case "/provider":
      return json({ all: [], default: {}, connected: [] })
    case "/session":
      return json([sessionPayload, teammatePayload])
    case `/session/${sessionID}`:
      return json(sessionPayload)
    case `/session/${sessionID}/root`:
      return json([])
    case `/session/${sessionID}/message`:
      return json(messagesPayload)
    case `/session/${sessionID}/todo`:
    case `/session/${sessionID}/diff`:
      return json([])
    case "/vcs":
      return json({ branch: "main" })
  }

  throw new Error(`unexpected request: ${url.pathname}`)
}) as typeof globalThis.fetch

async function mountPrompt(props: {
  sessionID?: string
  clipboard?: { read?(): Promise<{ data: string; mime: string } | undefined> }
}) {
  const { Prompt } = await import("../../../../../tui/src/component/prompt")
  const events = createEventSource()
  let sync!: ReturnType<typeof useSync>
  let prompt!: { reset(): void }
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSync()
    onMount(ready)
    return (
      <Prompt
        sessionID={props.sessionID}
        ref={(value) => {
          if (value) prompt = value
        }}
      />
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts paths={{ state: Global.Path.state }}>
        <ArgsProvider>
          <KVProvider>
            <ToastProvider>
              <RouteProvider
                initialRoute={props.sessionID ? { type: "session", sessionID: props.sessionID } : undefined}
              >
                <TuiConfigProvider
                  config={{
                    attention: {
                      enabled: false,
                      notifications: true,
                      sound: true,
                      volume: 0.4,
                      sound_pack: "",
                      sounds: {},
                    },
                    keybinds: createBindingLookup({}),
                    leader_timeout: 2_000,
                    mouse: true,
                  }}
                >
                  <SDKProvider url="http://test" directory={directory} fetch={fetchForPrompt} events={events.source}>
                    <ProjectProvider>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <LocalProvider>
                            <PromptStashProvider>
                              <DialogProvider>
                                <PromptHistoryProvider>
                                  <ClipboardProvider value={props.clipboard}>
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
    ),
    { width: 100, height: 8 },
  )

  await mounted
  await wait(() => sync.status === "complete")
  return { app, events, prompt, sync }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function paste() {
  const command = promptCommands.get("prompt.paste")
  if (!command) throw new Error("prompt paste command was not registered")
  return command.run({
    event: {
      preventDefault() {},
      stopPropagation() {},
    },
  })
}

describe("prompt footer", () => {
  test("shows clipboard feedback until an image is inserted", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const read = deferred<{ data: string; mime: string } | undefined>()
    const { app, prompt } = await mountPrompt({ clipboard: { read: () => read.promise } })

    try {
      const operation = paste()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Reading clipboard...")

      read.resolve({ data: "aGVsbG8=", mime: "image/png" })
      await operation
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("[Image 1]")
      expect(frame).not.toContain("Reading clipboard...")
    } finally {
      prompt.reset()
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("clears clipboard feedback after an empty read", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const empty = deferred<{ data: string; mime: string } | undefined>()
    const { app } = await mountPrompt({ clipboard: { read: () => empty.promise } })

    try {
      const emptyOperation = paste()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Reading clipboard...")
      empty.resolve(undefined)
      await emptyOperation
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("Reading clipboard...")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("clears clipboard feedback after a rejected read", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const failed = deferred<{ data: string; mime: string } | undefined>()
    const { app } = await mountPrompt({ clipboard: { read: () => failed.promise } })

    try {
      const operation = paste()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Reading clipboard...")
      failed.reject(new Error("clipboard failed"))
      await expect(operation).rejects.toThrow("clipboard failed")
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("Reading clipboard...")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("keeps clipboard feedback while overlapping reads remain", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const first = deferred<{ data: string; mime: string } | undefined>()
    const second = deferred<{ data: string; mime: string } | undefined>()
    const reads = [first.promise, second.promise]
    const { app } = await mountPrompt({ clipboard: { read: () => reads.shift() ?? Promise.resolve(undefined) } })

    try {
      const firstOperation = paste()
      const secondOperation = paste()
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Reading clipboard...")

      first.resolve(undefined)
      await firstOperation
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("Reading clipboard...")

      second.resolve(undefined)
      await secondOperation
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("Reading clipboard...")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("renders usage before commands when session is synced", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mountPrompt({ sessionID })

    try {
      await sync.session.sync(sessionID)
      expect(sync.data.message[sessionID]?.at(-1)).toMatchObject({
        role: "assistant",
        tokens: { output: 200 },
      })
      await app.renderOnce()
      const frame = app.captureCharFrame()

      expect(frame).toContain("1.6K (16%) · cache 400 read/5 write · $0.05")
      expect(frame).toContain("ctrl+p commands")
      expect(frame.indexOf("1.6K (16%) · cache 400 read/5 write · $0.05")).toBeLessThan(
        frame.indexOf("ctrl+p commands"),
      )
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("shows an idle lead as working while a direct teammate is busy", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const read = deferred<{ data: string; mime: string } | undefined>()
    const { app, events, sync } = await mountPrompt({ sessionID, clipboard: { read: () => read.promise } })

    try {
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain("team working")

      events.emit({
        directory,
        project: "proj_test",
        payload: {
          id: "event-team-member-completed",
          type: "team.member.updated",
          properties: { memberID: "member-teammate", sessionID: teammateID, status: "completed" },
        },
      })
      events.emit({
        directory,
        project: "proj_test",
        payload: {
          id: "event-teammate-busy",
          type: "session.status",
          properties: { sessionID: teammateID, status: { type: "busy" } },
        },
      })
      await wait(() => sync.data.session_status[teammateID]?.type === "busy")
      const operation = paste()
      await app.renderOnce()

      const frame = app.captureCharFrame()
      expect(frame).toContain("Reading clipboard...")
      expect(frame).toContain("team working")
      read.resolve(undefined)
      await operation
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
