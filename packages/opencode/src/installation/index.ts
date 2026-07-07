import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { errorMessage } from "@/util/error"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import path from "path"
import { EventV2 } from "@opencode-ai/core/event"
import * as Log from "@opencode-ai/core/util/log"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { NpmConfig } from "@opencode-ai/core/npm-config"

const log = Log.create({ service: "installation" })

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = {
  Updated: EventV2.define({
    type: "installation.updated",
    schema: {
      version: Schema.String,
    },
  }),
  UpdateAvailable: EventV2.define({
    type: "installation.update-available",
    schema: {
      version: Schema.String,
    },
  }),
}

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  return `oc2/${InstallationChannel}/${InstallationVersion}/${client}`
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })
const NpmPackage = Schema.Struct({ version: Schema.String })
const BrewFormula = Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })
const BrewInfoV2 = Schema.Struct({
  formulae: Schema.Array(Schema.Struct({ versions: Schema.Struct({ stable: Schema.String }) })),
})
const ChocoPackage = Schema.Struct({
  d: Schema.Struct({ results: Schema.Array(Schema.Struct({ Version: Schema.String })) }),
})
const ScoopManifest = NpmPackage

function hasPackage(output: string, name: string) {
  return output
    .split(/\r?\n/)
    .flatMap((line) => line.trim().split(/\s+/))
    .map((token) => token.replace(/^[^a-zA-Z0-9@]+/, "").split(/[|@]/)[0])
    .includes(name)
}

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const run = Effect.fnUntraced(
      function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
        const result = yield* appProcess.run(
          ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.catch((err) => Effect.succeed({ code: 1, stdout: "", stderr: errorMessage(err) })),
    )

    const getBrewFormula = Effect.fnUntraced(function* () {
      const oc2TapFormula = yield* text(["brew", "list", "--formula", "anomalyco/tap/oc2"])
      if (oc2TapFormula.includes("oc2")) return "anomalyco/tap/oc2"
      const oc2CoreFormula = yield* text(["brew", "list", "--formula", "oc2"])
      if (oc2CoreFormula.includes("oc2")) return "oc2"
      const tapFormula = yield* text(["brew", "list", "--formula", "anomalyco/tap/opencode"])
      if (tapFormula.includes("opencode")) return "anomalyco/tap/opencode"
      const coreFormula = yield* text(["brew", "list", "--formula", "opencode"])
      if (coreFormula.includes("opencode")) return "opencode"
      return "oc2"
    })

    const installedPackage = Effect.fnUntraced(function* (method: Method, names: string[]) {
      const output = yield* Effect.gen(function* () {
        switch (method) {
          case "npm":
            return yield* text(["npm", "list", "-g", "--depth=0"])
          case "yarn":
            return yield* text(["yarn", "global", "list"])
          case "pnpm":
            return yield* text(["pnpm", "list", "-g", "--depth=0"])
          case "bun":
            return yield* text(["bun", "pm", "ls", "-g"])
          case "brew":
            return yield* text(["brew", "list", "--formula"])
          case "scoop":
            return yield* text(["scoop", "list"])
          case "choco":
            return yield* text(["choco", "list", "--limit-output"])
          default:
            return ""
        }
      })
      return names.find((name) => hasPackage(output, name))
    })

    const upgradeFailure = (method: Method, result?: { code: number; stdout: string; stderr: string }) => {
      if (method === "choco") return "not running from an elevated command shell"
      if (result) return `Upgrade failed for ${method} (exit code ${result.code}).`
      return `Upgrade failed for ${method}.`
    }

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeCurl = Effect.fnUntraced(
      function* (target: string) {
        const response = yield* httpOk.execute(HttpClientRequest.get("https://oc2.ai/install"))
        const body = yield* response.text
        const bodyBytes = new TextEncoder().encode(body)
        const shell = yield* upgradeScriptShell()
        const result = yield* appProcess.run(
          ChildProcess.make(shell, [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
            extendEnv: true,
          }),
        )
        return {
          code: result.exitCode,
          stdout: result.stdout.toString("utf8"),
          stderr: result.stderr.toString("utf8"),
        }
      },
      Effect.mapError(() => new UpgradeFailedError({ stderr: upgradeFailure("curl") })),
    )

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        if (process.execPath.includes(path.join(".oc2", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl" as Method
        if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
        const exec = process.execPath.toLowerCase()

        const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
          { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
          { name: "yarn", command: () => text(["yarn", "global", "list"]) },
          { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
          { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
          { name: "brew", command: () => text(["brew", "list", "--formula"]) },
          { name: "scoop", command: () => text(["scoop", "list"]) },
          { name: "choco", command: () => text(["choco", "list", "--limit-output"]) },
        ]

        checks.sort((a, b) => {
          const aMatches = exec.includes(a.name)
          const bMatches = exec.includes(b.name)
          if (aMatches && !bMatches) return -1
          if (!aMatches && bMatches) return 1
          return 0
        })

        for (const check of checks) {
          const installedNames =
            check.name === "brew" || check.name === "choco" || check.name === "scoop"
              ? ["oc2", "opencode"]
              : ["oc2-ai", "opencode-ai"]
          if (yield* installedPackage(check.name, installedNames)) {
            return check.name
          }
        }

        return "unknown" as Method
      }),
      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {
        const detectedMethod = installMethod || (yield* result.method())

        if (detectedMethod === "brew") {
          const formula = yield* getBrewFormula()
          if (formula.includes("/")) {
            const infoJson = yield* text(["brew", "info", "--json=v2", formula])
            const info = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BrewInfoV2))(infoJson)
            return info.formulae[0].versions.stable
          }
          const response = yield* httpOk.execute(
            HttpClientRequest.get(`https://formulae.brew.sh/api/formula/${formula}.json`).pipe(
              HttpClientRequest.acceptJson,
            ),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(BrewFormula)(response)
          return data.versions.stable
        }

        if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
          const registry = yield* NpmConfig.registry(process.cwd())
          const response = yield* httpOk
            .execute(HttpClientRequest.get(`${registry}/oc2-ai/${InstallationChannel}`).pipe(HttpClientRequest.acceptJson))
            .pipe(
              Effect.catch(() =>
                httpOk.execute(
                  HttpClientRequest.get(`${registry}/opencode-ai/${InstallationChannel}`).pipe(HttpClientRequest.acceptJson),
                ),
              ),
            )
          const data = yield* HttpClientResponse.schemaBodyJson(NpmPackage)(response)
          return data.version
        }

        if (detectedMethod === "choco") {
          const fetchVersion = (name: string) =>
            httpOk
              .execute(
                HttpClientRequest.get(
                  `https://community.chocolatey.org/api/v2/Packages?$filter=Id%20eq%20%27${name}%27%20and%20IsLatestVersion&$select=Version`,
                ).pipe(HttpClientRequest.setHeaders({ Accept: "application/json;odata=verbose" })),
              )
              .pipe(
                Effect.flatMap(HttpClientResponse.schemaBodyJson(ChocoPackage)),
                Effect.flatMap((data) => {
                  const version = data.d.results[0]?.Version
                  return version ? Effect.succeed(version) : Effect.fail(new Error(`No Chocolatey version for ${name}`))
                }),
              )
          return yield* fetchVersion("oc2").pipe(Effect.catch(() => fetchVersion("opencode")))
        }

        if (detectedMethod === "scoop") {
          const fetchManifest = (name: string) =>
            httpOk
              .execute(
                HttpClientRequest.get(`https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/${name}.json`).pipe(
                  HttpClientRequest.setHeaders({ Accept: "application/json" }),
                ),
              )
              .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(ScoopManifest)))
          const data = yield* fetchManifest("oc2").pipe(Effect.catch(() => fetchManifest("opencode")))
          return data.version
        }

        const response = yield* httpOk.execute(
          HttpClientRequest.get("https://api.github.com/repos/anomalyco/opencode/releases/latest").pipe(
            HttpClientRequest.acceptJson,
          ),
        )
        const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
        return data.tag_name.replace(/^v/, "")
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
        let upgradeResult: { code: number; stdout: string; stderr: string } | undefined
        switch (m) {
          case "curl":
            upgradeResult = yield* upgradeCurl(target)
            break
          case "npm":
            upgradeResult = yield* run([
              "npm",
              "install",
              "-g",
              `${(yield* installedPackage("npm", ["oc2-ai", "opencode-ai"])) ?? "oc2-ai"}@${target}`,
            ])
            break
          case "pnpm":
            upgradeResult = yield* run([
              "pnpm",
              "install",
              "-g",
              `${(yield* installedPackage("pnpm", ["oc2-ai", "opencode-ai"])) ?? "oc2-ai"}@${target}`,
            ])
            break
          case "bun":
            upgradeResult = yield* run([
              "bun",
              "install",
              "-g",
              `${(yield* installedPackage("bun", ["oc2-ai", "opencode-ai"])) ?? "oc2-ai"}@${target}`,
            ])
            break
          case "brew": {
            const formula = yield* getBrewFormula()
            const env = { HOMEBREW_NO_AUTO_UPDATE: "1" }
            if (formula.includes("/")) {
              const tap = yield* run(["brew", "tap", "anomalyco/tap"], { env })
              if (tap.code !== 0) {
                upgradeResult = tap
                break
              }
              const repo = yield* text(["brew", "--repo", "anomalyco/tap"])
              const dir = repo.trim()
              if (dir) {
                const pull = yield* run(["git", "pull", "--ff-only"], { cwd: dir, env })
                if (pull.code !== 0) {
                  upgradeResult = pull
                  break
                }
              }
            }
            upgradeResult = yield* run(["brew", "upgrade", formula], { env })
            break
          }
          case "choco":
            upgradeResult = yield* run([
              "choco",
              "upgrade",
              (yield* installedPackage("choco", ["oc2", "opencode"])) ?? "oc2",
              `--version=${target}`,
              "-y",
            ])
            break
          case "scoop":
            upgradeResult = yield* run([
              "scoop",
              "install",
              `${(yield* installedPackage("scoop", ["oc2", "opencode"])) ?? "oc2"}@${target}`,
            ])
            break
          default:
            return yield* new UpgradeFailedError({ stderr: `Unknown installation method: ${m}` })
        }
        if (!upgradeResult || upgradeResult.code !== 0) {
          return yield* new UpgradeFailedError({ stderr: upgradeFailure(m, upgradeResult) })
        }
        log.info("upgraded", {
          method: m,
          target,
          stdout: upgradeResult.stdout,
          stderr: upgradeResult.stderr,
        })
        yield* text([process.execPath, "--version"])
      }),
    }

    return Service.of(result)
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(AppProcess.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
