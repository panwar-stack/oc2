import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { cliIt } from "../lib/cli-process"
import { mcpMutationInput } from "../../src/cli/cmd/mcp"

describe("opencode mcp add (non-interactive subprocess)", () => {
  test("keeps an explicitly selected nested project path in project scope", () => {
    const nested = path.join("/global/config", "nested-project", "oc2.json")
    expect(
      mcpMutationInput("server", { type: "remote", url: "https://example.com/mcp" }, nested, "/project", "project"),
    ).toMatchObject({ scope: "project", path: nested })
  })
  cliIt.concurrent(
    "adds a remote server with HTTP headers",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
          "--header",
          "Authorization=Bearer {env:GITHUB_TOKEN}",
          "--header",
          "X-Option=one=two",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() => Bun.file(path.join(home, ".config", "oc2", "oc2.jsonc")).json())
        expect(config.mcp.github).toEqual({
          type: "remote",
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Bearer {env:GITHUB_TOKEN}",
            "X-Option": "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "adds a local server while preserving argv and environment values",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn([
          "mcp",
          "add",
          "local",
          "--env",
          "API_KEY=secret",
          "--env",
          "VALUE=one=two",
          "--",
          "npx",
          "-y",
          "@example/server",
          "--label",
          "two words",
        ])
        opencode.expectExit(result, 0)

        const config = yield* Effect.promise(() => Bun.file(path.join(home, ".config", "oc2", "oc2.jsonc")).json())
        expect(config.mcp.local).toEqual({
          type: "local",
          command: ["npx", "-y", "@example/server", "--label", "two words"],
          environment: {
            API_KEY: "secret",
            VALUE: "one=two",
          },
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "exits nonzero when the resulting global configuration is rejected",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const configPath = path.join(home, ".config", "oc2", "oc2.jsonc")
        yield* Effect.promise(() =>
          fs.mkdir(path.dirname(configPath), { recursive: true }).then(() =>
            Bun.write(configPath, JSON.stringify({ sandbox: { enabled: true } })),
          ),
        )

        const result = yield* opencode.spawn(["mcp", "add", "github", "--url", "https://example.com/mcp"])

        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).not.toContain('MCP server "github" added')
      }),
    60_000,
  )
})
