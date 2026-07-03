/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../../fixture/fixture"
import {
  ArgsProvider,
  createEventSource,
  createFetch,
  createTuiResolvedConfig,
  DialogProvider,
  directory,
  json,
  KVProvider,
  LocalProvider,
  OpencodeKeymapProvider,
  ProjectProvider,
  registerOpencodeKeymap,
  RouteProvider,
  SDKProvider,
  SessionRootsCommand,
  SyncProvider,
  TestTuiContexts,
  ThemeProvider,
  ToastProvider,
  TuiConfigProvider,
  useCommandSlashes,
  wait,
} from "@opencode-ai/tui/testing"

const sessionID = "ses_roots_command"

test("registers /roots as soon as the current route is a session", async () => {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  const calls = createFetch((url: URL) => {
    if (url.pathname === `/session/${sessionID}`) {
      return json({
        id: sessionID,
        title: "Roots",
        time: { created: 1, updated: 1 },
        version: "1.0.0",
        directory,
        project_id: "proj_test",
        cost: 0,
      })
    }
  })
  let slashes!: ReturnType<typeof useCommandSlashes>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    slashes = useCommandSlashes()
    onMount(ready)
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TestTuiContexts paths={{ state: Global.Path.state }}>
          <ArgsProvider>
            <KVProvider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID }}>
                  <TuiConfigProvider config={config}>
                    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                      <ProjectProvider>
                        <SyncProvider>
                          <ThemeProvider mode="dark">
                            <LocalProvider>
                              <DialogProvider>
                                <SessionRootsCommand />
                                <Probe />
                              </DialogProvider>
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

  const app = await testRender(() => <Harness />)

  try {
    await mounted
    await wait(() => slashes().some((entry: { display: string }) => entry.display === "/roots"))
    const roots = slashes().find((entry: { display: string }) => entry.display === "/roots")

    expect(roots?.description).toBe("Manage roots")
    expect(roots?.aliases).toEqual(["/root", "/cwd", "/dirs"])
  } finally {
    app.renderer.destroy()
    Global.Path.state = previous
  }
})
