import { expect, test } from "bun:test"

import { defaultConfig } from "../../src/config/schema"
import { runDependencyChecks } from "../../src/diagnostics/dependency-checks"
import { createDiagnostic, createDiagnosticReport } from "../../src/diagnostics/diagnostics"
import { collectEnvironmentInfo } from "../../src/diagnostics/environment"

test("creates structured diagnostic reports", () => {
  const diagnostic = createDiagnostic("warning", "test.warning", "Something happened", { path: "config.model" })
  const report = createDiagnosticReport({ cwd: "/repo" }, [diagnostic], "2026-01-01T00:00:00.000Z")

  expect(report).toEqual({
    generatedAt: "2026-01-01T00:00:00.000Z",
    environment: { cwd: "/repo" },
    diagnostics: [diagnostic],
  })
})

test("collects environment info without secrets", () => {
  const info = collectEnvironmentInfo({ cwd: "/repo", homeDir: "/home/test", env: { OC2_DATA_DIR: "./data" } })

  expect(info.cwd).toBe("/repo")
  expect(info.config).toEqual({
    user: "/home/test/.config/oc2/config.jsonc",
    project: ["/repo/oc2.jsonc", "/repo/.oc2/config.jsonc"],
    explicit: null,
  })
  expect(info.dataDir).toBe("/repo/data")
  expect(JSON.stringify(info)).not.toContain("API_KEY")
})

test("warns for missing enabled stdio MCP commands", async () => {
  const diagnostics = await runDependencyChecks(
    {
      ...defaultConfig,
      mcp: {
        missing: {
          enabled: true,
          transport: "stdio",
          command: "missing-command",
          args: [],
          env: {},
          headers: {},
          toolPermissions: [],
          startupTimeoutMs: 10_000,
        },
      },
    },
    { commandExists: () => false },
  )

  expect(diagnostics).toEqual([
    {
      level: "warning",
      code: "diagnostics.mcp.command_missing",
      message: "MCP command not found for missing",
      path: "mcp.missing.command",
      details: { command: "missing-command" },
    },
  ])
})
