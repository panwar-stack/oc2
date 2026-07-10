import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@oc2-ai/core/agent"
import { FSUtil } from "@oc2-ai/core/fs-util"
import { SkillPlugin } from "@oc2-ai/core/plugin/skill"
import { SkillV2 } from "@oc2-ai/core/skill"
import { SkillDiscovery } from "@oc2-ai/core/skill/discovery"
import { testEffect } from "../lib/effect"

const it = testEffect(
  SkillV2.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(SkillDiscovery.defaultLayer),
    Layer.provideMerge(AgentV2.locationLayer),
  ),
)

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-opencode skill", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect.pipe(Effect.provideService(SkillV2.Service, skill))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-opencode",
          description:
            "Use ONLY when the user is editing or creating OC2's own configuration: oc2.json, oc2.jsonc, files under .oc2/, or files under ~/.config/oc2/. Also use when creating or fixing OC2 agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring OC2 itself.",
        }),
      )
    }),
  )
})
