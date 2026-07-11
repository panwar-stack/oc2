import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Tool } from "@oc2-ai/core/public"
import { Catalog } from "@oc2-ai/core/catalog"
import { LocationServiceMap } from "@oc2-ai/core/location-layer"
import { FileSystem } from "@oc2-ai/core/filesystem"
import { PermissionV2 } from "@oc2-ai/core/permission"
import { PluginBoot } from "@oc2-ai/core/plugin/boot"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { AbsolutePath } from "@oc2-ai/core/schema"
import { SessionRunner } from "@oc2-ai/core/session/runner"
import { SessionRunnerModel } from "@oc2-ai/core/session/runner/model"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"
import { FSUtil } from "../src/fs-util"
import { Auth } from "../src/auth"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { ModelsDev } from "../src/models-dev"
import { Npm } from "../src/npm"
import { Project } from "../src/project"
import { ProjectReference } from "../src/project-reference"
import { LocationSearch } from "../src/location-search"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"

const applicationTools = ApplicationTools.layer
const it = testEffect(
  Layer.merge(
    applicationTools,
    LocationServiceMap.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Project.defaultLayer,
          EventV2.defaultLayer,
          Auth.defaultLayer,
          Npm.defaultLayer,
          ModelsDev.defaultLayer,
          FSUtil.defaultLayer,
          Global.defaultLayer,
        ),
      ),
    ),
  ),
)

describe("LocationServiceMap", () => {
  it.live("isolates runner, model, tools, permissions, and filesystem by location", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap((dirs) =>
        Effect.forEach(dirs, (dir) =>
          Effect.gen(function* () {
            const filesystem = yield* FileSystem.Service
            return {
              filesystem,
              model: yield* SessionRunnerModel.Service,
              permission: yield* PermissionV2.Service,
              root: yield* filesystem.resolveRoot(),
              runner: yield* SessionRunner.Service,
              tools: yield* ToolRegistry.Service,
            }
          }).pipe(Effect.provide(LocationServiceMap.get({ directory: AbsolutePath.make(dir.path) }))),
        ),
      ),
      Effect.tap(([first, second]) =>
        Effect.sync(() => {
          expect(first.root.root).not.toBe(second.root.root)
          expect(first.runner).not.toBe(second.runner)
          expect(first.model).not.toBe(second.model)
          expect(first.tools).not.toBe(second.tools)
          expect(first.permission).not.toBe(second.permission)
          expect(first.filesystem).not.toBe(second.filesystem)
        }),
      ),
    ),
  )

  it.live("isolates location state while sharing location policy with catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([blocked, allowed]) =>
        Effect.gen(function* () {
          yield* (yield* ApplicationTools.Service).register({
            application_context: Tool.make({
              description: "Read application context",
              input: Schema.Struct({}),
              output: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
          })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(blocked.path, "oc2.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "test" }] },
              }),
            ),
          )

          const update = (directory: string) =>
            Effect.gen(function* () {
              yield* PluginBoot.Service.use((boot) => boot.wait())
              yield* ProjectReference.Service
              yield* LocationSearch.Service
              const catalog = yield* Catalog.Service
              const transform = yield* catalog.transform()
              yield* transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
              return {
                providers: yield* catalog.provider.all(),
                tools: yield* toolDefinitions(yield* ToolRegistry.Service),
              }
            }).pipe(Effect.scoped, Effect.provide(LocationServiceMap.get({ directory: AbsolutePath.make(directory) })))

          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(false)
          expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "edit",
            "glob",
            "grep",
            "question",
            "read",
            "skill",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "edit",
            "glob",
            "grep",
            "question",
            "read",
            "skill",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
        }),
      ),
    ),
  )
})
