import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { describe, expect } from "bun:test"
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
          expect(yield* Effect.promise(() => Promise.resolve(clarify.template))).toContain("/spec-planner")

          const useTeam = yield* command.get("use-team")
          if (!useTeam) throw new Error("use-team command not found")

          expect(useTeam.source).toBe("command")
          expect(useTeam.description).toBe("use agent team to accomplish the task")
          expect(useTeam.hints).toEqual(["$ARGUMENTS"])
          expect(yield* Effect.promise(() => Promise.resolve(useTeam.template))).toContain(
            "use agent teams to do the following",
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
            "Understand a specification thoroughly and implement only the requested PR slice.",
          )
          expect(implementSpecPr.hints).toEqual(["$1", "$2"])
          expect(yield* Effect.promise(() => Promise.resolve(implementSpecPr.template))).toContain(
            "If PR #$2 is provided, implement only that pull request from $1. commit.",
          )
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
          expect(yield* Effect.promise(() => Promise.resolve(init.template))).toContain("Run `opencode memory index`")
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
