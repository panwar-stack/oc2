import type { Readable } from "node:stream"

import { createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core"
import { createElement, render, spread } from "@opentui/solid"

import type { CommandRegistry } from "../commands/types"
import type { Oc2Config } from "../config/schema"
import type { ModelProvider } from "../model/provider"
import { SessionView } from "./components/SessionView"
import type { TuiState } from "./state"

export interface TuiLaunchOptions {
  readonly config: Oc2Config
  readonly cwd: string
  readonly dataDir?: string
  readonly sessionId?: string
  readonly model?: string
  readonly roots?: readonly string[]
  readonly providers?: readonly ModelProvider[]
  readonly commands?: CommandRegistry
  readonly stdin?: Readable
  readonly stdout?: { readonly columns?: number; write(chunk: string): unknown }
}

export interface TuiRenderOptions {
  readonly width?: number
}

export const STATIC_TUI_SHELL_LABELS = {
  transcript: "oc2 transcript viewport",
  sidebar: "sidebar placeholder",
  footer: "footer placeholder",
  prompt: "prompt container - prompt submission disabled in renderer shell PR",
} as const

/** Renders the legacy minimal TUI snapshot as plain terminal text for tests. */
export function renderTui(state: TuiState, input = "", options: TuiRenderOptions = {}): string {
  return SessionView({ state, input, options })
}

/** Launches the static OpenTUI/Solid renderer shell for the PR 2 foundation slice. */
export async function launchTui(options: TuiLaunchOptions): Promise<void> {
  let renderer: CliRenderer | undefined
  let removeSighup: (() => void) | undefined

  try {
    const inputHandlers = [createExitInputHandler(() => destroyRenderer(renderer))]
    renderer = await createCliRenderer({
      stdin: options.stdin as NodeJS.ReadStream | undefined,
      stdout: options.stdout as NodeJS.WriteStream | undefined,
      externalOutputMode: "passthrough",
      targetFps: 60,
      gatherStats: false,
      exitOnCtrlC: false,
      useKittyKeyboard: {},
      autoFocus: false,
      openConsoleOnError: false,
      prependInputHandlers: inputHandlers,
    })

    const done = new Promise<void>((resolve) => renderer?.once("destroy", () => resolve()))
    const onSighup = () => destroyRenderer(renderer)
    process.on("SIGHUP", onSighup)
    removeSighup = () => process.off("SIGHUP", onSighup)

    await render(() => StaticTuiShell({ options }), renderer)
    await done
  } catch (error) {
    destroyRenderer(renderer)
    writeTerminalRestore(options.stdout)
    writeTerminalSafeError(`oc2 tui renderer failed: ${errorMessage(error)}`)
  } finally {
    removeSighup?.()
    destroyRenderer(renderer)
    writeTerminalRestore(options.stdout)
  }
}

function StaticTuiShell(props: { readonly options: TuiLaunchOptions }) {
  const width = Math.max(40, props.options.stdout?.columns ?? process.stdout.columns ?? 100)
  const showSidebar = props.options.config.tui.sidePanel && width >= 80
  const sidebarWidth = showSidebar ? Math.min(42, Math.max(24, width - 60)) : 0
  const labels = STATIC_TUI_SHELL_LABELS

  return tuiElement("box", { width, height: process.stdout.rows ?? 24, flexDirection: "column" }, [
    tuiElement("box", { flexGrow: 1, minHeight: 0, flexDirection: "row" }, [
      tuiElement("scrollbox", { flexGrow: 1, minWidth: 0 }, [tuiElement("text", { content: labels.transcript })]),
      ...(showSidebar
        ? [
            tuiElement("box", { width: sidebarWidth, flexShrink: 0, border: true }, [
              tuiElement("text", { content: labels.sidebar }),
            ]),
          ]
        : []),
    ]),
    tuiElement("box", { flexShrink: 0, border: true }, [tuiElement("text", { content: labels.footer })]),
    tuiElement("box", { flexShrink: 0, border: true }, [tuiElement("text", { content: labels.prompt })]),
  ])
}

function tuiElement(tag: string, props: Record<string, unknown>, children: unknown[] = []) {
  const element = createElement(tag)
  spread(element, { ...props, children })
  return element
}

function createExitInputHandler(exit: () => void): (sequence: string, event?: KeyEvent) => boolean {
  return (sequence, event) => {
    if (sequence === "\u0003" || sequence === "\u0004" || (event?.ctrl && (event.name === "c" || event.name === "d"))) {
      exit()
      return true
    }
    return false
  }
}

function destroyRenderer(renderer: CliRenderer | undefined): void {
  if (!renderer || renderer.isDestroyed) return
  try {
    renderer.setTerminalTitle("")
  } finally {
    renderer.destroy()
  }
}

function writeTerminalRestore(stdout: TuiLaunchOptions["stdout"]): void {
  try {
    ;(stdout ?? process.stdout).write("\x1b[0m\x1b[?25h")
  } catch {
    // Best-effort restoration only. The renderer error path prints a safe line separately.
  }
}

function writeTerminalSafeError(message: string): void {
  process.stderr.write(`${message.replace(/[\r\n]+/g, " ")}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
