import type { ITheme } from "ghostty-web"

const ANSI_FIELDS = [
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

const ANSI_FALLBACKS = [
  "--v2-background-bg-base",
  "--v2-state-fg-danger",
  "--v2-state-fg-success",
  "--v2-state-fg-warning",
  "--v2-text-text-accent",
  "--v2-state-fg-decision",
  "--v2-state-fg-tool",
  "--v2-text-text-muted",
  "--v2-text-text-faint",
  "--v2-state-fg-danger",
  "--v2-state-fg-success",
  "--v2-state-fg-warning",
  "--v2-text-text-accent",
  "--v2-state-fg-decision",
  "--v2-state-fg-tool",
  "--v2-text-text-base",
] as const

export function resolveTerminalTheme(read: (token: string) => string): Required<ITheme> {
  const value = (...tokens: string[]) =>
    tokens
      .map(read)
      .map((item) => item.trim())
      .find(Boolean) ?? ""
  const ansi = Object.fromEntries(
    ANSI_FIELDS.map((field, index) => [field, value(`--v2-terminal-ansi-${index}`, ANSI_FALLBACKS[index])]),
  ) as Record<(typeof ANSI_FIELDS)[number], string>

  return {
    foreground: value("--v2-terminal-foreground", "--v2-text-text-base"),
    background: value("--v2-terminal-background", "--v2-background-bg-base"),
    cursor: value("--v2-terminal-cursor", "--v2-text-text-base"),
    cursorAccent: value("--v2-terminal-cursor-accent", "--v2-background-bg-base"),
    selectionBackground: value("--v2-terminal-selection-background", "--v2-background-bg-layer-03"),
    selectionForeground: value("--v2-terminal-selection-foreground", "--v2-text-text-base"),
    ...ansi,
  }
}

export function terminalThemeFromElement(element: Element) {
  const style = getComputedStyle(element)
  return resolveTerminalTheme((token) => style.getPropertyValue(token))
}

export function observeTerminalTheme(element: Element, onChange: VoidFunction) {
  const observer = new MutationObserver(onChange)
  observer.observe(element, {
    attributes: true,
    attributeFilter: ["data-theme", "data-color-scheme"],
  })
  return () => observer.disconnect()
}

export function terminalCursorBlink(prefersReducedMotion: boolean) {
  return !prefersReducedMotion
}

export function terminalThemeSequence(theme: Required<ITheme>) {
  const color = (value: string) => {
    const hex = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
    if (hex) return `rgb:${hex[1]}/${hex[2]}/${hex[3]}`

    const rgb = value.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i)
    if (!rgb) return
    return `rgb:${Number(rgb[1]).toString(16).padStart(2, "0")}/${Number(rgb[2]).toString(16).padStart(2, "0")}/${Number(rgb[3]).toString(16).padStart(2, "0")}`
  }
  const osc = (code: string | number, value: string) => {
    const next = color(value)
    return next ? `\x1b]${code};${next}\x1b\\` : ""
  }

  return [
    ...ANSI_FIELDS.map((field, index) => osc(`4;${index}`, theme[field])),
    osc(10, theme.foreground),
    osc(11, theme.background),
    osc(12, theme.cursor),
  ].join("")
}
