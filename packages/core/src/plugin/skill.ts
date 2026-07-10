/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { Effect } from "effect"
import { PluginV2 } from "../plugin"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-opencode.md" with { type: "text" }
import specPlannerContent from "./skill/spec-planner.md" with { type: "text" }
import teamReportContent from "./skill/team-report.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent
export const CustomizeOpencodeDescription =
  "Use ONLY when the user is editing or creating OC2's own configuration: oc2.json, oc2.jsonc, files under .oc2/, or files under ~/.config/oc2/. Also use when creating or fixing OC2 agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring OC2 itself."
export const SpecPlannerContent = specPlannerContent
export const TeamReportContent = teamReportContent

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("skill"),
  effect: Effect.gen(function* () {
    const skill = yield* SkillV2.Service
    const transform = yield* skill.transform()

    yield* transform((editor) => {
      editor.source(
        new SkillV2.EmbeddedSource({
          type: "embedded",
          skill: new SkillV2.Info({
            name: "customize-opencode",
            description: CustomizeOpencodeDescription,
            location: AbsolutePath.make("/builtin/customize-opencode.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
      )
      editor.source(
        new SkillV2.EmbeddedSource({
          type: "embedded",
          skill: new SkillV2.Info({
            name: "spec-planner",
            description:
              "Convert rough user requirements, feature ideas, bug themes, or implementation goals into concrete engineering specs. Use when Codex needs to draft a Markdown spec, implementation plan, PR breakdown, acceptance criteria, verification plan, or repo-ready proposal.",
            location: AbsolutePath.make("/builtin/spec-planner.md"),
            content: SpecPlannerContent,
          }),
        }),
      )
      editor.source(
        new SkillV2.EmbeddedSource({
          type: "embedded",
          skill: new SkillV2.Info({
            name: "team-report",
            description: "Generate a post-run agent-team effectiveness report and optional baseline comparisons.",
            location: AbsolutePath.make("/builtin/team-report.md"),
            content: TeamReportContent,
          }),
        }),
      )
    })
  }),
})
