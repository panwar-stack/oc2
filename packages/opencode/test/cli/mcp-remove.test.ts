import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { cliIt } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"

describe("opencode mcp remove (non-interactive subprocess)", () => {
  cliIt.concurrent(
    "removes a remote server from the global config",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const addResult = yield* opencode.spawn([
          "mcp",
          "add",
          "github",
          "--url",
          "https://example.com/mcp",
        ])
        opencode.expectExit(addResult, 0)

        const removeResult = yield* opencode.spawn(["mcp", "remove", "github"])
        opencode.expectExit(removeResult, 0)

        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "oc2", "oc2.jsonc")).json(),
        )
        expect((config.mcp as Record<string, unknown> | undefined)?.github).toBeUndefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "removes only the named server, leaving others intact",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const addA = yield* opencode.spawn(["mcp", "add", "a", "--url", "https://example.com/mcp"])
        opencode.expectExit(addA, 0)

        const addB = yield* opencode.spawn(["mcp", "add", "b", "--url", "https://example.com/mcp"])
        opencode.expectExit(addB, 0)

        const removeResult = yield* opencode.spawn(["mcp", "remove", "a"])
        opencode.expectExit(removeResult, 0)

        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "oc2", "oc2.jsonc")).json(),
        )
        expect((config.mcp as Record<string, unknown> | undefined)?.a).toBeUndefined()
        expect(config.mcp.b).toEqual({
          type: "remote",
          url: "https://example.com/mcp",
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails with a non-zero exit when the server does not exist",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["mcp", "remove", "ghost"])
        opencode.expectExit(result, 1)
        expect((result.stderr + result.stdout).toLowerCase()).toContain("not found")
      }),
    60_000,
  )

  cliIt.concurrent(
    "removes a server via the rm alias",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const addResult = yield* opencode.spawn([
          "mcp",
          "add",
          "alias-srv",
          "--url",
          "https://example.com/mcp",
        ])
        opencode.expectExit(addResult, 0)

        const removeResult = yield* opencode.spawn(["mcp", "rm", "alias-srv"])
        opencode.expectExit(removeResult, 0)

        const config = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "oc2", "oc2.jsonc")).json(),
        )
        expect((config.mcp as Record<string, unknown> | undefined)?.["alias-srv"]).toBeUndefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "removes the server from every config file that defines it",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const serverEntry = {
          mcp: {
            shared: { type: "remote", url: "https://example.com/mcp" },
          },
        }
        yield* Effect.promise(() =>
          Bun.write(path.join(home, "oc2.jsonc"), JSON.stringify(serverEntry)),
        )
        yield* Effect.promise(() =>
          Bun.write(path.join(home, ".config", "oc2", "oc2.jsonc"), JSON.stringify(serverEntry)),
        )

        const removeResult = yield* opencode.spawn(["mcp", "remove", "shared"], {
          env: { OC2_DISABLE_PROJECT_CONFIG: "0" },
        })
        opencode.expectExit(removeResult, 0)

        const projectConfig = yield* Effect.promise(() =>
          Bun.file(path.join(home, "oc2.jsonc")).json(),
        )
        const globalConfig = yield* Effect.promise(() =>
          Bun.file(path.join(home, ".config", "oc2", "oc2.jsonc")).json(),
        )
        expect((projectConfig.mcp as Record<string, unknown> | undefined)?.shared).toBeUndefined()
        expect((globalConfig.mcp as Record<string, unknown> | undefined)?.shared).toBeUndefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "fails with a clear error when the server is injected via OC2_CONFIG_CONTENT",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const configContent = JSON.stringify({
          ...testProviderConfig(llm.url),
          mcp: {
            injected: { type: "remote", url: "https://example.com/mcp" },
          },
        })
        const result = yield* opencode.spawn(["mcp", "remove", "injected"], {
          env: { OC2_CONFIG_CONTENT: configContent },
        })
        opencode.expectExit(result, 1)
        expect((result.stderr + result.stdout).toLowerCase()).toContain("injected")
      }),
    60_000,
  )
})
