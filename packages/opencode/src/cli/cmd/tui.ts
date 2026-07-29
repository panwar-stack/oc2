import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "../tui/worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import * as Log from "@oc2-ai/core/util/log"
import { errorMessage } from "@oc2-ai/tui/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { GlobalEvent } from "@oc2-ai/sdk/v2"
import type { EventSource } from "@oc2-ai/tui/context/sdk"
import { writeHeapSnapshot } from "v8"
import { OC2_PROCESS_ROLE, OC2_RUN_ID, ensureRunID, sanitizedProcessEnv } from "@oc2-ai/core/util/opencode-process"
import { validateSession } from "../tui/validate-session"
import { win32InstallCtrlCGuard } from "@oc2-ai/tui/terminal-win32"
import {
  getTuiStartupProfile,
  OC2_TUI_STARTUP_PROFILE,
  OC2_TUI_STARTUP_PROFILE_FD,
  OC2_TUI_STARTUP_PROFILE_WORKER,
  type TuiStartupPhase,
  type TuiStartupProfile,
} from "@oc2-ai/core/util/tui-startup-profile"
import { createParentRpcTrace } from "../tui/startup-trace"

declare global {
  const OC2_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

async function tracePhase<T>(profile: TuiStartupProfile, phase: TuiStartupPhase, fn: () => T | Promise<T>): Promise<T> {
  if (!profile.enabled) return fn()
  const start = performance.now()
  let outcome: "ok" | "error" = "ok"
  try {
    return await fn()
  } catch (error) {
    outcome = "error"
    throw error
  } finally {
    profile.emit({ event: "phase", role: "main", phase, outcome, durationMs: Math.max(0, performance.now() - start) })
  }
}

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on<GlobalEvent>("global.event", (e) => {
        handler(e)
      })
    },
  }
}

async function target() {
  if (typeof OC2_WORKER_PATH !== "undefined") return OC2_WORKER_PATH
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("../tui/worker.ts", import.meta.url)
}

export function constructTuiWorker(
  file: string | URL,
  options: ConstructorParameters<typeof Worker>[1],
  onError: () => void,
  create: (file: string | URL, options: ConstructorParameters<typeof Worker>[1]) => Worker = (file, options) =>
    new Worker(file, options),
) {
  try {
    return create(file, options)
  } catch (error) {
    try {
      onError()
    } catch {}
    throw error
  }
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start oc2 tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start oc2 in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      }),
  handler: async (args) => {
    const unguard = win32InstallCtrlCGuard()
    try {
      const { TuiConfig } = await import("@/config/tui")
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const next = resolveThreadDirectory(args.project)
      const file = await target()
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())
      const env = sanitizedProcessEnv({
        [OC2_PROCESS_ROLE]: "worker",
        [OC2_RUN_ID]: ensureRunID(),
      })
      delete env[OC2_TUI_STARTUP_PROFILE]
      delete env[OC2_TUI_STARTUP_PROFILE_FD]
      const currentProfile = getTuiStartupProfile()
      if (currentProfile.enabled) env[OC2_TUI_STARTUP_PROFILE_WORKER] = "1"
      else delete env[OC2_TUI_STARTUP_PROFILE_WORKER]

      const workerStart = currentProfile.enabled ? performance.now() : 0
      const worker = constructTuiWorker(file, { env }, () => {
        if (currentProfile.enabled) {
          currentProfile.emit({
            event: "phase",
            role: "main",
            phase: "worker.spawn",
            outcome: "error",
            durationMs: Math.max(0, performance.now() - workerStart),
          })
        }
      })
      using startupProfile = currentProfile.adopt()
      if (startupProfile.enabled) {
        startupProfile.emit({
          event: "phase",
          role: "main",
          phase: "worker.spawn",
          outcome: "ok",
          durationMs: Math.max(0, performance.now() - workerStart),
        })
      }
      worker.onerror = (e) => {
        Log.Default.error("thread error", {
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno,
          error: e.error,
        })
      }

      const client = Rpc.client<typeof rpc>(worker, createParentRpcTrace(startupProfile))
      client.on("startup.trace", (input) => {
        startupProfile.emit(input)
      })
      const error = (e: unknown) => {
        Log.Default.error("process error", { error: errorMessage(e) })
      }
      const reload = () => {
        client.call("reload", undefined).catch((err) => {
          Log.Default.warn("worker reload failed", {
            error: errorMessage(err),
          })
        })
      }
      process.on("uncaughtException", error)
      process.on("unhandledRejection", error)
      process.on("SIGUSR2", reload)

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        process.off("uncaughtException", error)
        process.off("unhandledRejection", error)
        process.off("SIGUSR2", reload)
        await withTimeout(client.call("shutdown", undefined), 5000).catch((error) => {
          Log.Default.warn("worker shutdown failed", {
            error: errorMessage(error),
          })
        })
        worker.terminate()
      }

      const prompt = await input(args.prompt)
      const config = await tracePhase(startupProfile, "tui.config", () => TuiConfig.get())

      const network = resolveNetworkOptionsNoConfig(args)
      const external =
        process.argv.includes("--port") ||
        process.argv.includes("--hostname") ||
        process.argv.includes("--mdns") ||
        network.mdns ||
        network.port !== 0 ||
        network.hostname !== "127.0.0.1"

      const transport = await tracePhase(startupProfile, "transport.ready", async () =>
        external
          ? {
              url: (await client.call("server", network)).url,
              fetch: undefined,
              events: undefined,
            }
          : {
              url: "http://opencode.internal",
              fetch: createWorkerFetch(client),
              events: createEventSource(client),
            },
      )

      try {
        await tracePhase(startupProfile, "session.validate", () =>
          validateSession({
            url: transport.url,
            sessionID: args.session,
            directory: cwd,
            fetch: transport.fetch,
          }),
        )
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      setTimeout(() => {
        client.call("checkUpgrade", { directory: cwd }).catch(() => {})
      }, 1000).unref?.()

      try {
        const [{ Effect }, { run }, { createLegacyTuiPluginHost }] = await tracePhase(
          startupProfile,
          "tui.import",
          () => Promise.all([import("effect"), import("../tui/layer"), import("@/plugin/tui/runtime")]),
        )
        await Effect.runPromise(
          run({
            url: transport.url,
            async onSnapshot() {
              const tui = writeHeapSnapshot("tui.heapsnapshot")
              const server = await client.call("snapshot", undefined)
              return [tui, server]
            },
            config,
            pluginHost: createLegacyTuiPluginHost(),
            directory: cwd,
            fetch: transport.fetch,
            events: transport.events,
            startupTrace: startupProfile.enabled ? (input) => startupProfile.emit(input) : undefined,
            args: {
              continue: args.continue,
              sessionID: args.session,
              agent: args.agent,
              model: args.model,
              prompt,
              fork: args.fork,
            },
          }),
        )
      } finally {
        await stop()
        startupProfile.close()
      }
      process.exit(0)
    } finally {
      try {
        unguard?.()
      } catch (error) {
        Log.Default.warn("failed to restore terminal guard", { error: errorMessage(error) })
      }
    }
  },
})
