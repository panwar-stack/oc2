import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Command } from "../../src/command"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Command.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("command", () => {
  it.live("includes renamed commands and projected skills", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const command = yield* Command.Service
          const specPlanner = yield* command.get("spec:planner")
          if (!specPlanner) throw new Error("spec:planner command not found")

          expect(specPlanner.source).toBe("command")
          expect(specPlanner.description).toContain("concrete engineering specs")
          expect(yield* Effect.promise(() => Promise.resolve(specPlanner.template))).toContain("Requirements To Spec")
          expect(yield* command.get("spec-planner")).toBeUndefined()

          const clarify = yield* command.get("clarify")
          if (!clarify) throw new Error("clarify command not found")

          expect(clarify.source).toBe("command")
          expect(clarify.description).toContain("Clarify underspecified requests")
          expect(yield* Effect.promise(() => Promise.resolve(clarify.template))).toContain("Clarify Request")
          expect(yield* Effect.promise(() => Promise.resolve(clarify.template))).toContain("/spec:planner")

          const useTeam = yield* command.get("use-team")
          if (!useTeam) throw new Error("use-team command not found")

          expect(useTeam.source).toBe("command")
          expect(useTeam.description).toBe("use agent team to accomplish the task")
          expect(useTeam.hints).toEqual(["$ARGUMENTS"])
          expect(yield* Effect.promise(() => Promise.resolve(useTeam.template))).toContain(
            "Use an agent team for this work:",
          )

          const spawn = yield* command.get("spawn")
          if (!spawn) throw new Error("spawn command not found")

          expect(spawn.source).toBe("command")
          expect(spawn.description).toBe("run a prompt in a background subtask")
          expect(spawn.model).toBe(Command.Model.SMALL)
          expect(spawn.subtask).toBe(true)
          expect(spawn.hints).toEqual(["$ARGUMENTS"])
          expect(yield* Effect.promise(() => Promise.resolve(spawn.template))).toContain("$ARGUMENTS")
          expect(yield* command.get("fast")).toBeUndefined()

          const implementSpecPr = yield* command.get("spec:implement")
          if (!implementSpecPr) throw new Error("spec:implement command not found")

          expect(implementSpecPr.source).toBe("command")
          expect(implementSpecPr.description).toBe(
            "Understand a specification thoroughly and implement only the requested scope.",
          )
          const template = yield* Effect.promise(() => Promise.resolve(implementSpecPr.template))

          expect(implementSpecPr.hints).toEqual(["$1", "$2"])
          expect(template).toContain("Resolve and read the specification at $1 before editing.")
          expect(template).toContain("If a positive slice number $2 is supplied")
          expect(template).toContain("Work only in the supplied Location.")
          expect(template).toContain("Do not create or switch branches or git worktrees")
          expect(template).toContain("do not commit, merge, rebase, cherry-pick, push, or integrate changes")
          expect(template).toContain("Never edit another Location or an external directory.")
          expect(template).toContain("$1 is required")
          expect(template).toContain("$2 is optional")
          expect(template).toContain("Never accept an all-slices form.")
          expect(template).toContain("When team tools are available outside automation, you may use a team")
          expect(template).toContain("Automation does not provide delegation or team tools")
          expect(template).toContain("Do not perform git integration or cleanup.")
          expect(yield* command.get("spec-implement")).toBeUndefined()

          const learn = yield* command.get("learn")
          if (!learn) throw new Error("learn command not found")

          expect(learn.source).toBe("command")
          expect(learn.description).toContain("non-obvious learnings")
          expect(learn.hints).toEqual(["$ARGUMENTS"])
          expect(yield* Effect.promise(() => Promise.resolve(learn.template))).toContain("AGENTS.md files can exist")
          expect(yield* Effect.promise(() => Promise.resolve(learn.template))).toContain("$ARGUMENTS")

          const teamReport = yield* command.get("team-report")
          if (!teamReport) throw new Error("team-report command not found")

          expect(teamReport.source).toBe("skill")
          expect(teamReport.description).toBe(
            "Generate a post-run agent-team effectiveness report and optional baseline comparisons.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(teamReport.template))).toContain("team_report")
          expect(yield* Effect.promise(() => Promise.resolve(teamReport.template))).toContain("compare_session_ids")

          const localFusion = yield* command.get("local:fusion")
          if (!localFusion) throw new Error("local:fusion command not found")

          expect(localFusion.source).toBe("command")
          expect(localFusion.description).toBe("Run a named local_fusion config with a prompt.")
          expect(localFusion.hints).toEqual(["$1", "$2"])
          expect(yield* Effect.promise(() => Promise.resolve(localFusion.template))).toContain("local_fusion")
          expect(yield* Effect.promise(() => Promise.resolve(localFusion.template))).toContain("`config`: `$1`")
          expect(yield* Effect.promise(() => Promise.resolve(localFusion.template))).toContain("`prompt`: `$2`")
          expect(yield* command.get("local_fusion")).toBeUndefined()
          expect(yield* command.get("review")).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("keeps protected built-in commands immutable only for automation", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const command = yield* Command.Service
          const configuredPlanner = yield* command.get("spec:planner")
          const configuredImplementer = yield* command.get("spec:implement")
          const automationPlanner = yield* command.get("spec:planner", { automation: true })
          const automationImplementer = yield* command.get("spec:implement", { automation: true })

          expect(configuredPlanner?.template).toBe("PROJECT PLANNER OVERRIDE")
          expect(configuredImplementer?.template).toBe("PROJECT IMPLEMENTER OVERRIDE")
          expect(configuredImplementer?.variant).toBe("project-variant")
          expect(automationPlanner?.template).toContain("Requirements To Spec")
          expect(automationPlanner?.template).toContain("Do not ask questions during this command.")
          expect(automationPlanner?.template).toContain("review the plan directly without delegating work")
          expect(automationPlanner?.template).toContain("Do not write repository files.")
          expect(automationImplementer?.template).toContain("Work only in the supplied Location.")
          expect(automationImplementer?.variant).toBeUndefined()
        }),
      {
        config: {
          command: {
            "spec:planner": { template: "PROJECT PLANNER OVERRIDE" },
            "spec:implement": { template: "PROJECT IMPLEMENTER OVERRIDE", variant: "project-variant" },
          },
        },
      },
    ),
  )

  it.live("includes merged init command", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const command = yield* Command.Service
          const init = yield* command.get("init")
          if (!init) throw new Error("init command not found")

          expect(init.source).toBe("command")
          expect(init.description).toBe("guided AGENTS.md setup with required engineering principles")
          expect(init.hints).toEqual(["$ARGUMENTS"])
          expect(yield* Effect.promise(() => Promise.resolve(init.template))).toContain(
            "Create or update `AGENTS.md` for this repository.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(init.template))).toContain("Run `oc2 memory index`")
          expect(yield* Effect.promise(() => Promise.resolve(init.template))).toContain(
            "Think before coding - Don't assume.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(init.template))).toContain(
            "Simplicity first - Minimum code that solves the problem.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(init.template))).toContain(
            "Surgical changes - Touch only what you must.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(init.template))).toContain(
            "Goal-driven execution - Define success criteria.",
          )
          expect(yield* Effect.promise(() => Promise.resolve(init.template))).toContain(dir)
          expect(yield* command.get("init_v2")).toBeUndefined()
        }),
      { git: true },
    ),
  )
})

test("command arguments preserve quoted paths and reject malformed quotes", () => {
  expect(Command.parseArguments('"specs/path with spaces.md" 4')).toEqual(["specs/path with spaces.md", "4"])
  expect(Command.parseArguments("[Image 1] describe it")).toEqual(["[Image 1]", "describe", "it"])
  expect(Command.validAutomationArguments("spec:implement", "specs/feature.md")).toBe(true)
  expect(Command.validAutomationArguments("spec:implement", '"specs/path with spaces.md" 4')).toBe(true)
  expect(Command.validAutomationArguments("spec:implement", "")).toBe(false)
  expect(Command.validAutomationArguments("spec:implement", '" "')).toBe(false)
  expect(Command.validAutomationArguments("spec:implement", '" " 4')).toBe(false)
  expect(Command.validAutomationArguments("spec:implement", "specs/feature.md 0")).toBe(false)
  expect(Command.validAutomationArguments("spec:implement", "specs/feature.md all")).toBe(false)
  expect(Command.validAutomationArguments("spec:implement", "specs/feature.md 1 extra")).toBe(false)
  expect(Command.validAutomationArguments("spec:implement", '"specs/feature.md 4')).toBe(false)
  expect(Command.validAutomationArguments("custom", '"unterminated')).toBe(false)
  expect(Command.validAutomationRole("spec:planner", "issue-planner")).toBe(true)
  expect(Command.validAutomationRole("spec:planner", "issue-task")).toBe(false)
  expect(Command.validAutomationRole("spec:implement", "issue-implementer")).toBe(true)
  expect(Command.validAutomationRole("spec:implement", "issue-task")).toBe(false)
  expect(Command.validAutomationRole("custom", "issue-task")).toBe(true)
})
