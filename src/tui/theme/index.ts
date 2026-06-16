import opencodeThemeJson from "./assets/opencode.json"

export const DEFAULT_TUI_THEME = "opencode"
export const THEME_FALLBACK_DIAGNOSTIC_CODE = "tui.theme.fallback"

export interface TuiTheme {
  readonly name: string
  readonly primary: string
  readonly secondary: string
  readonly accent: string
  readonly error: string
  readonly warning: string
  readonly success: string
  readonly info: string
  readonly text: string
  readonly textMuted: string
  readonly selectedListItemText: string
  readonly background: string
  readonly backgroundPanel: string
  readonly backgroundElement: string
  readonly backgroundMenu: string
  readonly border: string
  readonly borderActive: string
  readonly borderSubtle: string
  readonly diffAdded: string
  readonly diffRemoved: string
  readonly markdown: Record<string, string>
  readonly syntax: Record<string, string>
  readonly thinkingOpacity?: number
}

export interface TuiThemeToast {
  readonly id: string
  readonly variant: "info" | "success" | "warning" | "error"
  readonly title?: string
  readonly message: string
}

export interface TuiThemeDiagnostic {
  readonly code: string
  readonly message: string
}

export interface TuiThemeResolution {
  readonly requestedTheme?: string
  readonly selectedTheme: string
  readonly theme: TuiTheme
  readonly diagnostics: readonly TuiThemeDiagnostic[]
  readonly toasts: readonly TuiThemeToast[]
}

const REQUIRED_THEME_COLORS = [
  "primary",
  "secondary",
  "accent",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "background",
  "backgroundPanel",
  "backgroundElement",
  "border",
  "borderActive",
  "borderSubtle",
  "diffAdded",
  "diffRemoved",
] as const

const MARKDOWN_KEYS = [
  "Text",
  "Heading",
  "Link",
  "LinkText",
  "Code",
  "BlockQuote",
  "Emph",
  "Strong",
  "HorizontalRule",
  "ListItem",
  "ListEnumeration",
  "Image",
  "ImageText",
  "CodeBlock",
] as const

const SYNTAX_KEYS = [
  "Comment",
  "Keyword",
  "Function",
  "Variable",
  "String",
  "Number",
  "Type",
  "Operator",
  "Punctuation",
] as const

const SAFE_THEME: TuiTheme = {
  name: DEFAULT_TUI_THEME,
  primary: "#fab283",
  secondary: "#5c9cf5",
  accent: "#9d7cd8",
  error: "#e06c75",
  warning: "#f5a742",
  success: "#7fd88f",
  info: "#56b6c2",
  text: "#eeeeee",
  textMuted: "#808080",
  selectedListItemText: "#0a0a0a",
  background: "#0a0a0a",
  backgroundPanel: "#141414",
  backgroundElement: "#1e1e1e",
  backgroundMenu: "#282828",
  border: "#484848",
  borderActive: "#606060",
  borderSubtle: "#3c3c3c",
  diffAdded: "#4fd6be",
  diffRemoved: "#c53b53",
  markdown: {},
  syntax: {},
}

export function listTuiThemes(): readonly string[] {
  return [DEFAULT_TUI_THEME]
}

export function resolveTuiTheme(
  input: {
    readonly theme?: string
    readonly mode?: "dark" | "light"
    readonly themes?: Record<string, unknown>
  } = {},
): TuiThemeResolution {
  const requestedTheme = input.theme
  const selectedName = requestedTheme ?? DEFAULT_TUI_THEME
  const allThemes: Record<string, unknown> = {
    [DEFAULT_TUI_THEME]: opencodeThemeJson as unknown,
    ...(input.themes ?? {}),
  }
  const selected = allThemes[selectedName]
  if (!selected)
    return fallback(
      requestedTheme,
      `Unknown TUI theme "${selectedName}"; falling back to "${DEFAULT_TUI_THEME}"`,
      input,
    )

  const validation = validateTuiThemeJson(selectedName, selected)
  if (!validation.ok)
    return fallback(requestedTheme, `Invalid TUI theme "${selectedName}": ${validation.message}`, input)

  const normalized = normalizeTheme(selectedName, selected, input.mode ?? "dark")
  if (normalized) {
    return { requestedTheme, selectedTheme: selectedName, theme: normalized, diagnostics: [], toasts: [] }
  }
  return fallback(requestedTheme, `Invalid TUI theme "${selectedName}": failed to normalize theme`, input)
}

export function validateTuiThemeJson(
  name: string,
  value: unknown,
): { readonly ok: boolean; readonly message?: string } {
  if (!isRecord(value)) return { ok: false, message: `${name} must be an object` }
  if (!isRecord(value.defs)) return { ok: false, message: `${name}.defs must be an object` }
  if (!isRecord(value.theme)) return { ok: false, message: `${name}.theme must be an object` }
  for (const key of REQUIRED_THEME_COLORS) {
    const result = validateColorEntry(value.theme[key], value.defs)
    if (!result.ok) return { ok: false, message: `${name}.theme.${key} ${result.message}` }
  }
  for (const key of MARKDOWN_KEYS) {
    const result = validateColorEntry(value.theme[`markdown${key}`], value.defs)
    if (!result.ok) return { ok: false, message: `${name}.theme.markdown${key} ${result.message}` }
  }
  for (const key of SYNTAX_KEYS) {
    const result = validateColorEntry(value.theme[`syntax${key}`], value.defs)
    if (!result.ok) return { ok: false, message: `${name}.theme.syntax${key} ${result.message}` }
  }
  return { ok: true }
}

function fallback(
  requestedTheme: string | undefined,
  message: string,
  input: { readonly mode?: "dark" | "light"; readonly themes?: Record<string, unknown> },
): TuiThemeResolution {
  const fallbackTheme = normalizeTheme(DEFAULT_TUI_THEME, opencodeThemeJson, input.mode ?? "dark") ?? SAFE_THEME
  return {
    requestedTheme,
    selectedTheme: DEFAULT_TUI_THEME,
    theme: fallbackTheme,
    diagnostics: [{ code: THEME_FALLBACK_DIAGNOSTIC_CODE, message }],
    toasts: [{ id: THEME_FALLBACK_DIAGNOSTIC_CODE, variant: "warning", title: "Theme fallback", message }],
  }
}

function normalizeTheme(name: string, value: unknown, mode: "dark" | "light"): TuiTheme | undefined {
  if (!isRecord(value) || !isRecord(value.defs) || !isRecord(value.theme)) return undefined
  const defs = value.defs
  const themeJson = value.theme
  const color = (key: string) => resolveColor(themeJson[key], defs, mode)
  const markdown = Object.fromEntries(MARKDOWN_KEYS.map((key) => [lowerFirst(key), color(`markdown${key}`)]))
  const syntax = Object.fromEntries(SYNTAX_KEYS.map((key) => [lowerFirst(key), color(`syntax${key}`)]))
  const theme: TuiTheme = {
    name,
    primary: color("primary"),
    secondary: color("secondary"),
    accent: color("accent"),
    error: color("error"),
    warning: color("warning"),
    success: color("success"),
    info: color("info"),
    text: color("text"),
    textMuted: color("textMuted"),
    selectedListItemText: color("background"),
    background: color("background"),
    backgroundPanel: color("backgroundPanel"),
    backgroundElement: color("backgroundElement"),
    backgroundMenu: color("backgroundElement"),
    border: color("border"),
    borderActive: color("borderActive"),
    borderSubtle: color("borderSubtle"),
    diffAdded: color("diffAdded"),
    diffRemoved: color("diffRemoved"),
    markdown,
    syntax,
  }
  return theme
}

function resolveColor(entry: unknown, defs: Record<string, unknown>, mode: "dark" | "light"): string {
  const value = isRecord(entry) ? entry[mode] : entry
  return resolveColorValue(value, defs) ?? SAFE_THEME.text
}

function validateColorEntry(
  entry: unknown,
  defs: Record<string, unknown>,
): { readonly ok: boolean; readonly message?: string } {
  if (!isRecord(entry)) return { ok: false, message: "must have dark/light colors" }
  if (!resolveColorValue(entry.dark, defs)) return { ok: false, message: "must have a valid dark color" }
  if (!resolveColorValue(entry.light, defs)) return { ok: false, message: "must have a valid light color" }
  return { ok: true }
}

function resolveColorValue(value: unknown, defs: Record<string, unknown>): string | undefined {
  if (typeof value !== "string") return undefined
  const color = value.startsWith("#") ? value : defs[value]
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function lowerFirst(value: string): string {
  return `${value.slice(0, 1).toLowerCase()}${value.slice(1)}`
}
