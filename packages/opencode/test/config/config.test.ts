import { test, expect, describe, afterEach, beforeEach, spyOn } from "bun:test"
import { ConfigV1 } from "@oc2-ai/core/v1/config/config"
import { Config as CoreConfig } from "@oc2-ai/core/config"
import { Naming } from "@oc2-ai/core/naming"
import { ConfigMigrateV1 } from "@oc2-ai/core/v1/config/migrate"
import { Effect, Exit, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Config } from "@/config/config"
import { ConfigMemory } from "@/config/memory"
import { ConfigManaged } from "@/config/managed"
import { ConfigParse } from "../../src/config/parse"
import { EffectFlock } from "@oc2-ai/core/util/effect-flock"

import { InstanceRef } from "../../src/effect/instance-ref"
import type { InstanceContext } from "../../src/project/instance-context"
import { Auth } from "../../src/auth"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Env } from "../../src/env"
import {
  provideTmpdirInstance,
  TestInstance,
  tmpdir,
  tmpdirScoped,
  withTestInstance,
  provideInstanceEffect,
  testInstanceStoreLayer,
  disposeAllInstancesEffect,
} from "../fixture/fixture"
import { InstanceRuntime } from "@/project/instance-runtime"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { pathToFileURL } from "url"
import { Global } from "@oc2-ai/core/global"
import { ProjectV2 } from "@oc2-ai/core/project"
import { Filesystem } from "@/util/filesystem"
import { ConfigPlugin } from "@/config/plugin"
import { ConfigPluginV1 } from "@oc2-ai/core/v1/config/plugin"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

/** Infra layer that provides FileSystem, Path, ChildProcessSpawner for test fixtures */
const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const testFlock = EffectFlock.defaultLayer

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const json = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const wellKnownAuth = (url: string) =>
  Layer.mock(Auth.Service)({
    all: () =>
      Effect.succeed({
        [url]: new Auth.WellKnown({ type: "wellknown", key: "TEST_TOKEN", token: "test-token" }),
      }),
  })

function remoteConfigClient(input: {
  wellKnown: unknown
  remote?: unknown
  seen: { wellKnown?: string; remote?: string; authorization?: string }
}) {
  return HttpClient.make((request) => {
    if (request.url.includes(".well-known/oc2")) {
      input.seen.wellKnown = request.url
      return Effect.succeed(json(request, input.wellKnown))
    }
    if (input.remote !== undefined && request.url.includes("config.example.com")) {
      input.seen.remote = request.url
      input.seen.authorization = request.headers.authorization
      return Effect.succeed(json(request, input.remote))
    }
    return Effect.succeed(json(request, {}, 404))
  })
}

const configLayer = (
  options: {
    auth?: Layer.Layer<Auth.Service>
    client?: HttpClient.HttpClient
  } = {},
) =>
  Config.layer.pipe(
    Layer.provide(testFlock),
    Layer.provide(options.auth ?? AuthTest.empty),
    Layer.provideMerge(infra),
    Layer.provide(NpmTest.noop),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, options.client ?? unexpectedHttp)),
    Layer.provideMerge(FSUtil.defaultLayer),
  )

const layer = configLayer()

const it = testEffect(layer)
const unixIt = process.platform === "win32" ? it.live.skip : it.live
const unixIdentity = (() => {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  const supplementary = process.getgroups?.().find((candidate) => candidate !== gid)
  if (uid === undefined || supplementary === undefined) return
  return { uid, gid: supplementary }
})()
const supplementaryGroupIt = unixIdentity === undefined ? it.live.skip : unixIt
const configIt = (options?: Parameters<typeof configLayer>[0]) => testEffect(configLayer(options))

const schemaConfig = (config: object) => ({ $schema: Naming.configSchemaURL, ...config })

const provideCurrentInstance = <A, E, R>(effect: Effect.Effect<A, E, R>, ctx: InstanceContext) =>
  effect.pipe(Effect.provideService(InstanceRef, ctx))

const load = (ctx: InstanceContext) =>
  Effect.runPromise(
    Config.Service.use((svc) => provideCurrentInstance(svc.get(), ctx)).pipe(Effect.scoped, Effect.provide(layer)),
  )
const clearEffect = (wait = false) =>
  Config.use
    .invalidate()
    .pipe(
      Effect.scoped,
      Effect.provide(layer),
      Effect.andThen(wait ? Effect.promise(() => InstanceRuntime.disposeAllInstances()) : Effect.void),
    )
const clear = (wait = false) => Effect.runPromise(clearEffect(wait))
// Get managed config directory from environment (set in preload.ts)
const managedConfigDir = process.env.OC2_TEST_MANAGED_CONFIG_DIR!
const originalTestToken = process.env.TEST_TOKEN
const originalConsoleToken = process.env.OC2_CONSOLE_TOKEN

beforeEach(async () => {
  await clear(true)
})

afterEach(async () => {
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
  if (originalTestToken === undefined) delete process.env.TEST_TOKEN
  else process.env.TEST_TOKEN = originalTestToken
  if (originalConsoleToken === undefined) delete process.env.OC2_CONSOLE_TOKEN
  else process.env.OC2_CONSOLE_TOKEN = originalConsoleToken
  await clear(true)
})

const writeManagedSettingsEffect = (settings: object, filename?: string) =>
  FSUtil.use.writeWithDirs(path.join(managedConfigDir, filename ?? "oc2.json"), JSON.stringify(settings))

async function writeConfig(dir: string, config: object, name = "oc2.json") {
  await Filesystem.write(path.join(dir, name), JSON.stringify(config))
}

const writeConfigEffect = (dir: string, config: object, name = "oc2.json") =>
  FSUtil.use.writeWithDirs(path.join(dir, name), JSON.stringify(config))

const withInstanceDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(TestInstance, { directory: dir }),
    provideInstanceEffect(dir),
    Effect.provide(testInstanceStoreLayer),
    Effect.provide(CrossSpawnSpawner.defaultLayer),
  )

const withGlobalConfigDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      yield* clearEffect(true)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.gen(function* () {
        ;(Global.Path as { config: string }).config = previous
        yield* clearEffect(true)
      }),
  )

const withGlobalConfig = <A, E, R>(
  input: { config?: object; name?: string },
  fn: (input: { dir: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    if (input.config) yield* writeConfigEffect(dir, schemaConfig(input.config), input.name)
    return yield* withGlobalConfigDir(dir, fn({ dir }))
  })

const withConfigTree = <A, E, R>(
  input: { global?: object; project?: object; local?: object },
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped()
    const global = yield* tmpdirScoped()
    const directory = path.join(root, "project")
    yield* Effect.all(
      [
        input.global ? writeConfigEffect(global, schemaConfig(input.global)) : undefined,
        input.project ? writeConfigEffect(directory, schemaConfig(input.project)) : undefined,
        input.local ? writeConfigEffect(path.join(directory, ".oc2"), schemaConfig(input.local)) : undefined,
      ].filter((effect): effect is Effect.Effect<void, FSUtil.Error, FSUtil.Service> => effect !== undefined),
      { concurrency: "unbounded" },
    )
    return yield* withGlobalConfigDir(global, withInstanceDir(directory, effect))
  })

const wellKnown = (input: {
  authUrl?: string
  config?: unknown
  remoteConfig?: { url: string; headers?: Record<string, string> }
  remote?: unknown
  wellKnown?: unknown
}) => {
  const seen: { wellKnown?: string; remote?: string; authorization?: string } = {}
  const client = remoteConfigClient({
    seen,
    wellKnown: input.wellKnown ?? {
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.remoteConfig !== undefined ? { remote_config: input.remoteConfig } : {}),
    },
    remote: input.remote,
  })
  return {
    seen,
    it: configIt({ auth: wellKnownAuth(input.authUrl ?? "https://example.com"), client }),
  }
}

function withProcessEnv<A, E, R>(key: string, value: string | undefined, effect: Effect.Effect<A, E, R>) {
  return withProcessEnvs({ [key]: value }, effect)
}

function withProcessEnvs<A, E, R>(entries: Record<string, string | undefined>, effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const originals: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(entries)) {
        originals[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return originals
    }),
    () => effect,
    (originals) =>
      Effect.sync(() => {
        for (const [key, original] of Object.entries(originals)) {
          if (original !== undefined) process.env[key] = original
          else delete process.env[key]
        }
      }),
  )
}

const fullWorkspaceSandbox = {
  enabled: true,
  defaultProfile: "workspace",
  profiles: {
    workspace: {
      filesystem: {
        read: ["workspace", "systemRuntime"],
        write: ["workspace", "temporaryDirectory"],
        protected: [
          "workspace/.git/hooks",
          "workspace/.oc2",
          "workspace/AGENTS.md",
          "home/.ssh",
          "home/.config",
          "home/.aws",
          "home/.gitconfig",
        ],
      },
      network: {
        mode: "none" as const,
      },
      process: {
        hideHostProcesses: true,
        killTreeOnExit: true,
      },
      resources: {
        memoryMegabytes: 4096,
        processLimit: 512,
        timeSeconds: 600,
      },
    },
  },
}

const parseSandboxConfig = (sandbox: object | undefined) => ConfigParse.schema(Config.Info, { sandbox }, "test")

async function check(map: (dir: string) => string) {
  if (process.platform !== "win32") return
  await using globalTmp = await tmpdir()
  await using tmp = await tmpdir({ git: true, config: { snapshot: true } })
  const prev = Global.Path.config
  ;(Global.Path as { config: string }).config = globalTmp.path
  await clear()
  try {
    await writeConfig(globalTmp.path, {
      $schema: "https://opencode.ai/config.json",
      snapshot: false,
    })
    await withTestInstance({
      directory: map(tmp.path),
      fn: async (ctx) => {
        const cfg = await load(ctx)
        expect(cfg.snapshot).toBe(true)
        expect(ctx.directory).toBe(Filesystem.resolve(tmp.path))
        expect(ctx.project.id).not.toBe(ProjectV2.ID.global)
      },
    })
  } finally {
    await InstanceRuntime.disposeAllInstances()
    ;(Global.Path as { config: string }).config = prev
    await clear()
  }
}

it.instance("loads config with defaults when no files exist", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.username).toBeDefined()
  }),
)

it.instance("falls back to generic username when system user info is unavailable", () =>
  Effect.gen(function* () {
    const userInfo = spyOn(os, "userInfo").mockImplementation(() => {
      throw Object.assign(new Error("missing passwd entry"), { code: "ENOENT" })
    })
    try {
      const config = yield* Config.use.get()
      expect(config.username).toBe("user")
    } finally {
      userInfo.mockRestore()
    }
  }),
)

it.effect("does not seed global config when no global configs exist", () =>
  withGlobalConfig({}, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.get().pipe(provideInstanceEffect(dir))

      expect(yield* FSUtil.use.existsSafe(path.join(dir, "oc2.json"))).toBe(false)
      expect(yield* FSUtil.use.existsSafe(path.join(dir, "oc2.jsonc"))).toBe(false)
      expect(yield* FSUtil.use.existsSafe(path.join(dir, "config.json"))).toBe(false)
    }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  ),
)

it.effect("loads protected config sources without changing bytes or modification times", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped({ git: true })
    const global = yield* tmpdirScoped()
    const configDir = yield* tmpdirScoped()
    const custom = path.join(root, "custom.jsonc")
    const sources = [
      { file: path.join(global, "oc2.json"), content: '{"username":"global-json"}\n' },
      {
        file: path.join(global, "oc2.jsonc"),
        content:
          '{\n  // user schema\n  "$schema": "https://example.com/user-schema.json",\n  "username": "global-jsonc"\n}\n',
      },
      { file: path.join(global, "config"), content: 'provider = "legacy"\nmodel = "model"\n' },
      { file: path.join(global, "config.bak"), content: 'provider = "backup"\nmodel = "model"\n' },
      { file: custom, content: '{\n  // selected through OC2_CONFIG\n  "username": "custom"\n}\n' },
      { file: path.join(root, "oc2.json"), content: '{"username":"project-json"}\n' },
      {
        file: path.join(root, "oc2.jsonc"),
        content: '{\n  // direct project JSONC\n  "username": "project-jsonc"\n}\n',
      },
      { file: path.join(root, "tui.json"), content: '{"theme":"protected-json"}\n' },
      {
        file: path.join(root, "tui.jsonc"),
        content: '{\n  // protected TUI JSONC\n  "theme": "protected-jsonc"\n}\n',
      },
      { file: path.join(root, "oc2.json.tui-migration.bak"), content: '{"theme":"existing-backup"}\n' },
      { file: path.join(root, ".oc2", "oc2.json"), content: '{"username":"directory-json"}\n' },
      {
        file: path.join(root, ".oc2", "oc2.jsonc"),
        content: '{\n  // project directory JSONC\n  "username": "directory-jsonc"\n}\n',
      },
      { file: path.join(configDir, "oc2.json"), content: '{"username":"config-dir-json"}\n' },
      {
        file: path.join(configDir, "oc2.jsonc"),
        content: '{\n  // OC2_CONFIG_DIR JSONC\n  "username": "config-dir-jsonc"\n}\n',
      },
    ]
    for (const source of sources) yield* FSUtil.use.writeWithDirs(source.file, source.content)

    const fixed = new Date("2020-01-02T03:04:05.000Z")
    yield* Effect.promise(() => Promise.all(sources.map((source) => fs.utimes(source.file, fixed, fixed))))
    const before = new Map(
      yield* Effect.promise(() =>
        Promise.all(
          sources.map(async (source) => [
            source.file,
            { bytes: await fs.readFile(source.file), mtimeMs: (await fs.stat(source.file)).mtimeMs },
          ] as const),
        ),
      ),
    )

    const config = yield* withGlobalConfigDir(
      global,
      withProcessEnvs({ OC2_CONFIG: custom, OC2_CONFIG_DIR: configDir }, withInstanceDir(root, Config.use.get())),
    )

    expect(config.model).toBe("legacy/model")
    expect(config.$schema).toBe("https://example.com/user-schema.json")
    for (const source of sources) {
      const original = before.get(source.file)
      if (!original) throw new Error(`missing original stat for ${source.file}`)
      expect(yield* Effect.promise(() => fs.readFile(source.file))).toEqual(original.bytes)
      expect((yield* Effect.promise(() => fs.stat(source.file))).mtimeMs).toBe(original.mtimeMs)
    }
    expect(yield* FSUtil.use.existsSafe(path.join(global, "config.json"))).toBe(false)
    expect(yield* FSUtil.use.existsSafe(path.join(global, "config"))).toBe(true)
  }),
)

it.effect("does not create global config when OC2_CONFIG_DIR is set", () =>
  Effect.gen(function* () {
    const custom = yield* tmpdirScoped()
    yield* withGlobalConfig({}, ({ dir }) =>
      withProcessEnv(
        "OC2_CONFIG_DIR",
        custom,
        Effect.gen(function* () {
          yield* Config.use.get().pipe(provideInstanceEffect(dir))

          expect(yield* FSUtil.use.existsSafe(path.join(dir, "oc2.jsonc"))).toBe(false)
        }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
      ),
    )
  }),
)

it.instance(
  "loads JSON config file",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect(config.username).toBe("testuser")
  }),
  { config: { model: "test/model", username: "testuser" } },
)

it.instance("prefers oc2 project config over legacy opencode project config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, { username: "legacy" }, "oc2.json")
    yield* writeConfigEffect(test.directory, { username: "canonical" }, "oc2.json")

    const config = yield* Config.use.get()
    expect(config.username).toBe("canonical")
  }),
)

it.instance(
  "loads named local_fusion config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.local_fusion?.["research-panel"]?.branches[0]?.model).toBe("test/branch")
    expect(config.local_fusion?.["research-panel"]?.branches[0]?.variant).toBe("branch-fast")
    expect(config.local_fusion?.["research-panel"]?.judge.model).toBe("test/judge")
    expect(config.local_fusion?.["research-panel"]?.judge.variant).toBe("judge-high")
    expect(config.local_fusion?.["research-panel"]?.synthesizer.model).toBe("test/synth")
    expect(config.local_fusion?.["research-panel"]?.synthesizer.variant).toBe("synth-low")
  }),
  {
    config: {
      local_fusion: {
        "research-panel": {
          branches: [{ model: "test/branch", variant: "branch-fast" }],
          judge: { model: "test/judge", variant: "judge-high" },
          synthesizer: { model: "test/synth", variant: "synth-low" },
        },
      },
    },
  },
)

it.instance(
  "loads fugu config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.fugu?.branches?.[0]?.model).toBe("test/branch")
    expect(config.fugu?.branches?.[0]?.variant).toBe("branch-fast")
    expect(config.fugu?.judge?.model).toBe("test/judge")
    expect(config.fugu?.judge?.variant).toBe("judge-high")
    expect(config.fugu?.synthesizer?.model).toBe("test/synth")
    expect(config.fugu?.synthesizer?.variant).toBe("synth-low")
  }),
  {
    config: {
      fugu: {
        branches: [{ model: "test/branch", variant: "branch-fast" }],
        judge: { model: "test/judge", variant: "judge-high" },
        synthesizer: { model: "test/synth", variant: "synth-low" },
      },
    },
  },
)

test("config parser accepts missing fugu config", () => {
  expect(ConfigParse.schema(ConfigV1.Info, {}, "test").fugu).toBeUndefined()
})

test("config parser accepts incomplete and malformed fugu targets", () => {
  const input = {
    fugu: {
      branches: [{}, { model: "" }, { model: "missing-slash" }, { model: "/model" }, { model: "provider/" }],
      judge: {},
      synthesizer: { model: "bad" },
    },
  }
  const v1 = ConfigParse.schema(ConfigV1.Info, input, "test")
  const current = ConfigParse.schema(CoreConfig.Info, input, "test")

  expect(v1.fugu?.branches?.[0]?.model).toBeUndefined()
  expect(v1.fugu?.branches?.map((branch) => branch.model)).toEqual([
    undefined,
    "",
    "missing-slash",
    "/model",
    "provider/",
  ])
  expect(v1.fugu?.judge?.model).toBeUndefined()
  expect(v1.fugu?.synthesizer?.model).toBe("bad")
  expect(current.fugu).toEqual(v1.fugu)
})

test("v1 migration preserves fugu judge", () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    { fugu: { judge: { model: "test/judge", variant: "judge-high" } } },
    "test",
  )
  const migrated = ConfigMigrateV1.migrate(config)

  expect(ConfigMigrateV1.isV1({ fugu: { judge: { model: "test/judge" } } })).toBe(true)
  expect(ConfigParse.schema(CoreConfig.Info, migrated, "test").fugu?.judge).toEqual({
    model: "test/judge",
    variant: "judge-high",
  })
})

it.instance(
  "loads shell config field",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.shell).toBe("bash")
  }),
  { config: { shell: "bash" } },
)

test("missing sandbox config remains undefined", () => {
  expect(ConfigParse.schema(Config.Info, {}, "test").sandbox).toBeUndefined()
})

test("parses valid workspace sandbox profile", () => {
  expect(parseSandboxConfig(fullWorkspaceSandbox).sandbox).toEqual(fullWorkspaceSandbox)
})

it.instance(
  "sandbox defaults enabled profile selection to workspace",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.sandbox?.defaultProfile).toBeUndefined()
    expect(config.sandbox?.profiles?.workspace).toBeDefined()
  }),
  {
    config: {
      sandbox: {
        enabled: true,
        profiles: fullWorkspaceSandbox.profiles,
      },
    },
  },
)

it.instance(
  "sandbox rejects unknown default profile when enabled",
  Effect.gen(function* () {
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
  }),
  {
    config: {
      sandbox: {
        enabled: true,
        defaultProfile: "locked-down",
        profiles: fullWorkspaceSandbox.profiles,
      },
    },
  },
)

test("sandbox allows disabled config without profiles", () => {
  expect(parseSandboxConfig({ enabled: false }).sandbox).toEqual({ enabled: false })
})

test("sandbox rejects invalid allowlist hosts", () => {
  expect(() => parseSandboxConfig({ profiles: { workspace: { network: { mode: "allowlist" } } } })).toThrow()
  expect(() => parseSandboxConfig({ profiles: { workspace: { network: { mode: "allowlist", hosts: [] } } } })).toThrow()
  expect(() =>
    parseSandboxConfig({ profiles: { workspace: { network: { mode: "allowlist", hosts: [""] } } } }),
  ).toThrow()
})

test("sandbox rejects invalid network mode", () => {
  expect(() => parseSandboxConfig({ profiles: { workspace: { network: { mode: "invalid" } } } })).toThrow()
})

test("sandbox rejects invalid path tokens", () => {
  expect(() => parseSandboxConfig({ profiles: { workspace: { filesystem: { read: ["home"] } } } })).toThrow()
  expect(() => parseSandboxConfig({ profiles: { workspace: { filesystem: { write: ["workspace/"] } } } })).toThrow()
  expect(() => parseSandboxConfig({ profiles: { workspace: { filesystem: { protected: ["tmp"] } } } })).toThrow()
})

test("sandbox rejects invalid resource bounds", () => {
  expect(() => parseSandboxConfig({ profiles: { workspace: { resources: { memoryMegabytes: 0 } } } })).toThrow()
  expect(() => parseSandboxConfig({ profiles: { workspace: { resources: { processLimit: -1 } } } })).toThrow()
  expect(() => parseSandboxConfig({ profiles: { workspace: { resources: { timeSeconds: 1.5 } } } })).toThrow()
})

test("parses memory config field", () => {
  const config = ConfigParse.schema(
    Config.Info,
    {
      memory: {
        enabled: true,
        index_on_start: false,
        max_commits: 42,
        summary_limit: 3,
        search_commit_limit: 7,
        search_summary_limit: 2,
        include: ["src/**"],
        exclude: ["dist/**"],
        github: { enabled: true, fetch_linked_issues: false },
      },
    },
    "test",
  )

  expect(config.memory).toEqual({
    enabled: true,
    index_on_start: false,
    max_commits: 42,
    summary_limit: 3,
    search_commit_limit: 7,
    search_summary_limit: 2,
    include: ["src/**"],
    exclude: ["dist/**"],
    github: { enabled: true, fetch_linked_issues: false },
  })
})

test("memory config is enabled by default", () => {
  expect(ConfigMemory.enabled(undefined)).toBe(true)
  expect(ConfigMemory.enabled({})).toBe(true)
  expect(ConfigMemory.enabled({ enabled: true })).toBe(true)
  expect(ConfigMemory.enabled({ enabled: false })).toBe(false)
})

it.instance("updates config and preserves empty shell sentinel", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, { $schema: "https://opencode.ai/config.json", shell: "bash" }, "oc2.json")

    yield* Config.Service.use((svc) => svc.update(ConfigParse.schema(ConfigV1.Info, { shell: "" }, "test:config")))

    const writtenConfig = yield* FSUtil.use.readJson(path.join(test.directory, "oc2.json"))
    expect(writtenConfig).toMatchObject({ $schema: "https://opencode.ai/config.json", shell: "" })
  }),
)

it.effect("updates global config and omits empty shell key in json", () =>
  withGlobalConfig({ config: { shell: "bash" } }, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.updateGlobal({ shell: "" })

      const writtenConfig = yield* FSUtil.use.readJson(path.join(dir, "oc2.json"))
      expect(writtenConfig).not.toHaveProperty("shell")
    }),
  ),
)

it.effect("updates global config and omits empty shell key in jsonc", () =>
  withGlobalConfig({ config: { shell: "bash", model: "test/model" }, name: "oc2.jsonc" }, ({ dir }) =>
    Effect.gen(function* () {
      yield* Config.use.updateGlobal({ shell: "" })

      const file = path.join(dir, "oc2.jsonc")
      const writtenConfig = yield* FSUtil.use.readFileString(file)
      const parsed = ConfigParse.schema(ConfigV1.Info, ConfigParse.jsonc(writtenConfig, file), file)
      expect(writtenConfig).not.toContain('"shell"')
      expect(parsed.shell).toBeUndefined()
      expect(parsed.model).toBe("test/model")
    }),
  ),
)

const globalUpdateCases = [
  { name: "JSON only", sources: ["oc2.json"], target: "oc2.json" },
  { name: "JSONC only", sources: ["oc2.jsonc"], target: "oc2.jsonc" },
  { name: "JSON and JSONC", sources: ["oc2.json", "oc2.jsonc"], target: "oc2.jsonc" },
  { name: "no existing file", sources: [], target: "oc2.jsonc" },
] as const

for (const updateCase of globalUpdateCases) {
  it.effect(`selects the canonical global update target: ${updateCase.name}`, () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const before = new Map<string, string>()
      for (const name of updateCase.sources) {
        const file = path.join(dir, name)
        const content = name.endsWith(".jsonc")
          ? `{\n  // keep ${name}\n  "$schema": "source:${name}",\n  "model": "before/model"\n}`
          : JSON.stringify({ $schema: `source:${name}`, model: "before/model" })
        yield* FSUtil.use.writeFileString(file, content)
        before.set(file, content)
      }

      const result = yield* withGlobalConfigDir(
        dir,
        Config.use.updateGlobal({ $schema: "request-schema", username: "patched-user" }),
      )

      expect(result.changed).toBe(true)
      const target = path.join(dir, updateCase.target)
      const written = yield* FSUtil.use.readFileString(target)
      const parsed = ConfigParse.jsonc(written, target) as Record<string, unknown>
      expect(parsed).toMatchObject({ username: "patched-user" })
      expect(parsed.model).toBe(updateCase.sources.length ? "before/model" : undefined)
      expect(parsed.$schema).toBe(updateCase.sources.length ? `source:${updateCase.target}` : undefined)
      if (target.endsWith(".jsonc") && updateCase.sources.length) {
        expect(written).toContain(`// keep ${updateCase.target}`)
      }
      if (target.endsWith(".json")) expect(written).toBe(JSON.stringify(parsed, null, 2))
      for (const [file, content] of before) {
        if (file === target) continue
        expect(yield* FSUtil.use.readFileString(file)).toBe(content)
      }
    }),
  )
}

it.effect("validates a global update before replacing the source", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const file = path.join(dir, "oc2.json")
    const before = JSON.stringify({ invalid_field: true })
    yield* FSUtil.use.writeFileString(file, before)

    const exit = yield* withGlobalConfigDir(dir, Config.use.updateGlobal({ username: "patched" })).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* FSUtil.use.readFileString(file)).toBe(before)
  }),
)

it.instance(
  "loads formatter boolean config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.formatter).toBe(true)
  }),
  { config: { formatter: true } },
)

it.instance(
  "loads lsp boolean config",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.lsp).toBe(true)
  }),
  { config: { lsp: true } },
)

test("loads project config from Git Bash and MSYS2 paths on Windows", async () => {
  // Git Bash and MSYS2 both use /<drive>/... paths on Windows.
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/${drive}${rest}`
  })
})

test("loads project config from Cygwin paths on Windows", async () => {
  await check((dir) => {
    const drive = dir[0].toLowerCase()
    const rest = dir.slice(2).replaceAll("\\", "/")
    return `/cygdrive/${drive}${rest}`
  })
})

it.instance("ignores legacy tui keys in opencode config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      model: "test/model",
      theme: "legacy",
      tui: { scroll_speed: 4 },
    })

    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect((config as Record<string, unknown>).theme).toBeUndefined()
    expect((config as Record<string, unknown>).tui).toBeUndefined()
  }),
)

it.instance("loads JSONC config file", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, "oc2.jsonc"),
      `{
        // This is a comment
        "$schema": "https://opencode.ai/config.json",
        "model": "test/model",
        "username": "testuser"
      }`,
    )
    const config = yield* Config.use.get()
    expect(config.model).toBe("test/model")
    expect(config.username).toBe("testuser")
  }),
)

it.instance("jsonc overrides json in the same directory", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(
      test.directory,
      {
        $schema: "https://opencode.ai/config.json",
        model: "base",
        username: "base",
      },
      "oc2.jsonc",
    )
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      model: "override",
    })
    const config = yield* Config.use.get()
    expect(config.model).toBe("base")
    expect(config.username).toBe("base")
  }),
)

it.instance("handles environment variable substitution", () =>
  withProcessEnv(
    "TEST_VAR",
    "test-user",
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* writeConfigEffect(test.directory, {
        $schema: "https://opencode.ai/config.json",
        username: "{env:TEST_VAR}",
      })
      const config = yield* Config.use.get()
      expect(config.username).toBe("test-user")
    }),
  ),
)

it.instance("does not add $schema while substituting environment variables", () =>
  withProcessEnv(
    "PRESERVE_VAR",
    "secret_value",
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "oc2.json")
      const content = JSON.stringify({ username: "{env:PRESERVE_VAR}" })
      yield* FSUtil.use.writeWithDirs(file, content)
      const config = yield* Config.use.get()
      expect(config.username).toBe("secret_value")

      expect(yield* FSUtil.use.readFileString(file)).toBe(content)
    }),
  ),
)

it.instance("handles file inclusion substitution", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, "included.txt"), "test-user")
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      username: "{file:included.txt}",
    })
    const config = yield* Config.use.get()
    expect(config.username).toBe("test-user")
  }),
)

it.instance("handles file inclusion with replacement tokens", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, "included.md"), "const out = await Bun.$`echo hi`")
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      username: "{file:included.md}",
    })
    const config = yield* Config.use.get()
    expect(config.username).toBe("const out = await Bun.$`echo hi`")
  }),
)

it.instance("validates config schema and throws on invalid fields", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      invalid_field: "should cause error",
    })
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

it.instance("throws error for invalid JSON", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(path.join(test.directory, "oc2.json"), "{ invalid json }")
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

it.instance("handles agent configuration", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: {
        test_agent: {
          model: "test/model",
          temperature: 0.7,
          description: "test agent",
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.agent?.["test_agent"]).toEqual(
      expect.objectContaining({
        model: "test/model",
        temperature: 0.7,
        description: "test agent",
      }),
    )
  }),
)

it.instance("treats agent variant as model-scoped setting (not provider option)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: {
        test_agent: {
          model: "openai/gpt-5.2",
          variant: "xhigh",
          max_tokens: 123,
        },
      },
    })
    const config = yield* Config.use.get()
    const agent = config.agent?.["test_agent"]

    expect(agent?.variant).toBe("xhigh")
    expect(agent?.options).toMatchObject({
      max_tokens: 123,
    })
    expect(agent?.options).not.toHaveProperty("variant")
  }),
)

it.instance("handles command configuration", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      command: {
        test_command: {
          template: "test template",
          description: "test command",
          agent: "test_agent",
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.command?.["test_command"]).toEqual({
      template: "test template",
      description: "test command",
      agent: "test_agent",
    })
  }),
)

it.instance("migrates mode field to agent field", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mode: {
        test_mode: {
          model: "test/model",
          temperature: 0.5,
        },
      },
    })
    const config = yield* Config.use.get()
    expect(config.agent?.["test_mode"]).toEqual({
      model: "test/model",
      temperature: 0.5,
      mode: "primary",
      options: {},
      permission: {},
    })
  }),
)

it.instance("loads config from .oc2 directory", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".oc2", "agent", "test.md"),
      `---
model: test/model
---
Test agent prompt`,
    )

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]).toEqual(
      expect.objectContaining({
        name: "test",
        model: "test/model",
        prompt: "Test agent prompt",
      }),
    )
  }),
)

it.instance("agent markdown permission config preserves user key order", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".oc2", "agent", "ordered.md"),
      `---
permission:
  bash: allow
  "*": deny
  edit: ask
---
Ordered permissions`,
    )

    const config = yield* Config.use.get()
    expect(Object.keys(config.agent?.ordered?.permission ?? {})).toEqual(["bash", "*", "edit"])
  }),
)

it.instance("loads agents from .oc2/agents (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".oc2", "agents", "helper.md"),
      `---
model: test/model
mode: subagent
---
Helper agent prompt`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".oc2", "agents", "nested", "child.md"),
      `---
model: test/model
mode: subagent
---
Nested agent prompt`,
    )

    const config = yield* Config.use.get()

    expect(config.agent?.["helper"]).toMatchObject({
      name: "helper",
      model: "test/model",
      mode: "subagent",
      prompt: "Helper agent prompt",
    })

    expect(config.agent?.["nested/child"]).toMatchObject({
      name: "nested/child",
      model: "test/model",
      mode: "subagent",
      prompt: "Nested agent prompt",
    })
  }),
)

it.instance("loads commands from .oc2/command (singular)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".oc2", "command", "hello.md"),
      `---
description: Test command
---
Hello from singular command`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".oc2", "command", "nested", "child.md"),
      `---
description: Nested command
---
Nested command template`,
    )

    const config = yield* Config.use.get()

    expect(config.command?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from singular command",
    })

    expect(config.command?.["nested/child"]).toEqual({
      description: "Nested command",
      template: "Nested command template",
    })
  }),
)

it.instance("loads commands from .oc2/commands (plural)", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".oc2", "commands", "hello.md"),
      `---
description: Test command
---
Hello from plural commands`,
    )

    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".oc2", "commands", "nested", "child.md"),
      `---
description: Nested command
---
Nested command template`,
    )

    const config = yield* Config.use.get()

    expect(config.command?.["hello"]).toEqual({
      description: "Test command",
      template: "Hello from plural commands",
    })

    expect(config.command?.["nested/child"]).toEqual({
      description: "Nested command",
      template: "Nested command template",
    })
  }),
)

it.instance("updates config and writes to file", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Config.Service.use((svc) =>
      svc.update(ConfigParse.schema(ConfigV1.Info, { model: "updated/model" }, "test:config")),
    )

    const writtenConfig = yield* FSUtil.use.readJson(path.join(test.directory, "oc2.json"))
    expect(writtenConfig).toMatchObject({ model: "updated/model" })
    expect(writtenConfig).not.toHaveProperty("$schema")
    expect(yield* FSUtil.use.existsSafe(path.join(test.directory, "config.json"))).toBe(false)
  }),
)

const projectUpdateCases = [
  {
    name: "JSON only",
    sources: ["nested/oc2.json"],
    target: "nested/oc2.json",
  },
  {
    name: "JSONC only",
    sources: ["nested/oc2.jsonc"],
    target: "nested/oc2.jsonc",
  },
  {
    name: "JSON and JSONC",
    sources: ["nested/oc2.json", "nested/oc2.jsonc"],
    target: "nested/oc2.jsonc",
  },
  {
    name: "root and nested direct files",
    sources: ["oc2.jsonc", "nested/oc2.json", "nested/oc2.jsonc"],
    target: "nested/oc2.jsonc",
  },
  {
    name: "direct and conflicting project .oc2 files",
    sources: ["nested/oc2.jsonc", "nested/.oc2/oc2.jsonc", ".oc2/oc2.json", ".oc2/oc2.jsonc"],
    target: ".oc2/oc2.jsonc",
  },
  {
    name: "no existing file",
    sources: [],
    target: "nested/oc2.json",
  },
] as const

for (const updateCase of projectUpdateCases) {
  it.effect(`selects the canonical project update target: ${updateCase.name}`, () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped({ git: true })
      const routed = path.join(root, "nested")
      yield* FSUtil.use.ensureDir(routed)
      const before = new Map<string, string>()
      for (const relative of updateCase.sources) {
        const file = path.join(root, relative)
        const content = file.endsWith(".jsonc")
          ? `{\n  // keep ${relative}\n  "$schema": "source:${relative}",\n  "model": "before/model"\n}`
          : JSON.stringify({ $schema: `source:${relative}`, model: "before/model" })
        yield* FSUtil.use.writeWithDirs(file, content)
        before.set(file, content)
      }

      yield* withInstanceDir(routed, Config.use.update({ $schema: "request-schema", username: "patched-user" }))

      const target = path.join(root, updateCase.target)
      const written = yield* FSUtil.use.readFileString(target)
      const parsed = ConfigParse.jsonc(written, target) as Record<string, unknown>
      expect(parsed.username).toBe("patched-user")
      expect(parsed.model).toBe(updateCase.sources.length ? "before/model" : undefined)
      expect(parsed.$schema).toBe(updateCase.sources.length ? `source:${updateCase.target}` : undefined)
      if (target.endsWith(".jsonc")) expect(written).toContain(`// keep ${updateCase.target}`)
      else expect(written).toBe(JSON.stringify(parsed, null, 2))

      for (const [file, content] of before) {
        if (file === target) continue
        expect(yield* FSUtil.use.readFileString(file)).toBe(content)
      }
      expect(yield* FSUtil.use.existsSafe(path.join(routed, "config.json"))).toBe(false)
    }),
  )
}

it.instance("persists an empty nested object when the source does not contain it", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* Config.use.update({ permission: {} })

    expect(yield* FSUtil.use.readJson(path.join(test.directory, "oc2.json"))).toEqual({ permission: {} })
  }),
)

unixIt("preserves a restrictive mode when replacing the selected project source", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped({ git: true })
    const file = path.join(root, "oc2.json")
    yield* FSUtil.use.writeFileString(file, JSON.stringify({ username: "before" }))
    yield* FSUtil.use.chmod(file, 0o600)

    yield* withInstanceDir(root, Config.use.update({ username: "after" }))

    expect((yield* FSUtil.use.stat(file)).mode & 0o777).toBe(0o600)
    expect(yield* FSUtil.use.readJson(file)).toMatchObject({ username: "after" })
  }),
)

supplementaryGroupIt("preserves uid, gid, and mode when replacing the selected project source", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped({ git: true })
    const file = path.join(root, "oc2.json")
    yield* FSUtil.use.writeFileString(file, JSON.stringify({ username: "before" }))
    yield* FSUtil.use.chown(file, unixIdentity!.uid, unixIdentity!.gid)
    yield* FSUtil.use.chmod(file, 0o640)

    yield* withInstanceDir(root, Config.use.update({ username: "after" }))

    const info = yield* FSUtil.use.stat(file)
    expect(Option.getOrUndefined(info.uid)).toBe(unixIdentity!.uid)
    expect(Option.getOrUndefined(info.gid)).toBe(unixIdentity!.gid)
    expect(info.mode & 0o777).toBe(0o640)
    expect(yield* FSUtil.use.readJson(file)).toMatchObject({ username: "after" })
  }),
)

unixIt("rejects a read-only selected project source without changing it", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped({ git: true })
    const file = path.join(root, "oc2.json")
    const before = JSON.stringify({ username: "before" })
    yield* FSUtil.use.writeFileString(file, before)
    yield* FSUtil.use.chmod(file, 0o400)
    yield* Effect.addFinalizer(() => FSUtil.use.chmod(file, 0o600).pipe(Effect.ignore))

    const exit = yield* withInstanceDir(root, Config.use.update({ username: "after" })).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* FSUtil.use.readFileString(file)).toBe(before)
    expect((yield* FSUtil.use.readDirectory(root)).some((name) => name.endsWith(".tmp"))).toBe(false)
  }),
)

unixIt("replaces a selected project symlink target without replacing the link", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped({ git: true })
    const target = path.join(root, "source", "config.json")
    const file = path.join(root, "oc2.json")
    const link = path.relative(path.dirname(file), target)
    yield* FSUtil.use.writeWithDirs(target, JSON.stringify({ username: "before" }))
    yield* Effect.promise(() => fs.symlink(link, file))

    yield* withInstanceDir(root, Config.use.update({ username: "after" }))

    expect((yield* Effect.promise(() => fs.lstat(file))).isSymbolicLink()).toBe(true)
    expect(yield* Effect.promise(() => fs.readlink(file))).toBe(link)
    expect(yield* FSUtil.use.readJson(target)).toMatchObject({ username: "after" })
  }),
)

unixIt("rejects a hard-linked selected project source without changing link identity", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped({ git: true })
    const file = path.join(root, "oc2.json")
    const linked = path.join(root, "linked.json")
    const before = JSON.stringify({ username: "before" })
    yield* FSUtil.use.writeFileString(file, before)
    yield* Effect.promise(() => fs.link(file, linked))
    const identity = yield* Effect.promise(() => fs.stat(file))

    const exit = yield* withInstanceDir(root, Config.use.update({ username: "after" })).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* FSUtil.use.readFileString(file)).toBe(before)
    expect(yield* FSUtil.use.readFileString(linked)).toBe(before)
    const current = yield* Effect.promise(() => Promise.all([fs.stat(file), fs.stat(linked)]))
    expect(current[0].ino).toBe(identity.ino)
    expect(current[1].ino).toBe(identity.ino)
    expect(current[0].nlink).toBe(2)
    expect((yield* FSUtil.use.readDirectory(root)).some((name) => name.endsWith(".tmp"))).toBe(false)
  }),
)

unixIt("preserves the selected project source when an atomic write fails", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped({ git: true })
    const file = path.join(root, "oc2.json")
    const before = JSON.stringify({ $schema: "original-schema", username: "before" })
    yield* FSUtil.use.writeFileString(file, before)
    yield* FSUtil.use.chmod(root, 0o555)
    yield* Effect.addFinalizer(() => FSUtil.use.chmod(root, 0o755).pipe(Effect.ignore))

    const exit = yield* withInstanceDir(root, Config.use.update({ username: "after" })).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* FSUtil.use.readFileString(file)).toBe(before)
    expect((yield* FSUtil.use.readDirectory(root)).some((name) => name.endsWith(".tmp"))).toBe(false)
  }),
)

it.instance("gets config directories", () =>
  Effect.gen(function* () {
    const dirs = yield* Config.use.directories()
    expect(dirs.length).toBeGreaterThanOrEqual(1)
  }),
)

it.effect("does not try to install dependencies in read-only OC2_CONFIG_DIR", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") return

    const dir = yield* tmpdirScoped()
    const readonly = path.join(dir, "readonly")
    yield* FSUtil.use.ensureDir(readonly)
    yield* FSUtil.use.chmod(readonly, 0o555)
    yield* Effect.addFinalizer(() => FSUtil.use.chmod(readonly, 0o755).pipe(Effect.ignore))

    yield* withProcessEnv("OC2_CONFIG_DIR", readonly, Config.use.get().pipe(provideInstanceEffect(dir)))
  }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

it.effect("installs dependencies in writable OC2_CONFIG_DIR", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const configDir = path.join(dir, "configdir")
    yield* FSUtil.use.ensureDir(configDir)

    yield* withProcessEnv(
      "OC2_CONFIG_DIR",
      configDir,
      Config.Service.use((svc) => svc.get().pipe(Effect.andThen(svc.waitForDependencies()))).pipe(
        provideInstanceEffect(dir),
      ),
    )

    expect(yield* FSUtil.use.readFileString(path.join(configDir, ".gitignore"))).toContain("package-lock.json")
  }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

// Note: deduplication and serialization of npm installs is now handled by the
// core Npm.Service (via EffectFlock). Those behaviors are tested in the core
// package's npm tests, not here.

it.instance("resolves scoped npm plugins in config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const pluginDir = path.join(test.directory, "node_modules", "@scope", "plugin")
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, "package.json"),
      JSON.stringify({ name: "config-fixture", version: "1.0.0", type: "module" }, null, 2),
    )
    yield* FSUtil.use.writeWithDirs(
      path.join(pluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@scope/plugin",
          version: "1.0.0",
          type: "module",
          main: "./index.js",
        },
        null,
        2,
      ),
    )
    yield* FSUtil.use.writeWithDirs(path.join(pluginDir, "index.js"), "export default {}\n")
    yield* writeConfigEffect(test.directory, { plugin: ["@scope/plugin"] })

    const config = yield* Config.use.get()
    expect(config.plugin ?? []).toContain("@scope/plugin")
  }),
)

it.effect("merges plugin arrays from global and local configs", () =>
  withConfigTree(
    {
      global: { plugin: ["global-plugin-1", "global-plugin-2"] },
      local: { plugin: ["local-plugin-1"] },
    },
    Effect.gen(function* () {
      const plugins = (yield* Config.use.get()).plugin ?? []

      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("global-plugin-2"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)
      expect(
        plugins.filter((p) => p.includes("global-plugin") || p.includes("local-plugin")).length,
      ).toBeGreaterThanOrEqual(3)
    }),
  ),
)

it.effect("enables agent teams by default", () =>
  withConfigTree(
    {},
    Effect.gen(function* () {
      expect((yield* Config.use.get()).experimental?.agent_teams).toBe(true)
    }),
  ),
)

it.effect("allows agent teams to be disabled", () =>
  withConfigTree(
    { project: { experimental: { agent_teams: false } } },
    Effect.gen(function* () {
      expect((yield* Config.use.get()).experimental?.agent_teams).toBe(false)
    }),
  ),
)

it.effect("global config remains global when project config is disabled", () =>
  withConfigTree(
    {
      global: { model: "global/model", plugin: ["global-plugin"] },
      project: { model: "project/model" },
      local: { model: "local/model" },
    },
    withProcessEnv(
      "OC2_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config.model).toBe("global/model")
        expect(config.plugin_origins?.find((item) => item.spec === "global-plugin")?.scope).toBe("global")
      }),
    ),
  ),
)

it.instance("does not error when only custom agent is a subagent", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* FSUtil.use.writeWithDirs(
      path.join(test.directory, ".oc2", "agent", "helper.md"),
      `---
model: test/model
mode: subagent
---
Helper subagent prompt`,
    )

    const config = yield* Config.use.get()
    expect(config.agent?.["helper"]).toMatchObject({
      name: "helper",
      model: "test/model",
      mode: "subagent",
      prompt: "Helper subagent prompt",
    })
  }),
)

it.effect("merges instructions arrays from global and local configs", () =>
  withConfigTree(
    {
      global: { instructions: ["global-instructions.md", "shared-rules.md"] },
      local: { instructions: ["local-instructions.md"] },
    },
    Effect.gen(function* () {
      expect((yield* Config.use.get()).instructions).toEqual([
        "global-instructions.md",
        "shared-rules.md",
        "local-instructions.md",
      ])
    }),
  ),
)

it.effect("deduplicates duplicate instructions from global and local configs", () =>
  withConfigTree(
    {
      global: { instructions: ["duplicate.md", "global-only.md"] },
      local: { instructions: ["duplicate.md", "local-only.md"] },
    },
    Effect.gen(function* () {
      expect((yield* Config.use.get()).instructions).toEqual(["duplicate.md", "global-only.md", "local-only.md"])
    }),
  ),
)

it.effect("deduplicates duplicate plugins from global and local configs", () =>
  withConfigTree(
    {
      global: { plugin: ["duplicate-plugin", "global-plugin-1"] },
      local: { plugin: ["duplicate-plugin", "local-plugin-1"] },
    },
    Effect.gen(function* () {
      const plugins = (yield* Config.use.get()).plugin ?? []

      expect(plugins.some((p) => p.includes("global-plugin-1"))).toBe(true)
      expect(plugins.some((p) => p.includes("local-plugin-1"))).toBe(true)
      expect(plugins.filter((p) => p.includes("duplicate-plugin")).length).toBe(1)
      expect(
        plugins.filter(
          (p) => p.includes("global-plugin") || p.includes("local-plugin") || p.includes("duplicate-plugin"),
        ).length,
      ).toBe(3)
    }),
  ),
)

it.effect("keeps plugin origins aligned with merged plugin list", () =>
  withConfigTree(
    {
      global: { plugin: [["shared-plugin@1.0.0", { source: "global" }], "global-only@1.0.0"] },
      local: { plugin: [["shared-plugin@2.0.0", { source: "local" }], "local-only@1.0.0"] },
    },
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      const plugins = config.plugin ?? []
      const origins = config.plugin_origins ?? []
      const names = plugins.map((item) => ConfigPlugin.pluginSpecifier(item))

      expect(names).toContain("shared-plugin@2.0.0")
      expect(names).not.toContain("shared-plugin@1.0.0")
      expect(names).toContain("global-only@1.0.0")
      expect(names).toContain("local-only@1.0.0")
      expect(origins.map((item) => item.spec)).toEqual(plugins)
      expect(origins.find((item) => ConfigPlugin.pluginSpecifier(item.spec) === "shared-plugin@2.0.0")?.scope).toBe(
        "local",
      )
    }),
  ),
)

// Legacy tools migration tests

it.instance("migrates legacy tools config to permissions - allow", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { bash: true, read: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      bash: "allow",
      read: "allow",
    })
  }),
)

it.instance("migrates legacy tools config to permissions - deny", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { bash: false, webfetch: false } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      bash: "deny",
      webfetch: "deny",
    })
  }),
)

it.instance("migrates legacy write tool to edit permission", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { write: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({ edit: "allow" })
  }),
)

// Managed settings tests
// Note: preload.ts sets OC2_TEST_MANAGED_CONFIG which Global.Path.managedConfig uses

it.instance(
  "managed settings override user settings",
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({
      $schema: "https://opencode.ai/config.json",
      model: "managed/model",
    })

    const config = yield* Config.use.get()
    expect(config.model).toBe("managed/model")
    expect(config.username).toBe("testuser")
  }),
  { config: { model: "user/model", username: "testuser" } },
)

it.instance(
  "managed settings override project settings",
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      disabled_providers: ["openai"],
    })

    const config = yield* Config.use.get()
    expect(config.autoupdate).toBe(false)
    expect(config.disabled_providers).toEqual(["openai"])
  }),
  { config: { autoupdate: true, disabled_providers: [] } },
)

it.instance("managed jsonc settings override managed json settings", () =>
  Effect.gen(function* () {
    yield* writeManagedSettingsEffect({ model: "managed/json" })
    yield* writeManagedSettingsEffect({ model: "managed/jsonc" }, "oc2.jsonc")

    const config = yield* Config.use.get()
    expect(config.model).toBe("managed/jsonc")
  }),
)

it.instance(
  "missing managed settings file is not an error",
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.model).toBe("user/model")
  }),
  { config: { model: "user/model" } },
)

it.instance("migrates legacy edit tool to edit permission", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { edit: false } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({ edit: "deny" })
  }),
)

it.instance("migrates legacy patch tool to edit permission", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { patch: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({ edit: "allow" })
  }),
)

it.instance("migrates mixed legacy tools config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { tools: { bash: true, write: true, read: false, webfetch: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      bash: "allow",
      edit: "allow",
      read: "deny",
      webfetch: "allow",
    })
  }),
)

it.instance("merges legacy tools with existing permission config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      agent: { test: { permission: { glob: "allow" }, tools: { bash: true } } },
    })

    const config = yield* Config.use.get()
    expect(config.agent?.["test"]?.permission).toEqual({
      glob: "allow",
      bash: "allow",
    })
  }),
)

it.instance("permission config preserves user key order", () =>
  // Permission precedence follows the order users write in config, so parsing
  // must not canonicalise known keys ahead of wildcard or custom keys.
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      permission: {
        "*": "deny",
        edit: "ask",
        write: "ask",
        external_directory: "ask",
        read: "allow",
        todowrite: "allow",
        "thoughts_*": "allow",
        "reasoning_model_*": "allow",
        "tools_*": "allow",
        "pr_comments_*": "allow",
      },
    })

    const config = yield* Config.use.get()
    expect(Object.keys(config.permission!)).toEqual([
      "*",
      "edit",
      "write",
      "external_directory",
      "read",
      "todowrite",
      "thoughts_*",
      "reasoning_model_*",
      "tools_*",
      "pr_comments_*",
    ])
  }),
)

test("config parser preserves permission order while rejecting unknown top-level keys", () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    {
      permission: {
        bash: "allow",
        "*": "deny",
        edit: "ask",
      },
    },
    "test",
  )

  expect(Object.keys(config.permission!)).toEqual(["bash", "*", "edit"])
  try {
    ConfigParse.schema(ConfigV1.Info, { fugu: { judge: { model: "test/judge" } }, invalid_field: true }, "test")
    throw new Error("expected config parse to fail")
  } catch (err) {
    const error = err as {
      data?: { issues?: Array<{ code?: string; keys?: string[]; path?: string[]; message?: string }> }
    }
    expect(error.data?.issues?.[0]).toMatchObject({ code: "unrecognized_keys", keys: ["invalid_field"], path: [] })
  }

  try {
    ConfigParse.schema(ConfigV1.Info, { logu: {} }, "test")
    throw new Error("expected logu config parse to fail")
  } catch (err) {
    const error = err as {
      data?: { issues?: Array<{ code?: string; keys?: string[]; path?: string[]; message?: string }> }
    }
    expect(error.data?.issues?.[0]).toMatchObject({
      path: [],
      message: "logu config has been removed; use local_fusion instead",
    })
  }
})

// MCP config merging tests

it.instance("project config can override MCP server enabled status", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    // Simulates a base config (like from remote .well-known) with disabled MCP.
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        jira: {
          type: "remote",
          url: "https://jira.example.com/mcp",
          enabled: false,
        },
        wiki: {
          type: "remote",
          url: "https://wiki.example.com/mcp",
          enabled: false,
        },
      },
    })
    // Project config enables just jira.
    yield* writeConfigEffect(
      test.directory,
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          jira: {
            type: "remote",
            url: "https://jira.example.com/mcp",
            enabled: true,
          },
        },
      },
      "oc2.jsonc",
    )

    const config = yield* Config.use.get()
    expect(config.mcp?.jira).toEqual({
      type: "remote",
      url: "https://jira.example.com/mcp",
      enabled: true,
    })
    expect(config.mcp?.wiki).toEqual({
      type: "remote",
      url: "https://wiki.example.com/mcp",
      enabled: false,
    })
  }),
)

it.instance("MCP config deep merges preserving base config properties", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        myserver: {
          type: "remote",
          url: "https://myserver.example.com/mcp",
          enabled: false,
          headers: {
            "X-Custom-Header": "value",
          },
        },
      },
    })
    yield* writeConfigEffect(
      test.directory,
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          myserver: {
            type: "remote",
            url: "https://myserver.example.com/mcp",
            enabled: true,
          },
        },
      },
      "oc2.jsonc",
    )

    const config = yield* Config.use.get()
    expect(config.mcp?.myserver).toEqual({
      type: "remote",
      url: "https://myserver.example.com/mcp",
      enabled: true,
      headers: {
        "X-Custom-Header": "value",
      },
    })
  }),
)

it.instance("local .oc2 config can override MCP from project config", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    yield* writeConfigEffect(test.directory, {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        docs: {
          type: "remote",
          url: "https://docs.example.com/mcp",
          enabled: false,
        },
      },
    })
    yield* FSUtil.use.ensureDir(path.join(test.directory, ".oc2"))
    yield* writeConfigEffect(
      path.join(test.directory, ".oc2"),
      {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          docs: {
            type: "remote",
            url: "https://docs.example.com/mcp",
            enabled: true,
          },
        },
      },
      "oc2.json",
    )

    const config = yield* Config.use.get()
    expect(config.mcp?.docs?.enabled).toBe(true)
  }),
)

const precedenceWellKnown = wellKnown({ config: { username: "well-known" } })

const schemaFreeWellKnown = wellKnown({ config: { username: "remote-user" } })

schemaFreeWellKnown.it.instance("does not synthesize $schema for remote config", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(config.username).toBe("remote-user")
    expect(config.$schema).toBeUndefined()
  }),
)

precedenceWellKnown.it.live("keeps every opencode config source tier in precedence order", () =>
  Effect.gen(function* () {
    const root = yield* tmpdirScoped({ git: true })
    const global = yield* tmpdirScoped()
    const home = yield* tmpdirScoped()
    const configDir = yield* tmpdirScoped()
    const routed = path.join(root, "nested")
    const custom = path.join(root, "custom.json")
    const direct = path.join(routed, "oc2.json")
    const projectDir = path.join(routed, ".oc2", "oc2.json")
    const homeDir = path.join(home, ".oc2", "oc2.json")
    const configDirFile = path.join(configDir, "oc2.json")
    const managed = path.join(managedConfigDir, "oc2.json")
    yield* Effect.all(
      [
        writeConfigEffect(global, { username: "global" }),
        FSUtil.use.writeWithDirs(custom, JSON.stringify({ username: "OC2_CONFIG" })),
        FSUtil.use.writeWithDirs(direct, JSON.stringify({ username: "direct-project" })),
        FSUtil.use.writeWithDirs(projectDir, JSON.stringify({ username: "project-directory" })),
        FSUtil.use.writeWithDirs(homeDir, JSON.stringify({ username: "home-directory" })),
        FSUtil.use.writeWithDirs(configDirFile, JSON.stringify({ username: "OC2_CONFIG_DIR" })),
        FSUtil.use.writeWithDirs(managed, JSON.stringify({ username: "managed" })),
      ],
      { concurrency: "unbounded" },
    )

    const previousConfig = Global.Path.config
    ;(Global.Path as { config: string }).config = global
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ;(Global.Path as { config: string }).config = previousConfig
      }),
    )

    let preferences = true
    const readPreferences = spyOn(ConfigManaged, "readManagedPreferences").mockImplementation(async () =>
      preferences
        ? { source: "mobileconfig:test", text: JSON.stringify({ username: "managed-preferences" }) }
        : undefined,
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => readPreferences.mockRestore()))

    const current = () =>
      withInstanceDir(
        routed,
        Config.use.get().pipe(
          Effect.map((config) => config.username),
          Effect.ensuring(disposeAllInstancesEffect),
        ),
      )

    yield* withProcessEnvs(
      {
        OC2_CONFIG: custom,
        OC2_CONFIG_DIR: configDir,
        OC2_CONFIG_CONTENT: JSON.stringify({ username: "OC2_CONFIG_CONTENT" }),
        OC2_TEST_HOME: home,
      },
      Effect.gen(function* () {
        expect(yield* current()).toBe("managed-preferences")
        preferences = false
        expect(yield* current()).toBe("managed")
        yield* FSUtil.use.remove(managed)
        expect(yield* current()).toBe("OC2_CONFIG_CONTENT")
        delete process.env.OC2_CONFIG_CONTENT
        expect(yield* current()).toBe("OC2_CONFIG_DIR")
        yield* FSUtil.use.remove(configDirFile)
        expect(yield* current()).toBe("home-directory")
        yield* FSUtil.use.remove(homeDir)
        expect(yield* current()).toBe("project-directory")
        yield* FSUtil.use.remove(projectDir)
        expect(yield* current()).toBe("direct-project")
        yield* FSUtil.use.remove(direct)
        expect(yield* current()).toBe("OC2_CONFIG")
        yield* FSUtil.use.remove(custom)
        expect(yield* current()).toBe("global")
        yield* FSUtil.use.remove(path.join(global, "oc2.json"))
        expect(yield* current()).toBe("well-known")
      }),
    )
  }),
)

const remoteProjectOverride = wellKnown({
  config: {
    mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: false } },
  },
})

remoteProjectOverride.it.instance(
  "project config overrides remote well-known config",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(remoteProjectOverride.seen.wellKnown).toBe("https://example.com/.well-known/oc2")
      expect(config.mcp?.jira?.enabled).toBe(true)
    }),
  {
    git: true,
    config: { mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } } },
  },
)

const trailingSlashWellKnown = wellKnown({
  authUrl: "https://example.com/",
  config: {
    mcp: { slack: { type: "remote", url: "https://slack.example.com/mcp", enabled: true } },
  },
})

trailingSlashWellKnown.it.instance("wellknown URL with trailing slash is normalized", () =>
  Effect.gen(function* () {
    yield* Config.use.get()
    expect(trailingSlashWellKnown.seen.wellKnown).toBe("https://example.com/.well-known/oc2")
  }),
)

test("remote well-known config can use FetchHttpClient layer", async () => {
  let fetchedUrl: string | undefined
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      fetchedUrl = request.url
      return new Response(
        JSON.stringify({
          config: {
            mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp", enabled: true } },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    },
  })

  try {
    await provideTmpdirInstance(
      () =>
        Config.Service.use((svc) =>
          Effect.gen(function* () {
            const config = yield* svc.get()
            expect(fetchedUrl).toBe(`${server.url.origin}/.well-known/oc2`)
            expect(config.mcp?.jira?.enabled).toBe(true)
          }),
        ),
      { git: true },
    ).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Config.layer.pipe(
            Layer.provide(testFlock),
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(Env.defaultLayer),
            Layer.provide(wellKnownAuth(server.url.origin)),
            Layer.provideMerge(infra),
            Layer.provide(NpmTest.noop),
            Layer.provide(FetchHttpClient.layer),
          ),
          testInstanceStoreLayer,
        ),
      ),
      Effect.runPromise,
    )
  } finally {
    await server.stop(true)
  }
})

const templatedHeaderWellKnown = wellKnown({
  remoteConfig: {
    url: "https://config.example.com/oc2.json",
    headers: { Authorization: "Bearer {env:TEST_TOKEN}" },
  },
  remote: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } },
  },
})

templatedHeaderWellKnown.it.instance("wellknown remote_config supports templated env vars in headers", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(templatedHeaderWellKnown.seen.wellKnown).toBe("https://example.com/.well-known/oc2")
    expect(templatedHeaderWellKnown.seen.remote).toBe("https://config.example.com/oc2.json")
    expect(templatedHeaderWellKnown.seen.authorization).toBe("Bearer test-token")
    expect(config.mcp?.confluence?.enabled).toBe(true)
  }),
)

const remotePrecedenceWellKnown = wellKnown({
  config: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: false } },
  },
  remoteConfig: { url: "https://config.example.com/{env:TEST_TOKEN}/oc2.json" },
  remote: {
    config: { mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } } },
  },
})

remotePrecedenceWellKnown.it.instance(
  "wellknown remote_config url tokens and nested config override embedded config",
  () =>
    Effect.gen(function* () {
      const config = yield* Config.use.get()
      expect(remotePrecedenceWellKnown.seen.remote).toBe("https://config.example.com/test-token/oc2.json")
      expect(config.mcp?.confluence?.enabled).toBe(true)
    }),
)

const envIsolationWellKnown = wellKnown({
  remoteConfig: {
    url: "https://config.example.com/oc2.json",
    headers: { Authorization: "Bearer {env:TEST_TOKEN}" },
  },
  remote: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } },
  },
})

envIsolationWellKnown.it.instance(
  "wellknown token env substitution does not mutate process env",
  () =>
    Effect.gen(function* () {
      process.env.TEST_TOKEN = "preexisting-token"
      const config = yield* Config.use.get()
      expect(envIsolationWellKnown.seen.authorization).toBe("Bearer test-token")
      expect(config.username).toBe("test-token")
      expect(process.env.TEST_TOKEN).toBe("preexisting-token")
    }),
  { git: true, config: { username: "{env:TEST_TOKEN}" } },
)

const nullConfigWellKnown = wellKnown({
  wellKnown: {
    config: null,
    remote_config: { url: "https://config.example.com/oc2.json" },
  },
  remote: {
    mcp: { confluence: { type: "remote", url: "https://confluence.example.com/mcp", enabled: true } },
  },
})

nullConfigWellKnown.it.instance("wellknown config null is treated as absent", () =>
  Effect.gen(function* () {
    const config = yield* Config.use.get()
    expect(nullConfigWellKnown.seen.remote).toBe("https://config.example.com/oc2.json")
    expect(config.mcp?.confluence?.enabled).toBe(true)
  }),
)

const invalidRemoteWellKnown = wellKnown({
  remoteConfig: { url: "https://config.example.com/oc2.json" },
  remote: "not an object",
})

invalidRemoteWellKnown.it.instance("wellknown remote_config rejects non-object config responses", () =>
  Effect.gen(function* () {
    const exit = yield* Config.use.get().pipe(Effect.exit)
    expect(invalidRemoteWellKnown.seen.remote).toBe("https://config.example.com/oc2.json")
    expect(Exit.isFailure(exit)).toBe(true)
  }),
)

describe("resolvePluginSpec", () => {
  test("keeps package specs unchanged", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "oc2.json")
    expect(await ConfigPlugin.resolvePluginSpec("oh-my-opencode@2.4.3", file)).toBe("oh-my-opencode@2.4.3")
    expect(await ConfigPlugin.resolvePluginSpec("@scope/pkg", file)).toBe("@scope/pkg")
  })

  test("resolves windows-style relative plugin directory specs", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "oc2.json")
    const hit = await ConfigPlugin.resolvePluginSpec(".\\plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })

  test("resolves relative file plugin paths to file urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Filesystem.write(path.join(dir, "plugin.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "oc2.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin.ts", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin.ts")).href)
  })

  test("resolves plugin directory paths to directory urls", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.writeJson(path.join(plugin, "package.json"), {
          name: "demo-plugin",
          type: "module",
          main: "./index.ts",
        })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "oc2.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin")).href)
  })

  test("resolves plugin directories without package.json to index.ts", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const plugin = path.join(dir, "plugin")
        await fs.mkdir(plugin, { recursive: true })
        await Filesystem.write(path.join(plugin, "index.ts"), "export default {}")
      },
    })

    const file = path.join(tmp.path, "oc2.json")
    const hit = await ConfigPlugin.resolvePluginSpec("./plugin", file)
    expect(ConfigPlugin.pluginSpecifier(hit)).toBe(pathToFileURL(path.join(tmp.path, "plugin", "index.ts")).href)
  })
})

describe("deduplicatePluginOrigins", () => {
  const dedupe = (plugins: ConfigPluginV1.Spec[]) =>
    ConfigPlugin.deduplicatePluginOrigins(
      plugins.map((spec) => ({
        spec,
        source: "",
        scope: "global" as const,
      })),
    ).map((item) => item.spec)

  test("removes duplicates keeping higher priority (later entries)", () => {
    const plugins = ["global-plugin@1.0.0", "shared-plugin@1.0.0", "local-plugin@2.0.0", "shared-plugin@2.0.0"]

    const result = dedupe(plugins)

    expect(result).toContain("global-plugin@1.0.0")
    expect(result).toContain("local-plugin@2.0.0")
    expect(result).toContain("shared-plugin@2.0.0")
    expect(result).not.toContain("shared-plugin@1.0.0")
    expect(result.length).toBe(3)
  })

  test("keeps path plugins separate from package plugins", () => {
    const plugins = ["oh-my-opencode@2.4.3", "file:///project/.oc2/plugin/oh-my-opencode.js"]

    const result = dedupe(plugins)

    expect(result).toEqual(plugins)
  })

  test("deduplicates direct path plugins by exact spec", () => {
    const plugins = ["file:///project/.oc2/plugin/demo.ts", "file:///project/.oc2/plugin/demo.ts"]

    const result = dedupe(plugins)

    expect(result).toEqual(["file:///project/.oc2/plugin/demo.ts"])
  })

  test("preserves order of remaining plugins", () => {
    const plugins = ["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"]

    const result = dedupe(plugins)

    expect(result).toEqual(["a-plugin@1.0.0", "b-plugin@1.0.0", "c-plugin@1.0.0"])
  })

  it.effect("loads auto-discovered local plugins as file urls", () =>
    withConfigTree(
      { global: { plugin: ["my-plugin@1.0.0"] } },
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* FSUtil.use.writeWithDirs(
          path.join(test.directory, ".oc2", "plugin", "my-plugin.js"),
          "export default {}",
        )

        const plugins = (yield* Config.use.get()).plugin ?? []
        expect(plugins.some((p) => ConfigPlugin.pluginSpecifier(p) === "my-plugin@1.0.0")).toBe(true)
        expect(plugins.some((p) => ConfigPlugin.pluginSpecifier(p).startsWith("file://"))).toBe(true)
      }),
    ),
  )
})

describe("OC2_DISABLE_PROJECT_CONFIG", () => {
  it.instance(
    "skips project config files when flag is set",
    () =>
      withProcessEnv(
        "OC2_DISABLE_PROJECT_CONFIG",
        "true",
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.model).not.toBe("project/model")
          expect(config.username).not.toBe("project-user")
        }),
      ),
    { config: { model: "project/model", username: "project-user" } },
  )

  it.instance("skips project .oc2/ directories when flag is set", () =>
    withProcessEnv(
      "OC2_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* FSUtil.use.writeWithDirs(
          path.join(test.directory, ".oc2", "command", "test-cmd.md"),
          "# Test Command\nThis is a test command.",
        )
        const directories = yield* Config.use.directories()
        expect(directories.some((d) => d.startsWith(test.directory))).toBe(false)
      }),
    ),
  )

  it.instance("still loads global config when flag is set", () =>
    withProcessEnv(
      "OC2_DISABLE_PROJECT_CONFIG",
      "true",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        expect(config).toBeDefined()
        expect(config.username).toBeDefined()
      }),
    ),
  )

  it.instance(
    "skips relative instructions with warning when flag is set but no config dir",
    () =>
      withProcessEnvs(
        { OC2_CONFIG_DIR: undefined, OC2_DISABLE_PROJECT_CONFIG: "true" },
        Effect.gen(function* () {
          const test = yield* TestInstance
          yield* FSUtil.use.writeWithDirs(path.join(test.directory, "CUSTOM.md"), "# Custom Instructions")
          // The relative instruction should be skipped without error
          const config = yield* Config.use.get()
          expect(config).toBeDefined()
        }),
      ),
    { config: { instructions: ["./CUSTOM.md"] } },
  )

  it.instance(
    "OC2_CONFIG_DIR still works when flag is set",
    () =>
      Effect.gen(function* () {
        const configDir = yield* tmpdirScoped({ config: { model: "configdir/model" } })
        yield* withProcessEnvs(
          { OC2_DISABLE_PROJECT_CONFIG: "true", OC2_CONFIG_DIR: configDir },
          Effect.gen(function* () {
            const config = yield* Config.use.get()
            expect(config.model).toBe("configdir/model")
          }),
        )
      }),
    { config: { model: "project/model" } },
  )
})

// Regression for #28206: malformed OC2_PERMISSION JSON used to crash
// the app on startup with an unhandled SyntaxError. Loading the config with
// an invalid JSON value in this env var should not throw.
describe("OC2_PERMISSION env var", () => {
  it.instance("does not crash when OC2_PERMISSION contains invalid JSON", () =>
    withProcessEnv(
      "OC2_PERMISSION",
      "{invalid",
      Effect.gen(function* () {
        const config = yield* Config.use.get()
        // Regression: load() used to throw before returning anything.
        expect(config).toBeDefined()
      }),
    ),
  )
})

describe("OC2_CONFIG_CONTENT token substitution", () => {
  it.instance("substitutes {env:} tokens in OC2_CONFIG_CONTENT", () =>
    withProcessEnv(
      "TEST_CONFIG_VAR",
      "test_api_key_12345",
      withProcessEnv(
        "OC2_CONFIG_CONTENT",
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          username: "{env:TEST_CONFIG_VAR}",
        }),
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.username).toBe("test_api_key_12345")
        }),
      ),
    ),
  )

  it.instance("substitutes {file:} tokens in OC2_CONFIG_CONTENT", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* FSUtil.use.writeWithDirs(path.join(test.directory, "api_key.txt"), "secret_key_from_file")
      yield* withProcessEnv(
        "OC2_CONFIG_CONTENT",
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          username: "{file:./api_key.txt}",
        }),
        Effect.gen(function* () {
          const config = yield* Config.use.get()
          expect(config.username).toBe("secret_key_from_file")
        }),
      )
    }),
  )
})

// parseManagedPlist unit tests — pure function, no OS interaction

test("parseManagedPlist strips MDM metadata keys", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          PayloadDisplayName: "OpenCode Managed",
          PayloadIdentifier: "ai.oc2.managed.test",
          PayloadType: "ai.oc2.managed",
          PayloadUUID: "AAAA-BBBB-CCCC",
          PayloadVersion: 1,
          _manualProfile: true,
          model: "mdm/model",
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.model).toBe("mdm/model")
  // MDM keys must not leak into the parsed config
  expect((config as any).PayloadUUID).toBeUndefined()
  expect((config as any).PayloadType).toBeUndefined()
  expect((config as any)._manualProfile).toBeUndefined()
})

test("parseManagedPlist parses server settings", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          server: { hostname: "127.0.0.1", mdns: false },
          autoupdate: true,
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.server?.hostname).toBe("127.0.0.1")
  expect(config.server?.mdns).toBe(false)
  expect(config.autoupdate).toBe(true)
})

test("parseManagedPlist parses permission rules", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          permission: {
            "*": "ask",
            bash: { "*": "ask", "rm -rf *": "deny", "curl *": "deny" },
            grep: "allow",
            glob: "allow",
            webfetch: "ask",
            "~/.ssh/*": "deny",
          },
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.permission?.["*"]).toBe("ask")
  expect(config.permission?.grep).toBe("allow")
  expect(config.permission?.webfetch).toBe("ask")
  expect(config.permission?.["~/.ssh/*"]).toBe("deny")
  const bash = config.permission?.bash as Record<string, string>
  expect(bash?.["rm -rf *"]).toBe("deny")
  expect(bash?.["curl *"]).toBe("deny")
})

test("parseManagedPlist parses enabled_providers", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(
        JSON.stringify({
          $schema: Naming.configSchemaURL,
          enabled_providers: ["anthropic", "google"],
        }),
      ),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.enabled_providers).toEqual(["anthropic", "google"])
})

test("parseManagedPlist handles empty config", async () => {
  const config = ConfigParse.schema(
    ConfigV1.Info,
    ConfigParse.jsonc(
      await ConfigManaged.parseManagedPlist(JSON.stringify({ $schema: Naming.configSchemaURL })),
      "test:mobileconfig",
    ),
    "test:mobileconfig",
  )
  expect(config.$schema).toBe(Naming.configSchemaURL)
})
