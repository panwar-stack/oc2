import { expect, test } from "bun:test"

import { defaultConfig, defaultDisabledSubAgentTools, deriveSubAgentConfig, resolveSubAgentProfile } from "../../src"

test("subagent permissions preserve parent denies after child allows", () => {
  const config = {
    ...defaultConfig,
    tools: { write: { enabled: true, permissions: [{ match: "write:*", decision: "deny" as const }] } },
    agents: { worker: subagentProfile([{ match: "write:*", decision: "allow" as const }]) },
  }
  const profile = resolveSubAgentProfile(config, "worker")

  const child = deriveSubAgentConfig(config, profile!)

  expect(child.tools.write?.permissions?.at(-1)).toEqual({ match: "write:*", decision: "deny" })
})

test("subagent parent deny inheritance remains scoped to the source tool", () => {
  const config = {
    ...defaultConfig,
    tools: {
      write: { enabled: true, permissions: [{ match: "*", decision: "deny" as const }] },
      read: { enabled: true, permissions: [] },
    },
    agents: { worker: subagentProfile() },
  }
  const profile = resolveSubAgentProfile(config, "worker")

  const child = deriveSubAgentConfig(config, profile!)

  expect(child.tools.write?.permissions).toContainEqual({ match: "*", decision: "deny" })
  expect(child.tools.read?.permissions).toEqual([])
})

test("subagents disable recursive subagent and team tools by default", () => {
  const config = {
    ...defaultConfig,
    agents: { worker: subagentProfile() },
  }
  const profile = resolveSubAgentProfile(config, "worker")

  const child = deriveSubAgentConfig(config, profile!)

  for (const toolName of defaultDisabledSubAgentTools()) {
    expect(child.tools[toolName]?.enabled).toBe(false)
  }
})

test("primary-only profiles are not resolved as subagents", () => {
  const config = { ...defaultConfig, agents: { helper: { ...subagentProfile(), mode: "primary" as const } } }

  expect(resolveSubAgentProfile(config, "helper")).toBeUndefined()
})

function subagentProfile(allowedTools: (typeof defaultConfig.agents)[string]["allowedTools"] = []) {
  return { mode: "subagent" as const, allowedTools, maxIterations: 20 }
}
