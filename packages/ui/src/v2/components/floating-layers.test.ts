import { describe, expect, test } from "bun:test"
import { toastPresentation } from "../../components/toast-grammar"

const source = async (path: string) => Bun.file(`${import.meta.dir}/${path}`).text()
const legacy = async (path: string) => Bun.file(`${import.meta.dir}/../../components/${path}`).text()

describe("floating layer contracts", () => {
  test("uses canonical z-index and shadow tokens", async () => {
    const styles = await Promise.all([
      source("dialog-v2.css"),
      source("select-v2.css"),
      source("menu-v2.css"),
      source("toast-v2.css"),
      legacy("dialog.css"),
      legacy("select.css"),
      legacy("dropdown-menu.css"),
      legacy("context-menu.css"),
      legacy("toast.css"),
    ])
    const css = styles.join("\n")

    for (const token of ["--v2-z-scrim", "--v2-z-dialog", "--v2-z-popover", "--v2-z-select", "--v2-z-toast"])
      expect(css).toContain(`var(${token})`)
    expect(css).toContain("var(--v2-shadow-dialog)")
    expect(css).toContain("var(--v2-shadow-popover)")
    expect(css).not.toMatch(/z-index:\s*(?:50|60|100|1000)\s*;/)
  })

  test("keeps dialog sizing, accessible close controls, and focus semantics", async () => {
    const component = await source("dialog-v2.tsx")
    const context = await Bun.file(`${import.meta.dir}/../../context/dialog.tsx`).text()
    const css = await source("dialog-v2.css")
    const selectCss = await source("select-v2.css")

    for (const width of ["480px", "700px", "920px"]) expect(css).toContain(`min(92vw, ${width})`)
    expect(component).toContain("<Kobalte.Title")
    expect(component).toContain("<Kobalte.Description")
    expect(component).toContain('aria-label="Close"')
    expect(component).toContain('stroke="currentColor"')
    expect(context).toContain("modal")
    expect(context).toContain('event.key !== "Escape"')
    expect(context).toContain("escapeTargetsPopup(event.target)")
    expect(context).toContain("current.returnFocus?.isConnected")
    expect(context).toContain("returnFocusTarget()")
    expect(context).toContain("[aria-controls]")
    expect(context).toContain('element.getAttribute("aria-controls")')
    expect(component).toContain('aria-modal="true"')
    expect(component).toContain("onPointerDownOutside")
    expect(selectCss).toContain('[data-appearance="inline"]:where(:focus-within)')
    expect(selectCss).toContain("box-shadow: var(--v2-shadow-focus)")
  })

  test("maps toast variants through non-color glyphs and sticky error defaults", () => {
    expect(toastPresentation()).toEqual({ tone: "info", label: "Info", glyph: "▲", persistent: false })
    expect(toastPresentation("loading")).toEqual({
      tone: "warning",
      label: "Warning",
      glyph: "◐",
      persistent: false,
    })
    expect(toastPresentation("success").glyph).toBe("✓")
    expect(toastPresentation("error")).toEqual({ tone: "error", label: "Error", glyph: "✕", persistent: true })
    expect(toastPresentation("error", false).persistent).toBe(false)
  })

  test("caps both toast regions and exposes accessible state labels", async () => {
    for (const component of [await source("toast-v2.tsx"), await legacy("toast.tsx")]) {
      expect(component).toContain("limit={3}")
      expect(component).toContain('["altKey", "KeyN"]')
      expect(component).toContain('role={variant.tone === "error" ? "alert" : "status"}')
      expect(component).toContain('priority={variant.tone === "error" ? "high" : "low"}')
      expect(component).toContain("variant.label")
      expect(component).toContain("variant.glyph")
      expect(component).toContain("focusNewestToast")
    }
  })
})

describe("derived state block", () => {
  test("exposes empty, error, and loading semantics", async () => {
    const component = await source("state-block-v2.tsx")
    const css = await source("state-block-v2.css")

    expect(component).toContain('local.variant === "error" ? "alert"')
    expect(component).toContain('local.variant === "loading" ? "status"')
    expect(component).toContain('aria-busy={local.variant === "loading" ? "true" : undefined}')
    expect(component).toContain("<StatusGlyph")
    expect(css).toContain("max-width: 44ch")
    expect(css).toContain("var(--v2-state-border-danger)")
    expect(css).toContain("var(--v2-state-fg-thinking)")
  })
})
