import type { SlashCommand } from "./types"

export const createBuiltinCommands = (): readonly SlashCommand[] => [
  {
    name: "review",
    description: "review changes",
    source: "builtin",
    template:
      "Review the following code changes for correctness, security, and style issues. Focus on the diff provided below.\n\n$ARGUMENTS",
    subtask: true,
  },
  {
    name: "clarify",
    description: "clarify underspecified requests",
    source: "builtin",
    template: "skill:clarify",
  },
  {
    name: "spec-planner",
    description: "create an implementation specification",
    source: "builtin",
    template: "skill:spec-planner",
  },
  {
    name: "spec-implement",
    description: "implement a specification slice",
    source: "builtin",
    template: "skill:spec-implement",
  },
  {
    name: "team-report",
    description: "generate an agent team effectiveness report",
    source: "builtin",
    template: "skill:team-report",
  },
  {
    name: "init",
    description: "initialize project context",
    source: "builtin",
    template: "skill:initialize",
  },
]
