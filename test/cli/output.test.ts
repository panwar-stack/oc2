import { expect, test } from "bun:test"

import { runCli } from "../../src/cli/index"
import { formatMcpListText, formatMcpStatusText } from "../../src/cli/output"

test("prints version JSON shape", async () => {
  const output: string[] = []
  const result = await runCli({
    argv: ["version", "--json"],
    streams: {
      stdout: (text) => {
        output.push(text)
      },
    },
  })

  expect(result.exitCode).toBe(0)
  expect(JSON.parse(output.join(""))).toEqual({ name: "oc2", version: "0.0.0" })
})

test("prints diagnostics JSON shape", async () => {
  const output: string[] = []
  const result = await runCli({
    argv: ["diagnostics", "--json"],
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async () => false,
    streams: {
      stdout: (text) => {
        output.push(text)
      },
    },
  })

  const parsed = JSON.parse(output.join(""))
  expect(result.exitCode).toBe(0)
  expect(typeof parsed.generatedAt).toBe("string")
  expect(parsed.environment.cwd).toBe("/repo")
  expect(parsed.diagnostics).toEqual([])
})

test("prints config paths and config values", async () => {
  const pathOutput: string[] = []
  await runCli({
    argv: ["config", "path"],
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    streams: {
      stdout: (text) => {
        pathOutput.push(text)
      },
    },
  })
  expect(pathOutput.join("")).toContain("user: /home/test/.config/oc2/config.jsonc")

  const getOutput: string[] = []
  const result = await runCli({
    argv: ["config", "get", "model.provider"],
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async () => false,
    streams: {
      stdout: (text) => {
        getOutput.push(text)
      },
    },
  })
  expect(result.exitCode).toBe(0)
  expect(getOutput.join("")).toBe("fake\n")
})

test("prints valid JSON for missing config values", async () => {
  const output: string[] = []
  const result = await runCli({
    argv: ["config", "get", "missing.key", "--json"],
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async () => false,
    streams: {
      stdout: (text) => {
        output.push(text)
      },
    },
  })

  expect(result.exitCode).toBe(1)
  expect(JSON.parse(output.join(""))).toBeNull()
})

test("updates project config through config set", async () => {
  let file = "{}\n"
  const output: string[] = []
  const result = await runCli({
    argv: ["config", "set", "runtime.logLevel", "debug"],
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async (path) => path === "/repo/oc2.jsonc",
    readFile: async () => file,
    writeFile: async (_path, contents) => {
      file = contents
    },
    streams: {
      stdout: (text) => {
        output.push(text)
      },
    },
  })

  expect(result.exitCode).toBe(0)
  expect(file).toContain('"logLevel": "debug"')
  expect(output.join("")).toContain("Updated runtime.logLevel")
})

test("lists config-backed tools", async () => {
  const output: string[] = []
  await runCli({
    argv: ["tools", "list"],
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async (path) => path === "/repo/oc2.jsonc",
    readFile: async () => JSON.stringify({ tools: { read: { enabled: true }, bash: { enabled: false } } }),
    streams: {
      stdout: (text) => {
        output.push(text)
      },
    },
  })

  expect(output.join("")).toBe("bash\tdisabled\nread\tenabled\n")
})

test("lists slash commands in text and JSON modes", async () => {
  const textOutput: string[] = []
  const textResult = await runCli({
    argv: ["commands"],
    streams: {
      stdout: (text) => {
        textOutput.push(text)
      },
    },
  })
  expect(textResult.exitCode).toBe(0)
  expect(textOutput.join("")).toContain("/review\tbuiltin subtask")

  const jsonOutput: string[] = []
  const jsonResult = await runCli({
    argv: ["commands", "--json"],
    streams: {
      stdout: (text) => {
        jsonOutput.push(text)
      },
    },
  })
  expect(jsonResult.exitCode).toBe(0)
  expect(JSON.parse(jsonOutput.join("")).commands).toContainEqual(
    expect.objectContaining({ name: "review", source: "builtin", subtask: true }),
  )
})

test("formats MCP auth state, auth URL, and counts", () => {
  const status = {
    serverId: "remote",
    status: "auth_required" as const,
    authState: "callback_pending" as const,
    toolCount: 2,
    tools: ["mcp_remote_search", "mcp_remote_fetch"],
    resourceCount: 3,
    promptCount: 4,
    authUrl: "http://127.0.0.1:7331/callback",
  }

  expect(formatMcpStatusText(status)).toBe(
    "remote\tauth_required/callback_pending\t2 tools\t3 resources\t4 prompts\tauth: http://127.0.0.1:7331/callback\n",
  )
  expect(formatMcpListText([status])).toContain("auth_required/callback_pending")
})
