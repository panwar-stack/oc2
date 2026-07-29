import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option } from "effect"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { Naming } from "@oc2-ai/core/naming"
import { Npm } from "@oc2-ai/core/npm"
import { EffectFlock } from "@oc2-ai/core/util/effect-flock"
import { FetchHttpClient } from "effect/unstable/http"
import { ConfigPaths } from "../../src/config/paths"
import { Config } from "../../src/config/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { AuthTest } from "../fake/auth"
import { ProjectV2 } from "@oc2-ai/core/project"
import {
  DependencyIndex,
  InternalWriteAttribution,
  canonicalConfigPath,
  fingerprint,
  restartRequired,
} from "../../src/config/hot-reload"

describe("config hot reload primitives", () => {
  test("effective fingerprint ignores formatting, key order, undefined, and plugin provenance", () => {
    const left = {
      model: "provider/model",
      provider: { beta: { options: { token: "x" } }, alpha: {} },
      plugin_origins: [{ source: "/one" }],
      optional: undefined,
    }
    const right = {
      provider: { alpha: {}, beta: { options: { token: "x" } } },
      model: "provider/model",
      plugin_origins: [{ source: "/two" }],
    }

    expect(fingerprint(left)).toBe(fingerprint(right))
    expect(fingerprint(left)).not.toBe(fingerprint({ ...right, model: "provider/other" }))
  })

  test("fingerprint preserves array precedence", () => {
    expect(fingerprint({ plugin: ["a", "b"] })).not.toBe(fingerprint({ plugin: ["b", "a"] }))
  })

  test("fingerprint excludes only root metadata", () => {
    expect(fingerprint({ $schema: "one", model: "same" })).toBe(
      fingerprint({ $schema: "two", model: "same" }),
    )
    expect(fingerprint({ nested: { plugin_origins: ["one"] } })).not.toBe(
      fingerprint({ nested: { plugin_origins: ["two"] } }),
    )
  })

  test("internal write attribution is canonical, digest-bound, and consumed once", () => {
    const writes = new InternalWriteAttribution()
    const file = path.join("/repo", "nested", "..", "oc2.json")
    writes.record(file, "expected")

    expect(writes.consume("/repo/oc2.json", "native replacement")).toBe(false)
    expect(writes.consume("/repo/oc2.json", "expected")).toBe(true)
    expect(writes.consume("/repo/oc2.json", "expected")).toBe(false)
  })

  test("restart requirements contain only changed process-owned field names", () => {
    const before = {
      server: { port: 1, hostname: "a", mdns: false, mdnsDomain: "a.local", cors: ["a"] },
      host: "a",
      keybinds: { quit: "q" },
      theme: "dark",
      autoupdate: false,
      model: "old",
    }
    const after = {
      server: { port: 2, hostname: "b", mdns: true, mdnsDomain: "b.local", cors: ["b"] },
      host: "b",
      keybinds: { quit: "x" },
      theme: "light",
      autoupdate: "notify",
      model: "new",
    }
    expect(restartRequired(before, after)).toEqual([
      "port",
      "hostname",
      "mdns",
      "mdnsDomain",
      "cors",
      "host",
      "keybinds",
      "theme",
      "autoupdate",
    ])
  })

  test("restart requirements detect each process-owned field directly and ignore unchanged snapshots", () => {
    const cases = [
      [{ server: { port: 1 } }, { server: { port: 2 } }, "port"],
      [{ server: { hostname: "a" } }, { server: { hostname: "b" } }, "hostname"],
      [{ server: { mdns: false } }, { server: { mdns: true } }, "mdns"],
      [{ server: { mdnsDomain: "a.local" } }, { server: { mdnsDomain: "b.local" } }, "mdnsDomain"],
      [{ server: { cors: ["a"] } }, { server: { cors: ["b"] } }, "cors"],
      [{ theme: "dark" }, { theme: "light" }, "theme"],
      [{ keybinds: { quit: "q" } }, { keybinds: { quit: "x" } }, "keybinds"],
      [{ host: "a" }, { host: "b" }, "host"],
      [{ autoupdate: false }, { autoupdate: "notify" }, "autoupdate"],
    ] as const
    for (const [before, after, field] of cases) expect(restartRequired(before, after)).toEqual([field])
    const unchanged = { server: { port: 1, cors: ["a"] }, theme: "dark", plugin: ["one"] }
    expect(restartRequired(unchanged, structuredClone(unchanged))).toEqual([])
  })

  test("dependency commits atomically replace a generation's candidates", () => {
    const index = new DependencyIndex()
    const consumer = { directory: "/repo/app", workspaceID: "workspace", generation: 2 }
    const oldPath = path.join("/repo", "oc2.json")
    const absentPath = path.join("/repo/app", ".oc2", "oc2.jsonc")

    index.commit(consumer, [oldPath, absentPath, absentPath])
    expect(index.consumers(absentPath)).toEqual([consumer])
    expect(index.dependencies(consumer)).toEqual([canonicalConfigPath(oldPath), canonicalConfigPath(absentPath)])

    const replacement = path.join("/repo/app", "oc2.json")
    index.commit(consumer, [replacement])
    expect(index.consumers(oldPath)).toEqual([])
    expect(index.consumers(absentPath)).toEqual([])
    expect(index.consumers(replacement)).toEqual([consumer])
  })

  test("dependency rejection leaves the committed generation unchanged", () => {
    const index = new DependencyIndex()
    const active = { directory: "/repo", generation: 1 }
    const candidate = { directory: "/repo", generation: 2 }
    const global = "/global/oc2.json"

    index.commit(active, [global])
    // Failed candidates never call commit.
    expect(index.consumers(global)).toEqual([active])
    expect(index.dependencies(candidate)).toEqual([])
  })

  test("canonicalizes absent candidates without requiring filesystem access", () => {
    expect(canonicalConfigPath("/repo/app/../.oc2/oc2.json")).toBe("/repo/.oc2/oc2.json")
  })

  test("plans absent direct and .oc2 candidates at every ancestor through the worktree", async () => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc2-path-plan-"))
    const directory = path.join(root, "packages", "app")
    const explicit = path.join(root, "explicit.jsonc")
    const configDir = path.join(root, "custom-config")
    const previousConfig = process.env.OC2_CONFIG
    const previousConfigDir = process.env.OC2_CONFIG_DIR
    try {
      await fs.mkdir(directory, { recursive: true })
      process.env.OC2_CONFIG = explicit
      process.env.OC2_CONFIG_DIR = configDir
      const plan = await Effect.runPromise(
        ConfigPaths.plan(directory, root).pipe(Effect.provide(FSUtil.defaultLayer)),
      )

      for (const ancestor of [root, path.join(root, "packages"), directory]) {
        for (const file of Naming.configFiles) expect(plan.candidates).toContain(path.join(ancestor, file))
        for (const configName of Naming.configDirs) {
          for (const file of Naming.configFileLoadOrder) {
            expect(plan.candidates).toContain(path.join(ancestor, configName, file))
          }
        }
      }
      expect(plan.candidates).toContain(explicit)
      for (const file of Naming.configFileLoadOrder) expect(plan.candidates).toContain(path.join(configDir, file))
    } finally {
      if (previousConfig === undefined) delete process.env.OC2_CONFIG
      else process.env.OC2_CONFIG = previousConfig
      if (previousConfigDir === undefined) delete process.env.OC2_CONFIG_DIR
      else process.env.OC2_CONFIG_DIR = previousConfigDir
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("awaits candidate plugin dependency installation inside readiness", async () => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc2-install-barrier-"))
    const pluginDir = path.join(root, ".oc2", "plugin")
    await fs.mkdir(pluginDir, { recursive: true })
    await fs.writeFile(path.join(pluginDir, "test.ts"), "export default async () => ({})")
    const started = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    const completed = await Effect.runPromise(Deferred.make<void>())
    const npm = Layer.mock(Npm.Service)({
      install: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      add: () => Effect.succeed({ directory: root, entrypoint: Option.none() }),
      which: () => Effect.succeed(Option.none()),
    })
    const layer = Config.layer.pipe(
      Layer.provide(EffectFlock.defaultLayer),
      Layer.provide(AuthTest.empty),
      Layer.provide(npm),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(FetchHttpClient.layer),
    )
    const ctx = {
      directory: root,
      worktree: root,
      generation: 2,
      revision: 2,
      globalEpoch: 0,
      fingerprint: "",
      configDependencies: [],
      state: "booting" as const,
      candidate: true,
      project: {
        id: ProjectV2.ID.make("candidate-install"),
        worktree: root,
        time: { created: 0, updated: 0 },
        sandboxes: [root],
      },
    }
    try {
      const fiber = Effect.runFork(
        Config.Service.use((service) => service.get()).pipe(
          Effect.provideService(InstanceRef, ctx),
          Effect.scoped,
          Effect.provide(layer),
        ),
      )
      Effect.runFork(Fiber.await(fiber).pipe(Effect.andThen(Deferred.succeed(completed, undefined))))
      await Effect.runPromise(Deferred.await(started))
      expect(await Effect.runPromise(Deferred.isDone(completed))).toBe(false)
      await Effect.runPromise(Deferred.succeed(release, undefined))
      await Effect.runPromise(Fiber.join(fiber))
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
