import { describe, expect, test } from "bun:test"
import { Ghostty, Terminal } from "ghostty-web"
import {
  observeTerminalTheme,
  resolveTerminalTheme,
  terminalCursorBlink,
  terminalThemeFromElement,
  terminalThemeSequence,
} from "./terminal-theme"

const fields = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const

const modes = {
  light: {
    background: "#ffffff",
    foreground: "#161b24",
    ansi: [
      "#161b24",
      "#be3830",
      "#1c6e40",
      "#8f5a0e",
      "#2e5bb8",
      "#6d4fc2",
      "#0c6e67",
      "#e9edf4",
      "#67717f",
      "#852722",
      "#144d2d",
      "#643f0a",
      "#204081",
      "#4c3788",
      "#084d48",
      "#ffffff",
    ],
  },
  dark: {
    background: "#0a0d12",
    foreground: "#e8ebf0",
    ansi: [
      "#0a0d12",
      "#e5534b",
      "#43b26f",
      "#e8a33d",
      "#5b93ff",
      "#a78bfa",
      "#3ebdb4",
      "#9aa4b2",
      "#5c6675",
      "#ee8f8a",
      "#85cda1",
      "#f0c381",
      "#94b9ff",
      "#c6b4fc",
      "#82d4ce",
      "#e8ebf0",
    ],
  },
} as const

describe("terminal theme", () => {
  test("disables cursor blink when reduced motion is requested", () => {
    expect(terminalCursorBlink(false)).toBe(true)
    expect(terminalCursorBlink(true)).toBe(false)
  })

  for (const [mode, expected] of Object.entries(modes)) {
    test(`maps canonical ${mode} colors and all ANSI fields`, () => {
      const tokens = new Map<string, string>([
        ["--v2-terminal-background", expected.background],
        ["--v2-terminal-foreground", expected.foreground],
        ["--v2-terminal-cursor", expected.foreground],
        ["--v2-terminal-cursor-accent", expected.background],
        ["--v2-terminal-selection-background", "rgba(1, 2, 3, 0.22)"],
        ["--v2-terminal-selection-foreground", expected.foreground],
        ...expected.ansi.map((color, index) => [`--v2-terminal-ansi-${index}`, color] as const),
      ])
      const theme = resolveTerminalTheme((token) => tokens.get(token) ?? "")

      expect(theme.background).toBe(expected.background)
      expect(theme.foreground).toBe(expected.foreground)
      expect(fields.map((field) => theme[field])).toEqual([...expected.ansi])
    })
  }

  test("falls back through resolved semantic CSS tokens for legacy themes", () => {
    const tokens = new Map<string, string>([
      ["--v2-background-bg-base", "base"],
      ["--v2-background-bg-layer-03", "raised"],
      ["--v2-text-text-base", "text"],
      ["--v2-text-text-muted", "muted"],
      ["--v2-text-text-faint", "faint"],
      ["--v2-text-text-accent", "accent"],
      ["--v2-state-fg-danger", "danger"],
      ["--v2-state-fg-success", "success"],
      ["--v2-state-fg-warning", "warning"],
      ["--v2-state-fg-decision", "decision"],
      ["--v2-state-fg-tool", "tool"],
    ])
    const theme = resolveTerminalTheme((token) => tokens.get(token) ?? "")

    expect(theme).toMatchObject({
      background: "base",
      foreground: "text",
      cursor: "text",
      cursorAccent: "base",
      selectionBackground: "raised",
      selectionForeground: "text",
      red: "danger",
      green: "success",
      yellow: "warning",
      blue: "accent",
      magenta: "decision",
      cyan: "tool",
    })
  })

  test("emits runtime updates for defaults and all 16 ANSI slots", () => {
    const expected = modes.dark
    const tokens = new Map<string, string>([
      ["--v2-terminal-background", expected.background],
      ["--v2-terminal-foreground", expected.foreground],
      ["--v2-terminal-cursor", expected.foreground],
      ...expected.ansi.map((color, index) => [`--v2-terminal-ansi-${index}`, color] as const),
    ])
    const sequence = terminalThemeSequence(resolveTerminalTheme((token) => tokens.get(token) ?? ""))

    for (let index = 0; index < 16; index++) expect(sequence).toContain(`\x1b]4;${index};rgb:`)
    expect(sequence).toContain("\x1b]10;rgb:e8/eb/f0")
    expect(sequence).toContain("\x1b]11;rgb:0a/0d/12")
    expect(sequence).toContain("\x1b]12;rgb:e8/eb/f0")
  })

  test("updates existing Ghostty ANSI and default-colored cells", async () => {
    const tokenMap = (mode: keyof typeof modes) =>
      new Map<string, string>([
        ["--v2-terminal-background", modes[mode].background],
        ["--v2-terminal-foreground", modes[mode].foreground],
        ["--v2-terminal-cursor", modes[mode].foreground],
        ...modes[mode].ansi.map((color, index) => [`--v2-terminal-ansi-${index}`, color] as const),
      ])
    const lightTokens = tokenMap("light")
    const darkTokens = tokenMap("dark")
    const light = resolveTerminalTheme((token) => lightTokens.get(token) ?? "")
    const dark = resolveTerminalTheme((token) => darkTokens.get(token) ?? "")
    const terminal = new Terminal({ ghostty: await Ghostty.load(), cols: 4, rows: 2, theme: light })
    const container = document.createElement("div")
    document.body.append(container)
    terminal.open(container)
    await new Promise<void>((resolve) => terminal.write("\x1b[31mA\x1b[0mB", resolve))

    await new Promise<void>((resolve) => terminal.write(terminalThemeSequence(dark), resolve))

    expect(terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(0xe5534b)
    expect(terminal.buffer.active.getLine(0)?.getCell(1)?.getFgColor()).toBe(0xe8ebf0)
    terminal.dispose()
    container.remove()
  })

  test("reacts to resolved root theme attribute changes", async () => {
    const root = document.documentElement
    const previousStyle = root.style.cssText
    const previousScheme = root.dataset.colorScheme
    const tokens = (mode: keyof typeof modes) =>
      new Map<string, string>([
        ["--v2-terminal-background", modes[mode].background],
        ["--v2-terminal-foreground", modes[mode].foreground],
        ["--v2-terminal-cursor", modes[mode].foreground],
        ["--v2-terminal-cursor-accent", modes[mode].background],
        ["--v2-terminal-selection-background", modes[mode].ansi[7]],
        ["--v2-terminal-selection-foreground", modes[mode].foreground],
        ...modes[mode].ansi.map((color, index) => [`--v2-terminal-ansi-${index}`, color] as const),
      ])
    const apply = (values: Map<string, string>) => {
      for (const [token, value] of values) root.style.setProperty(token, value)
    }
    apply(tokens("light"))

    const terminal = new Terminal({
      ghostty: await Ghostty.load(),
      cols: 4,
      rows: 2,
      theme: terminalThemeFromElement(root),
    })
    const container = document.createElement("div")
    document.body.append(container)
    terminal.open(container)
    await new Promise<void>((resolve) => terminal.write("\x1b[31mA\x1b[0mB", resolve))

    const changed = new Promise<void>((resolve) => {
      const stop = observeTerminalTheme(root, () => {
        const theme = terminalThemeFromElement(root)
        terminal.renderer?.setTheme(theme)
        terminal.write(terminalThemeSequence(theme), () => {
          stop()
          resolve()
        })
      })
    })
    apply(tokens("dark"))
    root.dataset.colorScheme = "dark"
    await changed

    expect(terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(0xe5534b)
    expect(terminal.buffer.active.getLine(0)?.getCell(1)?.getFgColor()).toBe(0xe8ebf0)
    terminal.dispose()
    container.remove()
    root.style.cssText = previousStyle
    if (previousScheme) root.dataset.colorScheme = previousScheme
    else delete root.dataset.colorScheme
  })

  test("keeps terminal colors tokenized and defaults to standard JetBrains Mono", async () => {
    const terminal = await Bun.file(import.meta.dir + "/terminal.tsx").text()
    const appCss = await Bun.file(import.meta.dir + "/../index.css").text()
    const settings = await Bun.file(import.meta.dir + "/../context/settings.tsx").text()
    const themeCss = await Bun.file(import.meta.dir + "/../../../ui/src/v2/styles/theme.css").text()

    expect(terminal).not.toMatch(/#[\da-f]{3,8}\b/i)
    expect(terminal).toContain('window.matchMedia("(prefers-reduced-motion: reduce)")')
    expect(terminal).toContain('reducedMotion.addEventListener("change", handleReducedMotion)')
    expect(themeCss).toContain("--v2-terminal-background: var(--v2-background-bg-base)")
    expect(themeCss.match(/--v2-terminal-ansi-\d+:/g)).toHaveLength(32)
    expect(appCss.match(/font-display: swap/g)).toHaveLength(3)
    expect(appCss).not.toMatch(/url\(["']?https?:/)
    expect(settings).toContain('terminalDefault = "JetBrains Mono"')
    expect(appCss).toContain("/assets/fonts/JetBrainsMonoVariable-Latin.woff2")
  })
})
