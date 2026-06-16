import { expect, test } from "bun:test"

import { getDialogWidth } from "../../src/tui/primitives/Dialog"
import { formatRootLabel } from "../../src/tui/primitives/Footer"
import { DEFAULT_SIDEBAR_WIDTH, getSidebarWidth } from "../../src/tui/primitives/SidebarFrame"
import { toastColor } from "../../src/tui/primitives/Toast"
import {
  DEFAULT_TUI_THEME,
  THEME_FALLBACK_DIAGNOSTIC_CODE,
  resolveTuiTheme,
  validateTuiThemeJson,
} from "../../src/tui/theme"
import opencodeTheme from "../../src/tui/theme/assets/opencode.json"

test("resolves missing and explicit theme to vendored opencode", () => {
  const missing = resolveTuiTheme()
  const explicit = resolveTuiTheme({ theme: "opencode" })

  expect(missing.selectedTheme).toBe(DEFAULT_TUI_THEME)
  expect(missing.theme.name).toBe("opencode")
  expect(missing.diagnostics).toEqual([])
  expect(missing.toasts).toEqual([])
  expect(explicit.theme.primary).toBe(missing.theme.primary)
})

test("unknown theme falls back to opencode with warning toast and diagnostic", () => {
  const result = resolveTuiTheme({ theme: "solarized" })

  expect(result.selectedTheme).toBe("opencode")
  expect(result.diagnostics).toEqual([
    {
      code: THEME_FALLBACK_DIAGNOSTIC_CODE,
      message: 'Unknown TUI theme "solarized"; falling back to "opencode"',
    },
  ])
  expect(result.toasts[0]).toMatchObject({ variant: "warning", title: "Theme fallback" })
})

test("invalid injected theme falls back to opencode", () => {
  const result = resolveTuiTheme({ theme: "bad", themes: { bad: { theme: {} } } })

  expect(result.selectedTheme).toBe("opencode")
  expect(result.diagnostics[0]?.code).toBe(THEME_FALLBACK_DIAGNOSTIC_CODE)
  expect(result.diagnostics[0]?.message).toContain('Invalid TUI theme "bad"')
})

test("validates vendored opencode theme asset shape", () => {
  expect(validateTuiThemeJson("opencode", opencodeTheme)).toEqual({ ok: true })
  expect(validateTuiThemeJson("bad", { defs: {}, theme: {} }).ok).toBe(false)
})

test("formats root labels with home abbreviation and extra roots", () => {
  expect(formatRootLabel({ roots: ["/Users/test/project"], cwd: "/repo", home: "/Users/test" })).toBe("~/project")
  expect(formatRootLabel({ roots: ["/repo", "/other"], cwd: "/fallback", home: "/Users/test" })).toBe("/repo +1 roots")
  expect(formatRootLabel({ roots: [], cwd: "/fallback", home: "/Users/test" })).toBe("/fallback")
})

test("sidebar dialog and toast primitive helpers map theme and width", () => {
  const { theme } = resolveTuiTheme()

  expect(getSidebarWidth({ terminalWidth: 120, visible: true })).toBe(DEFAULT_SIDEBAR_WIDTH)
  expect(getSidebarWidth({ terminalWidth: 70, visible: true })).toBe(0)
  expect(getSidebarWidth({ terminalWidth: 120, visible: false })).toBe(0)
  expect(getDialogWidth({ terminalWidth: 50, size: "large" })).toBe(46)
  expect(toastColor(theme, "warning")).toBe(theme.warning)
})
