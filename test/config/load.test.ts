import { expect, test } from "bun:test"

import { loadConfig } from "../../src/config/load"

test("loads config with defaults, user, project, env, and CLI precedence", async () => {
  const files = new Map([
    [
      "/home/test/.config/oc2/config.jsonc",
      JSON.stringify({
        model: { provider: "user", model: "small" },
        runtime: { logLevel: "debug" },
      }),
    ],
    [
      "/repo/oc2.jsonc",
      JSON.stringify({
        model: { model: "project" },
        runtime: { maxConcurrentTools: 7 },
      }),
    ],
  ])

  const loaded = await loadConfig({
    cwd: "/repo",
    homeDir: "/home/test",
    env: { OC2_MODEL: "env/model", OC2_LOG_LEVEL: "warn" },
    cliOverrides: { model: { model: "cli" }, runtime: { maxConcurrentTeamMembers: 9 } },
    fileExists: async (path) => files.has(path),
    readFile: async (path) => files.get(path) ?? "",
  })

  expect(loaded.config.model).toEqual({ provider: "env", model: "cli" })
  expect(loaded.config.runtime.logLevel).toBe("warn")
  expect(loaded.config.runtime.maxConcurrentTools).toBe(7)
  expect(loaded.config.runtime.maxConcurrentTeamMembers).toBe(9)
  expect(loaded.config.tui.theme).toBe("opencode")
})

test("reports invalid JSONC without throwing", async () => {
  const loaded = await loadConfig({
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async (path) => path === "/repo/oc2.jsonc",
    readFile: async () => "{ model: ",
  })

  expect(loaded.config.model.provider).toBe("fake")
  expect(loaded.diagnostics.some((diagnostic) => diagnostic.code === "config.invalid_jsonc")).toBe(true)
})

test("reports unknown and invalid config keys", async () => {
  const loaded = await loadConfig({
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async (path) => path === "/repo/oc2.jsonc",
    readFile: async () =>
      JSON.stringify({
        legacyMcpServers: {},
        runtime: { logLevel: "verbose" },
      }),
  })

  expect(loaded.diagnostics.some((diagnostic) => diagnostic.code === "config.unknown_key")).toBe(true)
  expect(loaded.diagnostics.some((diagnostic) => diagnostic.code === "config.invalid")).toBe(true)
  expect(loaded.config.model.provider).toBe("fake")
  expect(loaded.config.runtime.maxConcurrentTools).toBe(4)
})

test("preserves valid config fields when another field is invalid", async () => {
  const loaded = await loadConfig({
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async (path) => path === "/repo/oc2.jsonc",
    readFile: async () =>
      JSON.stringify({
        model: { provider: "project", model: "valid" },
        runtime: { maxConcurrentTools: 8, logLevel: "verbose" },
        tui: { sidePanel: false },
      }),
  })

  expect(loaded.config.model).toEqual({ provider: "project", model: "valid" })
  expect(loaded.config.runtime.maxConcurrentTools).toBe(8)
  expect(loaded.config.runtime.logLevel).toBe("info")
  expect(loaded.config.tui.sidePanel).toBe(false)
})

test("preserves valid nested record entries when another entry is invalid", async () => {
  const loaded = await loadConfig({
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async (path) => path === "/repo/oc2.jsonc",
    readFile: async () =>
      JSON.stringify({
        mcp: {
          valid: { transport: "stdio", command: "server" },
          invalid: { transport: "stdio" },
        },
      }),
  })

  expect(loaded.config.mcp.valid?.command).toBe("server")
  expect(loaded.config.mcp.invalid).toBeUndefined()
})

test("accepts command config fields and preserves them during repair", async () => {
  const loaded = await loadConfig({
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async (path) => path === "/repo/oc2.jsonc",
    readFile: async () =>
      JSON.stringify({
        runtime: { logLevel: "verbose" },
        commands: {
          review: {
            description: "Custom review",
            aliases: ["rev"],
            template: "Review this: $ARGUMENTS",
            subtask: true,
            agent: "reviewer",
            model: "fake/test",
          },
          invalid: { aliases: "bad" },
        },
      }),
  })

  expect(loaded.config.commands.review).toMatchObject({
    description: "Custom review",
    aliases: ["rev"],
    template: "Review this: $ARGUMENTS",
    subtask: true,
    agent: "reviewer",
    model: "fake/test",
  })
  expect(loaded.config.commands.invalid).toBeUndefined()
  expect(loaded.diagnostics.some((diagnostic) => diagnostic.code === "config.unknown_key")).toBe(false)
})

test("accepts canonical SPEC MCP metadata and OAuth fields", async () => {
  const loaded = await loadConfig({
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async (path) => path === "/repo/oc2.jsonc",
    readFile: async () =>
      JSON.stringify({
        mcp: {
          remote: {
            id: "remote",
            name: "Remote MCP",
            enabled: false,
            transport: "http",
            url: "https://example.com/mcp",
            oauth: {
              clientId: "client",
              clientSecretEnv: "REMOTE_MCP_CLIENT_SECRET",
              redirectUri: "http://127.0.0.1:17777/callback",
              callbackPort: 17777,
            },
          },
        },
      }),
  })

  expect(loaded.config.mcp.remote?.name).toBe("Remote MCP")
  expect(loaded.config.mcp.remote?.oauth?.clientSecretEnv).toBe("REMOTE_MCP_CLIENT_SECRET")
  expect(loaded.diagnostics.some((diagnostic) => diagnostic.code === "config.unknown_key")).toBe(false)
})

test("accepts canonical SPEC agent profile fields", async () => {
  const loaded = await loadConfig({
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async (path) => path === "/repo/oc2.jsonc",
    readFile: async () =>
      JSON.stringify({
        agents: {
          reviewer: {
            id: "reviewer",
            name: "Reviewer",
            description: "Reviews changes",
            mode: "subagent",
            systemPrompt: "Review carefully",
            defaultModel: "fake/test",
            allowedTools: [{ decision: "allow", match: "read" }],
            maxIterations: 3,
            timeoutMs: 1000,
          },
        },
      }),
  })

  expect(loaded.config.agents.reviewer?.mode).toBe("subagent")
  expect(loaded.config.agents.reviewer?.allowedTools).toEqual([{ decision: "allow", match: "read" }])
  expect(loaded.diagnostics.some((diagnostic) => diagnostic.code === "config.unknown_key")).toBe(false)
})

test("normalizes MCP cwd paths relative to the source config", async () => {
  const loaded = await loadConfig({
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async (path) => path === "/repo/.oc2/config.jsonc",
    readFile: async () =>
      JSON.stringify({
        mcp: {
          local: {
            transport: "stdio",
            command: "server",
            cwd: "../tools",
          },
          home: {
            transport: "stdio",
            command: "server",
            cwd: "~/tools",
          },
        },
      }),
  })

  expect(loaded.config.mcp.local?.cwd).toBe("/repo/tools")
  expect(loaded.config.mcp.home?.cwd).toBe("/home/test/tools")
})

test("uses OC2_CONFIG as an explicit config file layer", async () => {
  const files = new Map([
    ["/repo/oc2.jsonc", JSON.stringify({ model: { provider: "project", model: "base" } })],
    ["/tmp/explicit.jsonc", JSON.stringify({ model: { provider: "explicit" } })],
  ])

  const loaded = await loadConfig({
    cwd: "/repo",
    homeDir: "/home/test",
    env: { OC2_CONFIG: "/tmp/explicit.jsonc" },
    fileExists: async (path) => files.has(path),
    readFile: async (path) => files.get(path) ?? "",
  })

  expect(loaded.config.model).toEqual({ provider: "explicit", model: "base" })
})
