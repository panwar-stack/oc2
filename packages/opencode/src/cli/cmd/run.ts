import type { PermissionV1 } from "@oc2-ai/core/v1/permission"
// CLI entry point for `opencode run`.
//
// Handles three modes:
//   1. Non-interactive (default): sends a single prompt, streams events to
//      stdout, and exits when the session goes idle.
//   2. Interactive local (`--interactive`): boots the split-footer direct mode
//      with an in-process server (no external HTTP).
//   3. Interactive attach (`--interactive --attach`): connects to a running
//      opencode server and runs interactive mode against it.
//
// Also supports `--command` for slash-command execution, `--format json` for
// raw event streaming, `--continue` / `--session` for session resumption,
// and `--fork` for forking before continuing.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { Cause, Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { createOpencodeClient, type OpencodeClient, type ToolPart } from "@oc2-ai/sdk/v2"
import { FormatError, FormatUnknownError } from "../error"
import { INTERACTIVE_INPUT_ERROR, resolveInteractiveStdin } from "./run/runtime.stdin"
import { sniffAttachmentMime } from "@/util/media"

type ModelInput = Parameters<OpencodeClient["session"]["prompt"]>[0]["model"]

function pick(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  } as ModelInput
}

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

type FilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

type AutomationError =
  | "invalid_input"
  | "invalid_agent"
  | "invalid_model"
  | "invalid_variant"
  | "invalid_command"
  | "permission_denied"
  | "tool_error"
  | "provider_error"
  | "session_error"
  | "cancelled"
  | "timeout"

type AutomationResult =
  | { status: "ok"; sessionID: string; text: string }
  | { status: "error"; sessionID: string | null; error: AutomationError }

const automationResultMarker = Symbol.for("oc2.cli.automationResultEmitted")

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

async function tool(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    if (next.mode === "block") {
      block(next, next.body)
      return
    }

    inline(next)
  } catch {
    inline({
      icon: "\u2699",
      title: part.tool,
    })
  }
}

async function toolError(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    inline({
      icon: "✗",
      title: `${next.title} failed`,
      ...(next.description && { description: next.description }),
    })
    return
  } catch {
    inline({
      icon: "✗",
      title: `${part.tool} failed`,
    })
  }
}

export const RunCommand = effectCmd({
  command: "run [message..]",
  describe: "run oc2 with a message",
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) =>
    args.attach === undefined &&
    !(args.automation && (args.session !== undefined || args.continue || args.fork)),
  automationSafe: (args) => args.automation,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json", "result-json"],
        default: "default",
        describe: "format: default (formatted), json (raw JSON events), or result-json (automation result)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running oc2 server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OC2_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username (defaults to OC2_SERVER_USERNAME or 'oc2')",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("replay", {
        type: "boolean",
        default: true,
        describe: "replay interactive session history on resume and after resize (use --no-replay to disable)",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible interactive replay to the newest N messages",
      })
      .option("interactive", {
        alias: ["i"],
        type: "boolean",
        describe: "run in direct interactive split-footer mode",
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("automation", {
        type: "boolean",
        describe: "run with explicit, fail-closed automation identity and failure handling",
        default: false,
      })
      .option("demo", {
        type: "boolean",
        default: false,
        describe: "enable direct interactive demo slash commands; pass one as the message to run it immediately",
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    if (
      args.automation &&
      (args.session !== undefined || args.continue || args.fork || args.attach !== undefined)
    ) {
      if (args.format === "result-json") {
        Reflect.set(process, automationResultMarker, true)
        process.exitCode = 2
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              process.stdout.write(
                JSON.stringify({ status: "error", sessionID: null, error: "invalid_input" }) + EOL,
                (error) => (error ? reject(error) : resolve()),
              )
            }),
        )
      } else UI.error("--automation cannot be used with --session, --continue, --fork, or --attach")
      process.exit(2)
    }

    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { EffectBridge } = yield* Effect.promise(() => import("@/effect/bridge"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const agentSvc = yield* Agent.Service
    const providerSvc = yield* Provider.Service
    const bridge = yield* EffectBridge.make()
    const flags = yield* RuntimeFlags.Service
    const localInstance = yield* InstanceRef
    const resultJson = args.format === "result-json"
    let automationSessionID: string | null = null
    let automationResultEmitted = false
    const emitAutomationResult = async (result: AutomationResult) => {
      if (automationResultEmitted) return
      automationResultEmitted = true
      Reflect.set(process, automationResultMarker, true)
      const safe = JSON.stringify(result).replace(/[\u007f-\u009f\u2028\u2029]/g, (char) => {
        return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
      })
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(safe + EOL, (error) => {
          if (!error) return resolve()
          process.exitCode = 1
          reject(error)
        })
      })
    }
    const executionError = (error: unknown): AutomationError => {
      const value = typeof error === "object" && error !== null ? error : undefined
      const name = value && "name" in value ? String(value.name) : error instanceof Error ? error.name : ""
      const data =
        value && "data" in value && typeof value.data === "object" && value.data !== null ? value.data : undefined
      const message = data && "message" in data ? String(data.message) : error instanceof Error ? error.message : ""
      const metadata =
        data && "metadata" in data && typeof data.metadata === "object" && data.metadata !== null
          ? data.metadata
          : undefined
      const code = metadata && "code" in metadata ? String(metadata.code) : ""
      if (/timeout|timed out/i.test(name + " " + code + " " + message)) return "timeout"
      if (name === "MessageAbortedError" || name === "AbortError") return "cancelled"
      if (name.includes("Permission")) return "permission_denied"
      if (
        name.includes("Provider") ||
        name === "APIError" ||
        name === "ContextOverflowError" ||
        name === "StructuredOutputError" ||
        name === "MessageOutputLengthError"
      ) {
        return "provider_error"
      }
      return "session_error"
    }
    const failAutomation = async (error: AutomationError) => {
      if (resultJson) await emitAutomationResult({ status: "error", sessionID: automationSessionID, error })
      else UI.error("Automation run failed")
      process.exitCode = 1
    }

    yield* Effect.promise(async () => {
      const rawMessage = [...args.message, ...(args["--"] || [])].join(" ")
      const thinking = args.interactive ? (args.thinking ?? true) : (args.thinking ?? false)
      const die = async (message: string, error: AutomationError = "invalid_input"): Promise<never> => {
        if (resultJson) await emitAutomationResult({ status: "error", sessionID: automationSessionID, error })
        else UI.error(message)
        process.exit(args.automation || resultJson ? 2 : 1)
      }
      const abortExecution = async (message: string, error: AutomationError = "session_error"): Promise<never> => {
        if (args.automation) await failAutomation(error)
        else UI.error(message)
        process.exit(1)
      }
      const dieInteractive = async (error: unknown): Promise<never> => {
        if (error instanceof Error && error.message === INTERACTIVE_INPUT_ERROR) {
          return die(error.message)
        }

        throw error
      }

      let message = [...args.message, ...(args["--"] || [])]
        .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
        .join(" ")

      if (args.interactive && args.command) {
        await die("--interactive cannot be used with --command")
      }

      if (resultJson && !args.automation) {
        await die("--format result-json requires --automation")
      }

      if (args.automation && args.interactive) {
        await die("--automation cannot be used with --interactive")
      }

      if (args.automation && args["dangerously-skip-permissions"]) {
        await die("--automation cannot be used with --dangerously-skip-permissions")
      }

      if (args.automation && args.format === "json") {
        await die("--automation cannot be used with --format json")
      }

      if (args.automation && args.attach !== undefined) {
        await die("--automation cannot be used with --attach")
      }

      if (args.automation && (args.session !== undefined || args.continue || args.fork)) {
        await die("--automation cannot be used with --session, --continue, or --fork")
      }

      if (args.automation && !args.agent) {
        await die("--automation requires --agent", "invalid_agent")
      }

      if (args.automation && !args.model) {
        await die("--automation requires --model", "invalid_model")
      }

      if (args.automation && !args.variant) {
        await die("--automation requires --variant", "invalid_variant")
      }

      if (args.demo && !args.interactive) {
        await die("--demo requires --interactive")
      }

      if (args.interactive && args.format === "json") {
        await die("--interactive cannot be used with --format json")
      }

      if (args["replay-limit"] !== undefined && !args.interactive) {
        await die("--replay-limit requires --interactive")
      }

      if (
        args["replay-limit"] !== undefined &&
        (!Number.isInteger(args["replay-limit"]) || args["replay-limit"] <= 0)
      ) {
        await die("--replay-limit must be a positive integer")
      }

      if (args.interactive && !process.stdout.isTTY) {
        await die("--interactive requires a TTY stdout")
      }

      if (args.interactive) {
        try {
          resolveInteractiveStdin().cleanup?.()
        } catch (error) {
          await dieInteractive(error)
        }
      }

      const replay = args.replay || args["replay-limit"] !== undefined

      const root = args.automation
        ? (localInstance?.directory ?? (await die("Automation instance unavailable", "session_error")))
        : Filesystem.resolve(process.env.PWD ?? process.cwd())
      const directory = await (async () => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          return die("Failed to change directory to " + args.dir)
        }
      })()
      const attachHeaders = args.attach
        ? ServerAuth.headers({ password: args.password, username: args.username })
        : undefined
      const attachSDK = (dir?: string) => {
        return createOpencodeClient({
          baseUrl: args.attach!,
          directory: dir,
          headers: attachHeaders,
        })
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            await die(`File not found: ${filePath}`)
          }

          const mime = (await Filesystem.isDir(resolvedPath))
            ? "application/x-directory"
            : sniffAttachmentMime(new Uint8Array(await Bun.file(resolvedPath).slice(0, 12).arrayBuffer()), "text/plain")

          files.push({
            type: "file",
            url: pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
      message = resolveRunInput(message, piped) ?? ""
      const initialInput = resolveRunInput(rawMessage, piped)

      if (message.trim().length === 0 && !args.command && !args.interactive) {
        await die("You must provide a message or a command")
      }

      if (args.fork && !args.continue && !args.session) {
        await die("--fork requires --continue or --session")
      }

      const rules: PermissionV1.Ruleset = args.interactive
        ? []
        : [
            {
              permission: "question",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_enter",
              action: "deny",
              pattern: "*",
            },
            {
              permission: "plan_exit",
              action: "deny",
              pattern: "*",
            },
          ]

      function title() {
        if (args.title === undefined) return
        if (args.title !== "") return args.title
        return message.slice(0, 50) + (message.length > 50 ? "..." : "")
      }

      async function session(sdk: OpencodeClient): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.session
            .get({
              sessionID: args.session,
            })
            .catch(() => undefined)

          if (!current?.data) {
            return abortExecution("Session not found")
          }

          if (args.fork) {
            const forked = await sdk.session.fork({
              sessionID: args.session,
            })
            const id = forked.data?.id
            if (!id) {
              return
            }

            return {
              id,
              title: forked.data?.title ?? current.data.title,
              directory: forked.data?.directory ?? current.data.directory,
            }
          }

          return {
            id: current.data.id,
            title: current.data.title,
            directory: current.data.directory,
          }
        }

        const base = args.continue ? (await sdk.session.list()).data?.find((item) => !item.parentID) : undefined

        if (base && args.fork) {
          const forked = await sdk.session.fork({
            sessionID: base.id,
          })
          const id = forked.data?.id
          if (!id) {
            return
          }

          return {
            id,
            title: forked.data?.title ?? base.title,
            directory: forked.data?.directory ?? base.directory,
          }
        }

        if (base) {
          return {
            id: base.id,
            title: base.title,
            directory: base.directory,
          }
        }

        const name = title()
        const result = await sdk.session.create({
          title: name,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          return
        }

        return {
          id,
          title: result.data?.title ?? name,
          directory: result.data?.directory,
        }
      }

      async function createFreshSession(
        sdk: OpencodeClient,
        input: { agent: string | undefined; model: ModelInput | undefined; variant: string | undefined },
      ): Promise<SessionInfo> {
        const result = await sdk.session.create({
          title: args.title !== undefined && args.title !== "" ? args.title : undefined,
          agent: input.agent,
          model: input.model
            ? {
                providerID: input.model.providerID,
                id: input.model.modelID,
                variant: input.variant,
              }
            : undefined,
          permission: [...rules],
        })
        const id = result.data?.id
        if (!id) {
          throw new Error("Failed to create session")
        }

        return {
          id,
          title: result.data?.title,
        }
      }

      async function current(sdk: OpencodeClient): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.path
          .get()
          .then((x) => x.data?.directory)
          .catch(() => undefined)
        if (next) {
          return next
        }

        return abortExecution("Failed to resolve remote directory")
      }

      async function localAgent() {
        if (!args.agent) return undefined
        const name = args.agent

        const entry = await Effect.runPromise(
          agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance)),
        )
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return name
      }

      async function attachAgent(sdk: OpencodeClient) {
        if (!args.agent) return undefined
        const name = args.agent

        const modes = await sdk.app
          .agents(undefined, { throwOnError: true })
          .then((x) => x.data ?? [])
          .catch(() => undefined)

        if (!modes) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `failed to list agents from ${args.attach}. Falling back to default agent`,
          )
          return undefined
        }

        const agent = modes.find((a) => a.name === name)
        if (!agent) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" not found. Falling back to default agent`,
          )
          return undefined
        }

        if (agent.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${name}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }

        return name
      }

      async function pickAgent(sdk: OpencodeClient) {
        if (!args.agent) return undefined
        if (args.attach) {
          return attachAgent(sdk)
        }

        return localAgent()
      }

      async function automationIdentity(sdk: OpencodeClient) {
        const model = pick(args.model)
        if (!model) {
          return die(`model "${args.model}" not found`, "invalid_model")
        }
        if (!model.providerID || !model.modelID) {
          return die(`model "${args.model}" not found`, "invalid_model")
        }
        const variant = args.variant
        if (!variant) {
          return die("--automation requires --variant", "invalid_variant")
        }

        const [agent, providers, commandResult] = await Promise.all([
          bridge.promise(agentSvc.get(args.agent!)),
          bridge.promise(providerSvc.listAutomation()),
          args.command ? sdk.command.list(undefined, { throwOnError: true }) : undefined,
        ])
        if (!agent || agent.name !== args.agent) {
          return die(`agent "${args.agent}" not found or disabled`, "invalid_agent")
        }
        if (agent.mode === "subagent") {
          return die(`agent "${args.agent}" is a subagent, not a primary agent`, "invalid_agent")
        }

        const provider = Object.values(providers).find((item) => item.id === model.providerID)
        const selected = provider?.models[model.modelID]
        if (!provider || !selected || selected.id !== model.modelID || selected.providerID !== model.providerID) {
          return die(`model "${args.model}" not found`, "invalid_model")
        }
        if (!selected.variants || !Object.hasOwn(selected.variants, variant)) {
          return die(`variant "${variant}" not found for model "${args.model}"`, "invalid_variant")
        }

        if (args.command && !commandResult?.data?.some((item) => item.name === args.command)) {
          return die(`command "${args.command}" not found`, "invalid_command")
        }

        return {
          agent: args.agent!,
          model,
        }
      }

      async function execute(sdk: OpencodeClient) {
        const sess = await session(sdk)
        if (!sess?.id) {
          return abortExecution("Session not found")
        }
        const sessionID = sess.id
        if (args.automation) automationSessionID = sessionID

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        function toolFailed(part: ToolPart) {
          if (part.state.status === "error") return true
          if (part.state.status !== "completed") return false
          if (part.tool === "invalid") return true
          if (part.state.metadata.isError === true) return true
          return Object.hasOwn(part.state.metadata, "exit") && part.state.metadata.exit !== 0
        }

        // Consume one subscribed event stream for the active session and mirror it
        // to stdout/UI. `client` is passed explicitly because attach mode may
        // rebind the SDK to the session's directory after the subscription is
        // created, and replies issued from inside the loop must use that client.
        async function loop(client: OpencodeClient, events: Awaited<ReturnType<typeof sdk.event.subscribe>>) {
          const toggles = new Map<string, boolean>()
          let failure: AutomationError | undefined
          let terminal = false

          for await (const event of events.stream) {
            if (
              event.type === "message.updated" &&
              event.properties.sessionID === sessionID &&
              event.properties.info.role === "assistant" &&
              args.format !== "json" &&
              !args.automation &&
              toggles.get("start") !== true
            ) {
              UI.empty()
              UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
              UI.empty()
              toggles.set("start", true)
            }

            if (event.type === "message.part.updated") {
              const part = event.properties.part
              if (part.sessionID !== sessionID) continue

              if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
                if (emit("tool_use", { part })) continue
                if (part.state.status === "completed") {
                  if (toolFailed(part)) failure ??= "tool_error"
                  if (args.automation) continue
                  await tool(part)
                  continue
                }
                failure ??= "tool_error"
                if (args.automation) continue
                await toolError(part)
                UI.error(part.state.error)
              }

              if (
                part.type === "tool" &&
                part.tool === "task" &&
                part.state.status === "running" &&
                args.format !== "json" &&
                !args.automation
              ) {
                if (toggles.get(part.id) === true) continue
                await tool(part)
                toggles.set(part.id, true)
              }

              if (part.type === "step-start") {
                if (emit("step_start", { part })) continue
              }

              if (part.type === "step-finish") {
                if (emit("step_finish", { part })) continue
              }

              if (part.type === "text" && part.time?.end) {
                if (emit("text", { part })) continue
                if (args.automation) continue
                const text = part.text.trim()
                if (!text) continue
                if (!process.stdout.isTTY) {
                  process.stdout.write(text + EOL)
                  continue
                }
                UI.empty()
                UI.println(text)
                UI.empty()
              }

              if (part.type === "reasoning" && part.time?.end && thinking && !args.automation) {
                if (emit("reasoning", { part })) continue
                const text = part.text.trim()
                if (!text) continue
                const line = `Thinking: ${text}`
                if (process.stdout.isTTY) {
                  UI.empty()
                  UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                  UI.empty()
                  continue
                }
                process.stdout.write(line + EOL)
              }
            }

            if (event.type === "session.error") {
              const props = event.properties
              if (props.sessionID !== sessionID || !props.error) continue
              let err = String(props.error.name)
              if ("data" in props.error && props.error.data && "message" in props.error.data) {
                err = String(props.error.data.message)
              }
              failure ??= executionError(props.error)
              if (emit("error", { error: props.error })) continue
              if (args.automation) continue
              UI.error(err)
            }

            if (event.type === "session.status" && event.properties.sessionID === sessionID) {
              if (event.properties.status.type === "retry") {
                failure ??= /timeout|timed out/i.test(event.properties.status.message) ? "timeout" : "provider_error"
                continue
              }
              if (event.properties.status.type === "idle") {
                terminal = true
                break
              }
            }

            if (event.type === "permission.asked") {
              const permission = event.properties
              if (permission.sessionID !== sessionID) continue

              if (args["dangerously-skip-permissions"]) {
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "once",
                })
              } else {
                failure ??= "permission_denied"
                if (!args.automation) {
                  UI.println(
                    UI.Style.TEXT_WARNING_BOLD + "!",
                    UI.Style.TEXT_NORMAL +
                      `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
                  )
                }
                await client.permission.reply({
                  requestID: permission.id,
                  reply: "reject",
                })
              }
            }
          }
          return { failure, terminal }
        }
        const cwd = args.attach ? (directory ?? sess.directory ?? (await current(sdk))) : (directory ?? root)
        const client = args.attach ? attachSDK(cwd) : sdk

        const identity = args.automation ? await automationIdentity(client) : undefined
        const agent = identity?.agent ?? (await pickAgent(client))
        const model = identity?.model ?? pick(args.model)

        if (!args.interactive) {
          const events = await client.event.subscribe()
          const completion = loop(client, events).catch((error) => {
            if (!args.automation) {
              console.error(error)
              process.exit(1)
            }
            return { failure: executionError(error), terminal: false }
          })

          async function finishAutomation() {
            if (!args.automation || !identity) return
            const outcome = await completion
            const history = await client.session
              .messages({ sessionID }, { throwOnError: true })
              .then((result) => result.data ?? [])
            const user = history.findLast((item) => item.info.role === "user")
            const assistants = user
              ? history.filter((item) => item.info.role === "assistant" && item.info.parentID === user.info.id)
              : []
            const lastAssistant = assistants.findLast((item) => item.info.role === "assistant")
            const identityMismatch =
              !user ||
              user.info.role !== "user" ||
              user.info.agent !== identity.agent ||
              user.info.model.providerID !== identity.model.providerID ||
              user.info.model.modelID !== identity.model.modelID ||
              user.info.model.variant !== args.variant
            let recordedFailure: AutomationError | undefined
            for (const item of assistants) {
              if (item.info.role !== "assistant") continue
              if (item.info.error) recordedFailure ??= executionError(item.info.error)
              if (item.parts.some((part) => part.type === "tool" && toolFailed(part))) recordedFailure ??= "tool_error"
            }
            if (!lastAssistant || lastAssistant.info.role !== "assistant" || lastAssistant.info.finish !== "stop") {
              recordedFailure ??= "session_error"
            }
            if (outcome.terminal && !outcome.failure && !identityMismatch && !recordedFailure && lastAssistant) {
              const text = lastAssistant.parts
                .filter((part) => part.type === "text")
                .map((part) => part.text.trim())
                .filter(Boolean)
                .join(EOL)
              if (resultJson) await emitAutomationResult({ status: "ok", sessionID, text })
              else if (text) process.stdout.write(text + EOL)
              return
            }
            await failAutomation(outcome.failure ?? recordedFailure ?? "session_error")
          }

          if (args.command) {
            const result = await client.session.command({
              sessionID,
              agent,
              model: args.model,
              command: args.command,
              arguments: message,
              variant: args.variant,
              automation: args.automation || undefined,
              parts: files,
            })
            if (result.error) {
              if (args.automation) await failAutomation("provider_error")
              else if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
              process.exitCode = 1
              return
            }
            await finishAutomation()
            return
          }

          const result = await client.session.prompt({
            sessionID,
            agent,
            model,
            variant: args.variant,
            automation: args.automation || undefined,
            parts: [...files, { type: "text", text: message }],
          })
          if (result.error) {
            if (args.automation) await failAutomation("provider_error")
            else if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
            process.exitCode = 1
            return
          }
          await finishAutomation()
          return
        }

        const { runInteractiveMode } = await import("./run/runtime")
        try {
          await runInteractiveMode({
            sdk: client,
            directory: cwd,
            sessionID,
            sessionTitle: sess.title,
            resume: Boolean(args.session || args.continue) && !args.fork,
            replay,
            replayLimit: args["replay-limit"],
            agent,
            model,
            variant: args.variant,
            files,
            initialInput,
            createSession: createFreshSession,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          await dieInteractive(error)
        }
        return
      }

      if (args.interactive && !args.attach && !args.session && !args.continue) {
        const model = pick(args.model)
        const { runInteractiveLocalMode } = await import("./run/runtime")
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const { Server } = await import("@/server/server")
          const request = new Request(input, init)
          return Server.Default().app.fetch(request)
        }) as typeof globalThis.fetch

        try {
          return await runInteractiveLocalMode({
            directory: directory ?? root,
            fetch: fetchFn,
            resolveAgent: localAgent,
            session,
            createSession: createFreshSession,
            agent: args.agent,
            model,
            variant: args.variant,
            replay,
            replayLimit: args["replay-limit"],
            files,
            initialInput,
            thinking,
            backgroundSubagents: flags.experimentalBackgroundSubagents,
            demo: args.demo,
          })
        } catch (error) {
          await dieInteractive(error)
        }
      }

      if (args.attach) {
        const sdk = attachSDK(directory)
        return await execute(sdk)
      }

      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { Server } = await import("@/server/server")
        const request = new Request(input, init)
        return Server.Default().app.fetch(request)
      }) as typeof globalThis.fetch
      const sdk = createOpencodeClient({
        baseUrl: "http://opencode.internal",
        fetch: fetchFn,
        directory,
      })
      await execute(sdk)
    }).pipe(
      Effect.catchCause((cause) => {
        if (!args.automation) return Effect.failCause(cause)
        if (automationResultEmitted) return Effect.void
        return Effect.promise(() => failAutomation(executionError(Cause.squash(cause))))
      }),
    )
  }),
})
