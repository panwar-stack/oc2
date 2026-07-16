import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import * as Log from "@oc2-ai/core/util/log"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { InstallationVersion } from "@oc2-ai/core/installation/version"
import { NamedError } from "@oc2-ai/core/util/error"
import { FormatError } from "./cli/error"
import { EOL } from "os"
import { errorMessage } from "./util/error"
import { Heap } from "./cli/heap"
import { ensureProcessMetadata } from "@oc2-ai/core/util/opencode-process"
import { isRecord } from "@/util/record"
import { writeFileSync } from "node:fs"

type CommandLoader = {
  readonly names: readonly string[]
  load(): Promise<unknown>
}

const commandLoaders: CommandLoader[] = [
  { names: ["acp"], load: async () => (await import("./cli/cmd/acp")).AcpCommand },
  { names: ["mcp"], load: async () => (await import("./cli/cmd/mcp")).McpCommand },
  { names: [], load: async () => (await import("./cli/cmd/tui")).TuiThreadCommand },
  { names: ["attach"], load: async () => (await import("./cli/cmd/attach")).AttachCommand },
  { names: ["run"], load: async () => (await import("./cli/cmd/run")).RunCommand },
  { names: ["generate"], load: async () => (await import("./cli/cmd/generate")).GenerateCommand },
  { names: ["debug"], load: async () => (await import("./cli/cmd/debug")).DebugCommand },
  { names: ["providers", "auth"], load: async () => (await import("./cli/cmd/providers")).ProvidersCommand },
  { names: ["agent"], load: async () => (await import("./cli/cmd/agent")).AgentCommand },
  { names: ["upgrade"], load: async () => (await import("./cli/cmd/upgrade")).UpgradeCommand },
  { names: ["uninstall"], load: async () => (await import("./cli/cmd/uninstall")).UninstallCommand },
  { names: ["serve"], load: async () => (await import("./cli/cmd/serve")).ServeCommand },
  { names: ["web"], load: async () => (await import("./cli/cmd/web")).WebCommand },
  { names: ["models"], load: async () => (await import("./cli/cmd/models")).ModelsCommand },
  { names: ["stats"], load: async () => (await import("./cli/cmd/stats")).StatsCommand },
  { names: ["export"], load: async () => (await import("./cli/cmd/export")).ExportCommand },
  { names: ["import"], load: async () => (await import("./cli/cmd/import")).ImportCommand },
  { names: ["pr"], load: async () => (await import("./cli/cmd/pr")).PrCommand },
  { names: ["session"], load: async () => (await import("./cli/cmd/session")).SessionCommand },
  { names: ["plugin", "plug"], load: async () => (await import("./cli/cmd/plug")).PluginCommand },
  { names: ["db"], load: async () => (await import("./cli/cmd/db")).DbCommand },
  { names: ["memory"], load: async () => (await import("./cli/cmd/memory")).MemoryCommand },
]

const optionsWithValues = new Set([
  "--agent",
  "--cors",
  "--hostname",
  "--log-level",
  "--mdns-domain",
  "--model",
  "--port",
  "--prompt",
  "--session",
])
const shortOptionsWithValues = new Set(["m", "s"])

const processMetadata = ensureProcessMetadata("main")
const automationResultMarker = Symbol.for("oc2.cli.automationResultEmitted")

function writeAutomationError(error: "invalid_input" | "session_error", exitCode: 1 | 2) {
  Reflect.set(process, automationResultMarker, true)
  process.exitCode = exitCode
  writeFileSync(process.stdout.fd, JSON.stringify({ status: "error", sessionID: null, error }) + EOL)
}

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args: string[] = hideBin(process.argv)
const optionArgs = args.slice(0, args.indexOf("--") === -1 ? undefined : args.indexOf("--"))
const preflight = yargs(
  optionArgs.map((arg) =>
    arg === "--get-yargs-completions" || arg.startsWith("--get-yargs-completions=")
      ? "--oc2-result-json-completion"
      : arg,
  ),
)
  .exitProcess(false)
  .help(false)
  .version(false)
  .option("help", { type: "boolean", alias: "h" })
  .option("version", { type: "boolean", alias: "v" })
  .option("format", { type: "string" })
  .parseSync()
const completionOutput =
  preflight._[0] === "completion" ||
  optionArgs.some((arg) => arg === "--get-yargs-completions" || arg.startsWith("--get-yargs-completions="))
const formats = Array.isArray(preflight.format)
  ? preflight.format
  : preflight.format === undefined
    ? []
    : [preflight.format]
const resultJsonOutput = formats.includes("result-json")
const automationOutput = optionArgs.some((arg) => arg === "--automation" || arg === "--automation=true")
const safeAutomationOutput = automationOutput || resultJsonOutput

if (
  resultJsonOutput &&
  (formats.length !== 1 || completionOutput || Object.hasOwn(preflight, "help") || Object.hasOwn(preflight, "version"))
) {
  writeAutomationError("invalid_input", 2)
  process.exit(2)
}

async function loadCommands() {
  const selected = selectedCommandName()
  if (
    selected === "completion" ||
    args.includes("-h") ||
    args.includes("--help") ||
    args.includes("--get-yargs-completions")
  ) {
    return Promise.all(commandLoaders.map((loader) => loader.load()))
  }

  const matched = selected ? commandLoaders.find((loader) => loader.names.includes(selected)) : undefined
  return [await (matched ?? commandLoaders.find((loader) => loader.names.length === 0)!).load()]
}

function selectedCommandName() {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--") return
    if (arg.startsWith("--")) {
      const [option] = arg.split("=", 1)
      if (optionsWithValues.has(option) && !arg.includes("=") && !args[index + 1]?.startsWith("-")) {
        index++
      }
      continue
    }
    if (arg.startsWith("-")) {
      const short = arg.slice(1)
      if (short.length === 1 && shortOptionsWithValues.has(short) && !args[index + 1]?.startsWith("-")) {
        index++
      }
      continue
    }
    return arg
  }
}

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("oc2 ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

async function main(commands: unknown[] | undefined) {
  const loaded = commands ?? (await loadCommands())
  const cli = yargs(args)
    .parserConfiguration({ "populate--": true })
    .scriptName("oc2")
    .wrap(100)
    .help("help", "show help")
    .alias("help", "h")
    .version("version", "show version number", InstallationVersion)
    .alias("version", "v")
    .option("print-logs", {
      describe: "print logs to stderr",
      type: "boolean",
    })
    .option("log-level", {
      describe: "log level",
      type: "string",
      choices: ["DEBUG", "INFO", "WARN", "ERROR"],
    })
    .option("pure", {
      describe: "run without external plugins",
      type: "boolean",
    })
    .middleware(async (opts) => {
      if (opts.pure) {
        process.env.OC2_PURE = "1"
      }

      await Log.init({
        print: process.argv.includes("--print-logs") && !safeAutomationOutput,
        dev: Installation.isLocal(),
        level: (() => {
          if (opts.logLevel) return opts.logLevel as Log.Level
          if (Installation.isLocal()) return "DEBUG"
          return "INFO"
        })(),
      })

      Heap.start()

      process.env.AGENT = "1"
      process.env.OPENCODE = "1"
      process.env.OC2_PID = String(process.pid)

      Log.Default.info("opencode", {
        version: InstallationVersion,
        args: safeAutomationOutput ? ["<automation arguments redacted>"] : process.argv.slice(2),
        process_role: processMetadata.processRole,
        run_id: processMetadata.runID,
      })
    })
    .usage("")
    .completion("completion", "generate shell completion script")
  const registerCommand = cli.command as (command: unknown) => unknown
  for (const command of loaded) registerCommand.call(cli, command)

  cli
    .fail((msg, err) => {
      if (err) throw err
      if (resultJsonOutput) {
        writeAutomationError("invalid_input", 2)
        process.exit(2)
      }
      if (
        msg?.startsWith("Unknown argument") ||
        msg?.startsWith("Not enough non-option arguments") ||
        msg?.startsWith("Invalid values:")
      ) {
        cli.showHelp(show)
      }
      process.exit(automationOutput ? 2 : 1)
    })
    .strict()

  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
}

const commands = safeAutomationOutput ? undefined : await loadCommands()

try {
  await main(commands)
} catch (e) {
  if (resultJsonOutput) {
    if (Reflect.get(process, automationResultMarker) !== true) {
      writeAutomationError("session_error", 1)
    } else {
      if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1
    }
  } else if (automationOutput) {
    UI.error("Automation run failed")
    process.exitCode = 1
  } else {
    let data: Record<string, any> = {}
    if (e instanceof Error) {
      Object.assign(data, {
        name: e.name,
        message: e.message,
        cause: e.cause?.toString(),
        stack: e.stack,
      })
    }

    if (e instanceof NamedError) {
      const obj = e.toObject()
      if (isRecord(obj.data)) {
        for (const [key, value] of Object.entries(obj.data)) {
          if (key === "name" || key === "stack" || key === "cause") continue
          data[key] = value
        }
      }
    }

    if (e instanceof ResolveMessage) {
      Object.assign(data, {
        name: e.name,
        message: e.message,
        code: e.code,
        specifier: e.specifier,
        referrer: e.referrer,
        position: e.position,
        importKind: e.importKind,
      })
    }
    Log.Default.error("fatal", data)
    const formatted = FormatError(e)
    if (formatted) UI.error(formatted)
    if (formatted === undefined) {
      UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
      process.stderr.write(errorMessage(e) + EOL)
    }
    process.exitCode = 1
  }
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
