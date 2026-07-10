import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CommandV2 } from "@oc2-ai/core/command"
import { Config } from "@oc2-ai/core/config"
import { ConfigCommandPlugin } from "@oc2-ai/core/config/plugin/command"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { ModelV2 } from "@oc2-ai/core/model"
import { ProviderV2 } from "@oc2-ai/core/provider"
import { AbsolutePath } from "@oc2-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CommandV2.locationLayer, FSUtil.defaultLayer))
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigCommandPlugin.Plugin", () => {
  it.live("loads inline and file-based commands in config order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "commands", "nested"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "commands", "deploy.md"),
              `---
description: File deploy
agent: deployer
model: anthropic/claude
variant: high
subtask: true
---
Deploy files`,
            )
            await fs.writeFile(path.join(tmp.path, "commands", "nested", "docs.md"), "Write docs")
            await fs.writeFile(path.join(tmp.path, "commands", "empty.md"), "")
          })

          const command = yield* CommandV2.Service
          yield* ConfigCommandPlugin.Plugin.effect.pipe(
            Effect.provideService(CommandV2.Service, command),
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([
                    new Config.Document({
                      type: "document",
                      info: decode({ commands: { deploy: { template: "Inline deploy" } } }),
                    }),
                    new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) }),
                  ]),
              }),
            ),
          )

          expect(yield* command.list()).toEqual([
            new CommandV2.Info({
              name: "deploy",
              template: "Deploy files",
              description: "File deploy",
              agent: "deployer",
              model: {
                providerID: ProviderV2.ID.make("anthropic"),
                id: ModelV2.ID.make("claude"),
                variant: ModelV2.VariantID.make("high"),
              },
              subtask: true,
            }),
            new CommandV2.Info({ name: "empty", template: "" }),
            new CommandV2.Info({ name: "nested/docs", template: "Write docs" }),
          ])
        }),
      ),
    ),
  )
})
