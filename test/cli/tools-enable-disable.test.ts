import { expect, test } from "bun:test"

import { runCli } from "../../src/cli/index"

test("tools enable and disable update JSONC config", async () => {
  let file = "{}\n"
  const output: string[] = []

  const enabled = await runCli({
    argv: ["tools", "enable", "read"],
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

  expect(enabled.exitCode).toBe(0)
  expect(file).toContain('"read"')
  expect(file).toContain('"enabled": true')
  expect(output.join("")).toContain("Enabled tool read")

  const disabledJson: string[] = []
  const disabled = await runCli({
    argv: ["tools", "disable", "read", "--json"],
    cwd: "/repo",
    homeDir: "/home/test",
    env: {},
    fileExists: async () => true,
    readFile: async () => file,
    writeFile: async (_path, contents) => {
      file = contents
    },
    streams: {
      stdout: (text) => {
        disabledJson.push(text)
      },
    },
  })

  expect(disabled.exitCode).toBe(0)
  expect(file).toContain('"enabled": false')
  expect(JSON.parse(disabledJson.join(""))).toMatchObject({ toolName: "read", enabled: false })
})
