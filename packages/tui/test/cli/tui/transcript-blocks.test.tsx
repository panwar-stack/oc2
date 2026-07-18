/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { createMockMouse } from "@opentui/core/testing"
import { testRender, type JSX } from "@opentui/solid"
import type { Renderable } from "@opentui/core"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { BUSY_GLYPH_FRAMES, reduceTuiMotion } from "../../../src/component/glyph"
import { ThinkingRow } from "../../../src/component/thinking-row"
import { ToolGroupHeader, ToolRow, toolRowDuration, v2ToolRowDuration } from "../../../src/component/tool-row"
import { TranscriptUserMessage } from "../../../src/component/user-message"
import { TurnFooter } from "../../../src/component/turn-footer"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

let renderer: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  renderer?.renderer.destroy()
  renderer = undefined
})

async function render(component: () => JSX.Element, height = 12) {
  renderer = await testRender(
    () => (
      <TestTuiContexts>
        <TuiConfigProvider config={createTuiResolvedConfig({ theme: "oc2" })}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <box width={76}>{component()}</box>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width: 76, height },
  )
  for (let index = 0; index < 100; index++) {
    await renderer.renderOnce()
    const frame = renderer.captureCharFrame()
    if (frame.trim()) return frame
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for transcript")
}

function ThinkingFixture() {
  const { subtleSyntax } = useTheme()
  return (
    <ThinkingRow
      id="thinking-row"
      title="Checking the implementation"
      trace="Secret-free reasoning trace"
      duration="1.5s"
      syntaxStyle={subtleSyntax()}
    />
  )
}

describe("TUI transcript blocks", () => {
  test("uses canonical busy frames and duration projections", () => {
    expect(BUSY_GLYPH_FRAMES).toEqual(["◐", "◑", "◓"])
    expect(reduceTuiMotion(true, "true")).toBe(true)
    expect(reduceTuiMotion(true, "0")).toBe(false)
    expect(reduceTuiMotion(false, "0")).toBe(true)
    expect(toolRowDuration({ time: { start: 1_000, end: 2_250 } })).toBe("1.3s")
    expect(toolRowDuration({ time: { start: 1_000 } }, 2_250)).toBe("1.3s")
    expect(v2ToolRowDuration({ created: 1_000, ran: 1_250, completed: 2_500 })).toBe("1.3s")
    expect(v2ToolRowDuration({ created: 1_000, ran: 1_250 }, 2_500)).toBe("1.3s")
  })

  test("renders aggregate-first safe rows without secret-prone payloads", async () => {
    const frame = await render(() => (
      <box>
        <ToolGroupHeader
          name="Tools"
          items={[{ status: "completed" }, { status: "running" }, { status: "error", error: "permission denied" }]}
        />
        <ToolRow
          id="web"
          width={76}
          status="completed"
          tool="webfetch"
          name="Web Fetch"
          input={{ url: "https://user:secret@example.com/docs?token=secret", headers: { Authorization: "secret" } }}
          duration="212ms"
        />
        <ToolRow
          id="shell"
          width={76}
          status="completed"
          tool="bash"
          name="Shell"
          input={{ command: "deploy sk-secret", env: { TOKEN: "secret" } }}
          metadata={{ exit: 0, output: "secret output" }}
        />
      </box>
    ))
    expect(frame).toContain("Tools")
    expect(frame).toContain("3 tool calls")
    expect(frame).toContain("Web Fetch")
    expect(frame).toContain("https://example.com/docs")
    expect(frame).toContain("212ms")
    expect(frame).toContain("Shell command · exit=0")
    expect(frame).not.toContain("sk-secret")
    expect(frame).not.toContain("Authorization")
  })

  test("keeps denied error detail collapsed until activation", async () => {
    let frame = await render(() => (
      <ToolRow
        id="denied-row"
        width={76}
        status="error"
        tool="bash"
        name="Shell"
        input={{ command: "secret command" }}
        error="permission denied for secret command"
      />
    ))
    const row = renderer!.renderer.root.findDescendantById("denied-row") as Renderable
    const mouse = createMockMouse(renderer!.renderer)
    expect(frame).toContain("permission denied")
    expect(frame).not.toContain("secret command")

    await mouse.click(row.screenX + 1, row.screenY)
    await renderer!.renderOnce()
    frame = renderer!.captureCharFrame()
    expect(frame).toContain("permission denied for secret command")
  })

  test("expands focused details without invoking the primary action", async () => {
    let activations = 0
    let frame = await render(() => (
      <ToolRow
        id="action-row"
        width={76}
        status="completed"
        tool="task"
        name="Task"
        input={{ subagent_type: "explore", session_id: "child-1" }}
        onActivate={() => activations++}
      >
        <text>Expanded detail</text>
      </ToolRow>
    ))
    const row = renderer!.renderer.root.findDescendantById("action-row") as Renderable
    expect(frame).not.toContain("Expanded detail")

    row.focus()
    renderer!.mockInput.pressKey("e", { ctrl: true })
    await renderer!.renderOnce()
    frame = renderer!.captureCharFrame()
    expect(frame).toContain("Expanded detail")
    expect(activations).toBe(0)

    renderer!.mockInput.pressEnter()
    await renderer!.renderOnce()
    expect(activations).toBe(1)
    expect(renderer!.captureCharFrame()).toContain("Expanded detail")
  })

  test("wires shell overflow activation through legacy and v2 block rows", async () => {
    const legacy = await Bun.file(new URL("../../../src/routes/session/index.tsx", import.meta.url)).text()
    const v2 = await Bun.file(new URL("../../../src/feature-plugins/system/session-v2.tsx", import.meta.url)).text()
    expect(legacy).toContain("onActivate={props.onClick}")
    expect(v2).toContain("onActivate={props.onClick}")
    expect(v2).toContain("focusable={Boolean(props.onClick)}")
    expect(v2).toContain("onKeyDown={key}")
  })

  test("exposes thinking summary, duration, and expandable trace", async () => {
    let frame = await render(() => <ThinkingFixture />)
    const row = renderer!.renderer.root.findDescendantById("thinking-row") as Renderable
    expect(frame).toContain("Thought")
    expect(frame).toContain("Checking the implementation")
    expect(frame).toContain("1.5s")
    expect(frame).not.toContain("Secret-free reasoning trace")

    row.focus()
    renderer!.mockInput.pressKey("e", { ctrl: true })
    for (let index = 0; index < 100; index++) {
      await renderer!.renderOnce()
      frame = renderer!.captureCharFrame()
      if (frame.includes("Secret-free reasoning trace")) break
      await Bun.sleep(10)
    }
    expect(frame).toContain("Secret-free reasoning trace")
  })

  test("renders canonical user and turn metadata blocks", async () => {
    const frame = await render(() => {
      const { theme } = useTheme()
      return (
        <box>
          <TranscriptUserMessage
            id="user"
            text="Implement transcript blocks"
            attachments={[{ kind: "ts", name: "message.tsx" }]}
            meta="14:02"
          />
          <TurnFooter agent="build" model="GPT-5.6 Sol" color={theme.primary} duration="2.4s" tokens={1234} />
        </box>
      )
    })
    expect(frame).toContain("Implement transcript blocks")
    expect(frame).toContain("you · 14:02 · ▤ 1 attached")
    expect(frame).toContain("Build · GPT-5.6 Sol · 2.4s · 1,234 tokens")
  })
})
