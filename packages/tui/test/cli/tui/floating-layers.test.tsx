/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { StateBlock } from "../../../src/component/state-block"
import { ErrorComponent } from "../../../src/component/error-component"
import { DEFAULT_THEMES, resolveTheme } from "../../../src/theme"
import { createToastStore, TOAST_GLYPHS } from "../../../src/ui/toast"

let app: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  app?.renderer.destroy()
  app = undefined
})

describe("TUI floating layers", () => {
  test("caps toast stacks, defaults to info, and keeps errors sticky", () => {
    const toast = createToastStore()
    toast.show({ message: "first" })
    toast.show({ message: "second", variant: "success" })
    toast.show({ message: "third", variant: "warning" })
    toast.show({ message: "fourth", variant: "error" })

    expect(toast.toasts).toHaveLength(3)
    expect(toast.toasts.map((item) => item.message)).toEqual(["second", "third", "fourth"])
    expect(toast.currentToast).toMatchObject({ variant: "error", persistent: true })
    expect(TOAST_GLYPHS).toEqual({ info: "▲", success: "✓", warning: "◐", error: "✕" })

    const timed = toast.show({ message: "timed error", variant: "error", duration: 20 })
    expect(toast.toasts.find((item) => item.id === timed)?.persistent).toBe(false)
    const current = toast.currentToast
    if (!current) throw new Error("expected current toast")
    toast.dismiss(current.id)
    expect(toast.toasts.some((item) => item.id === timed)).toBe(false)
    toast.dispose()
  })

  test("renders shared state glyph, title, and description grammar", async () => {
    const theme = resolveTheme(DEFAULT_THEMES.oc2, "dark")
    app = await testRender(
      () => (
        <StateBlock
          theme={theme}
          variant="error"
          title="Team data unavailable"
          description="Retry to load the latest state."
          scale="full"
        />
      ),
      { width: 70, height: 8 },
    )
    await app.renderOnce()

    const frame = app.captureCharFrame()
    expect(frame).toContain("✕")
    expect(frame).toContain("Team data unavailable")
    expect(frame).toContain("Retry to load the latest state.")
  })

  test("keeps the fatal state actionable on narrow terminals", async () => {
    for (const size of [
      { width: 30, height: 10 },
      { width: 20, height: 8 },
    ]) {
      app = await testRender(
        () => <ErrorComponent error={new Error("render failed")} reset={() => undefined} mode="dark" />,
        size,
      )
      await app.renderOnce()

      const frame = app.captureCharFrame()
      expect(frame).toContain("✕")
      expect(frame).toContain("A fatal error")
      expect(frame).toContain("render failed")
      expect(frame).toContain("Reset TUI")
      expect(frame).toContain("ctrl+c exit")
      app.renderer.destroy()
      app = undefined
    }
  })

  test("keeps dialog Escape restore and select focus/current distinction", async () => {
    const dialog = await Bun.file(new URL("../../../src/ui/dialog.tsx", import.meta.url)).text()
    const select = await Bun.file(new URL("../../../src/ui/dialog-select.tsx", import.meta.url)).text()
    const appSource = await Bun.file(new URL("../../../src/app.tsx", import.meta.url)).text()

    expect(dialog).toContain("backgroundColor={theme.scrim}")
    expect(dialog).toContain("focus = renderer.currentFocusedRenderable")
    expect(dialog).toContain("focus.focus()")
    expect(dialog).toContain('key: "escape"')
    expect(dialog).toContain("props.dismissible !== false")
    expect(select).toContain("option.bg ?? theme.primary")
    expect(select).toContain("selectedForeground(theme)")
    expect(select).toContain("props.current) return theme.primary")
    expect(select).toContain("TextAttributes.BOLD")
    expect(select).toContain("current !== undefined")
    expect(appSource).not.toContain('event.on("session.error"')
    expect(appSource).toContain("<Toast dialogActive={dialog.stack.length > 0} />")

    const toast = await Bun.file(new URL("../../../src/ui/toast.tsx", import.meta.url)).text()
    expect(toast).toContain('key: "escape"')
    expect(toast).toContain("toast.toasts.findLast")
    expect(toast).toContain("!props.dialogActive")
    expect(toast).toContain("onMouseUp={() => toast.dismiss(current.id)}")
    expect(toast).toContain('current.variant === "info" ? theme.accent')

    const confirm = await Bun.file(new URL("../../../src/ui/dialog-confirm.tsx", import.meta.url)).text()
    expect(confirm).toContain("props.destructive ? theme.error : theme.primary")
    expect(confirm).toContain("{ dismissible: options?.destructive !== true }")
  })
})
