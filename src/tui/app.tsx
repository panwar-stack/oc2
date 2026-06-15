import type { Readable } from "node:stream"

import { createBuiltinCommands } from "../commands/builtins"
import { createCommandRegistry } from "../commands/registry"
import type { SlashCommand } from "../commands/types"
import type { Oc2Config } from "../config/schema"
import { createRuntimeEventBus } from "../events/event-bus"
import type { ModelProvider } from "../model/provider"
import { createSessionRunService } from "../session/run"
import { parseTuiKey } from "./keymap"
import { SessionView } from "./components/SessionView"
import {
  appendLocalMessage,
  clearMessages,
  closeActivePanel,
  completeTuiRun,
  createInitialTuiState,
  failTuiRun,
  hydrateTuiState,
  projectTuiEvent,
  setSlashState,
  toggleAgentPanel,
  toggleMcpPanel,
  toggleSidePanel,
  toggleSessionList,
  toggleTeamPanel,
  type SlashMatch,
  type TuiState,
} from "./state"

export interface TuiLaunchOptions {
  readonly config: Oc2Config
  readonly cwd: string
  readonly dataDir?: string
  readonly sessionId?: string
  readonly model?: string
  readonly roots?: readonly string[]
  readonly providers?: readonly ModelProvider[]
  readonly stdin?: Readable
  readonly stdout?: { readonly columns?: number; write(chunk: string): unknown }
}

export interface TuiRenderOptions {
  readonly width?: number
}

/** Renders the minimal TUI snapshot as plain terminal text for both runtime and tests. */
export function renderTui(state: TuiState, input = "", options: TuiRenderOptions = {}): string {
  return SessionView({ state, input, options })
}

/** Launches the dependency-free terminal UI adapter over the session run service. */
export async function launchTui(options: TuiLaunchOptions): Promise<void> {
  const eventBus = createRuntimeEventBus<TuiState>({
    initialState: createInitialTuiState(options.config.tui.sidePanel),
    projector: projectTuiEvent,
  })
  let questionAnswer: ((value: unknown) => void) | undefined
  const service = createSessionRunService({
    config: options.config,
    cwd: options.cwd,
    dataDir: options.dataDir,
    events: eventBus,
    providers: options.providers,
    resolveQuestion: async (_question, signal) => {
      return await new Promise<unknown>((resolve) => {
        questionAnswer = resolve
        signal.addEventListener(
          "abort",
          () => {
            questionAnswer = undefined
            resolve(undefined)
          },
          { once: true },
        )
      })
    },
  })
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  let state = eventBus.getState()
  let input = ""
  let activeRun: AbortController | undefined
  let exitTui: (() => void) | undefined
  let escapePrefix = false

  if (options.sessionId) {
    const messages = service.sessions.messages.listBySession(options.sessionId)
    const tools = service.sessions.toolCalls.listBySession(options.sessionId)
    state = hydrateTuiState({ ...state, sessionId: options.sessionId }, messages, tools)
  }

  const render = () => {
    stdout.write(`\x1b[2J\x1b[H${renderTui(state, input, { width: stdout.columns })}\n`)
  }
  const unsubscribe = eventBus.all((event) => {
    state = projectTuiEvent(state, event)
    render()
  })

  const registry = createCommandRegistry(createBuiltinCommands())
  const clearSlash = () => {
    state = setSlashState(state, { slashActive: false, slashQuery: "", slashMatches: [] })
  }
  const resetInput = () => {
    input = ""
    clearSlash()
  }
  const updateSlashState = () => {
    if (!input.startsWith("/") || /\s/.test(input.slice(1))) {
      clearSlash()
      return
    }

    const slashQuery = input.slice(1)
    state = setSlashState(state, {
      slashActive: true,
      slashQuery,
      slashMatches: registry.search(slashQuery).map(toSlashMatch),
    })
  }
  const registerTuiCommands = () => {
    for (const command of createTuiCommands({
      help: () => {
        state = appendLocalMessage(state, "assistant", HELP_TEXT)
      },
      clear: () => {
        state = clearMessages(state)
      },
      skills: () => {
        state = appendLocalMessage(state, "assistant", SKILLS_TEXT)
      },
      exit: () => exitTui?.(),
    })) {
      registry.register(command)
    }
  }
  registerTuiCommands()

  const submit = async () => {
    const prompt = input.trim()
    if (state.questionPrompt && questionAnswer) {
      resetInput()
      const answer = prompt || undefined
      const resolve = questionAnswer
      questionAnswer = undefined
      resolve(answer)
      render()
      return
    }
    if (!prompt || state.running) return
    const slashCommand = parseSlashCommand(prompt)
    if (slashCommand) {
      const command = registry.get(slashCommand.name)
      if (command?.source === "tui" && command.onExecute) {
        resetInput()
        command.onExecute()
        render()
        return
      }
      if (command) {
        resetInput()
        state = appendLocalMessage(
          state,
          "assistant",
          `Backend slash command /${command.name} is not wired yet. Session command execution is implemented in PR 3.`,
        )
        render()
        return
      }
    }

    resetInput()
    state = appendLocalMessage(state, "user", prompt)
    const runController = new AbortController()
    activeRun = runController
    render()
    try {
      const result = await service.run({
        prompt,
        sessionId: state.sessionId,
        model: options.model,
        roots: options.roots,
        signal: runController.signal,
      })
      state = completeTuiRun(state, result, runController.signal.aborted)
    } catch (error) {
      state = failTuiRun(state, error, runController.signal.aborted)
    } finally {
      if (activeRun === runController) activeRun = undefined
    }
    render()
  }

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    unsubscribe()
    if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") stdin.setRawMode(false)
    stdin.pause()
    service.database?.close()
  }

  render()
  if ("setRawMode" in stdin && typeof stdin.setRawMode === "function") stdin.setRawMode(true)
  stdin.setEncoding("utf8")
  stdin.resume()

  await new Promise<void>((resolve) => {
    exitTui = () => {
      cleanup()
      resolve()
    }

    const handleKey = (key: ReturnType<typeof parseTuiKey>, raw: string): boolean => {
      if (key.action === "cancel") {
        if (activeRun) {
          activeRun.abort(new Error("Cancelled from TUI"))
          activeRun = undefined
          state = { ...state, running: false, status: "cancelled" }
          render()
          return false
        }
        cleanup()
        resolve()
        return true
      }
      if (raw === "\r" && !input.trim() && !state.questionPrompt) {
        state = toggleMcpPanel(state)
        render()
        return false
      }

      if (key.action === "toggle-side-panel") state = toggleSidePanel(state)
      else if (key.action === "toggle-team-panel") state = toggleTeamPanel(state)
      else if (key.action === "toggle-mcp-panel") state = toggleMcpPanel(state)
      else if (key.action === "toggle-agent-panel") state = toggleAgentPanel(state)
      else if (key.action === "clear-messages") state = clearMessages(state)
      else if (key.action === "session-switcher") state = toggleSessionList(state)
      else if (key.action === "escape") {
        if (state.slashActive) {
          clearSlash()
        } else if (questionAnswer) {
          const answerQuestion = questionAnswer
          questionAnswer = undefined
          answerQuestion(undefined)
          state = closeActivePanel(state)
        } else {
          state = closeActivePanel(state)
        }
      } else if (key.action === "backspace") {
        input = input.slice(0, -1)
        updateSlashState()
      } else if (key.action === "input") {
        input += key.value ?? ""
        updateSlashState()
      } else if (key.action === "newline") {
        input += "\n"
        updateSlashState()
      } else if (key.action === "tab") {
        if (state.slashActive && state.slashMatches.length > 0) {
          input = `${state.slashMatches[0]?.display} `
          clearSlash()
        }
      } else if (key.action === "submit") {
        void submit()
      }
      render()
      return false
    }

    stdin.on("data", (chunk: string) => {
      if (chunk === "\u001b") {
        escapePrefix = true
        return
      }

      const chunkKey = parseTuiKey(chunk)
      if (chunkKey.action !== "input" && chunkKey.action !== "noop") {
        handleKey(chunkKey, chunk)
        return
      }

      for (const char of chunk) {
        if (escapePrefix) {
          escapePrefix = false
          const escaped = parseTuiKey(`\u001b${char}`)
          if (escaped.action !== "noop") {
            if (handleKey(escaped, `\u001b${char}`)) return
            continue
          }
          if (handleKey(parseTuiKey("\u001b"), "\u001b")) return
        }

        if (char === "\u001b") {
          escapePrefix = true
          continue
        }

        if (handleKey(parseTuiKey(char), char)) return
      }
    })
  })
}

const HELP_TEXT = [
  "Slash commands:",
  "  /help show keybindings",
  "  /clear clear visible messages",
  "  /skills list bundled skills",
  "  /exit exit the TUI",
  "Keybindings:",
  "  Ctrl+S side panel | Ctrl+T team | Ctrl+M mcp | Ctrl+A agent",
  "  Ctrl+L clear | Ctrl+R sessions | Alt+Enter newline | Tab complete slash",
].join("\n")

const SKILLS_TEXT = [
  "Bundled skills:",
  "  clarify",
  "  initialize",
  "  spec-implement",
  "  spec-planner",
  "  team-report",
].join("\n")

const createTuiCommands = (handlers: {
  readonly help: () => void
  readonly clear: () => void
  readonly skills: () => void
  readonly exit: () => void
}): readonly SlashCommand[] => [
  { name: "help", description: "show keybindings", source: "tui", onExecute: handlers.help },
  { name: "exit", description: "exit the TUI", aliases: ["quit", "q"], source: "tui", onExecute: handlers.exit },
  { name: "clear", description: "clear visible messages", source: "tui", onExecute: handlers.clear },
  { name: "skills", description: "list available skills", source: "tui", onExecute: handlers.skills },
]

const toSlashMatch = (command: SlashCommand): SlashMatch => ({
  name: command.name,
  display: `/${command.name}`,
  description: command.description,
  source: command.source,
})

const parseSlashCommand = (prompt: string): { readonly name: string; readonly arguments: string } | undefined => {
  if (!prompt.startsWith("/")) return undefined
  const body = prompt.slice(1)
  const [name = "", ...rest] = body.split(/\s+/)
  if (!name) return undefined
  return { name, arguments: rest.join(" ") }
}
