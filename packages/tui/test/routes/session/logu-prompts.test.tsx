/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { JSX } from "solid-js"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2"
import { onCleanup } from "solid-js"
import { ProjectProvider } from "../../../src/context/project"
import { KVProvider } from "../../../src/context/kv"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncContext, useSync } from "../../../src/context/sync"
import { PathFormatterProvider } from "../../../src/context/path-format"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { QuestionPrompt } from "../../../src/routes/session/question"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("permission prompt renders logu child label and model", async () => {
  const app = await renderPrompt(() => <PermissionPrompt request={permissionRequest()} />, [loguChild()])
  try {
    await app.renderOnce()
    await Bun.sleep(50)
    await app.renderOnce()
    await app.waitForFrame((frame) => frame.includes("Permission required"))
    const frame = app.captureCharFrame()

    expect(frame).toContain("Permission required")
    expect(frame).toContain("Logu branch #1")
    expect(frame).toContain("openai/gpt-5.5")
  } finally {
    app.renderer.destroy()
  }
})

test("question prompt renders logu child label and model", async () => {
  const app = await renderPrompt(() => <QuestionPrompt request={questionRequest()} />, [loguChild()])
  try {
    await app.renderOnce()
    await Bun.sleep(50)
    await app.renderOnce()
    await app.waitForFrame((frame) => frame.includes("Pick one?"))
    const frame = app.captureCharFrame()

    expect(frame).toContain("Logu branch #1")
    expect(frame).toContain("openai/gpt-5.5")
    expect(frame).toContain("Pick one?")
    expect(frame).toContain("Yes")
  } finally {
    app.renderer.destroy()
  }
})

async function renderPrompt(render: () => JSX.Element, sessions: Session[]) {
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <TestTuiContexts directory="/repo">
        <SDKProvider url="http://test" directory="/repo" fetch={fetchStub} events={{ subscribe: async () => () => {} }}>
          <ProjectProvider>
            <OpencodeKeymapProvider keymap={keymap}>
              <TuiConfigProvider config={config}>
                <KVProvider>
                  <ThemeProvider mode="dark">
                    <SyncContext.Provider value={syncValue(sessions)}>
                      <PathFormatterProvider path="/repo">{render()}</PathFormatterProvider>
                    </SyncContext.Provider>
                  </ThemeProvider>
                </KVProvider>
              </TuiConfigProvider>
            </OpencodeKeymapProvider>
          </ProjectProvider>
        </SDKProvider>
      </TestTuiContexts>
    )
  }

  return testRender(() => <Harness />, { width: 120, height: 30, kittyKeyboard: true })
}

function syncValue(sessions: Session[]) {
  return {
    data: {
      session: sessions,
      part: {},
    },
    set() {},
    status: "complete",
    ready: true,
    path: { home: "/repo", state: "/repo/state", config: "/repo/config", worktree: "/repo", directory: "/repo" },
    session: {
      get(sessionID: string) {
        return sessions.find((session) => session.id === sessionID)
      },
      query: () => ({}),
      refresh: async () => {},
      refreshRoots: async () => [],
      status: () => "idle",
      sync: async () => {},
    },
    bootstrap: async () => {},
  } as unknown as ReturnType<typeof useSync>
}

function permissionRequest(): PermissionRequest {
  return {
    id: "perm-1",
    sessionID: "child",
    permission: "bash",
    patterns: [],
    metadata: {},
    always: [],
  }
}

function questionRequest(): QuestionRequest {
  return {
    id: "question-1",
    sessionID: "child",
    questions: [
      {
        header: "Choice",
        question: "Pick one?",
        options: [{ label: "Yes", description: "Confirm" }],
      },
    ],
  }
}

function loguChild(): Session {
  return {
    id: "child",
    slug: "child",
    projectID: "project",
    directory: "/repo",
    title: "Logu branch #1",
    version: "1",
    time: { created: 0, updated: 0 },
    metadata: {
      logu: {
        stage: "branch",
        index: 0,
        model: "openai/gpt-5.5",
        parentRunID: "parent",
        parentSessionID: "parent",
      },
    },
  }
}

const fetchStub = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input))
  if (url.pathname === "/session") return json([loguChild()])
  if (url.pathname === "/path") return json({ home: "/repo", state: "/repo/state", config: "/repo/config", worktree: "/repo", directory: "/repo" })
  if (url.pathname === "/project/current") return json({ id: "project", worktree: "/repo" })
  if (url.pathname === "/config") return json({})
  if (url.pathname === "/config/providers") return json({ all: [], default: {}, connected: [] })
  if (url.pathname === "/session/status") return json({})
  if (url.pathname === "/provider/auth") return json({})
  if (url.pathname === "/command") return json([])
  if (url.pathname === "/lsp") return json([])
  if (url.pathname === "/mcp") return json({})
  if (url.pathname === "/experimental/resource") return json({})
  if (url.pathname === "/formatter") return json([])
  if (url.pathname === "/vcs") return json(undefined)
  return json({})
}) as typeof fetch

function json(data: unknown) {
  return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } })
}
