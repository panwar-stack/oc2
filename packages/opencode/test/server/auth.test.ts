import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { Flag } from "@oc2-ai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  OC2_SERVER_PASSWORD: Flag.OC2_SERVER_PASSWORD,
  OC2_SERVER_USERNAME: Flag.OC2_SERVER_USERNAME,
}

afterEach(() => {
  Flag.OC2_SERVER_PASSWORD = original.OC2_SERVER_PASSWORD
  Flag.OC2_SERVER_USERNAME = original.OC2_SERVER_USERNAME
})

const fromConfig = (input: Record<string, unknown>) =>
  ServerAuth.Config.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))))

const readConfig = ServerAuth.Config.useSync((config) => config)

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.OC2_SERVER_PASSWORD = undefined
    Flag.OC2_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("defaults emitted auth headers to the oc2 username", () => {
    Flag.OC2_SERVER_PASSWORD = "secret"
    Flag.OC2_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("oc2:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.OC2_SERVER_PASSWORD = "secret"
    Flag.OC2_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.OC2_SERVER_PASSWORD = "secret"
    Flag.OC2_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice", usernameConfigured: true }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })

  test("requires the OC2 default username exactly", () => {
    const config = { password: Option.some("secret"), username: "oc2", usernameConfigured: false }

    expect(ServerAuth.authorized({ username: "oc2", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })

  test("keeps explicitly configured default username exact", () => {
    const config = { password: Option.some("secret"), username: "oc2", usernameConfigured: true }

    expect(ServerAuth.authorized({ username: "oc2", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })

  test("reads OC2_SERVER config", async () => {
    const config = await Effect.runPromise(
      readConfig.pipe(
        Effect.provide(
          fromConfig({
            OC2_SERVER_PASSWORD: "new-secret",
            OC2_SERVER_USERNAME: "new-user",
          }),
        ),
      ),
    )

    expect(config).toEqual({
      password: Option.some("new-secret"),
      username: "new-user",
      usernameConfigured: true,
    })
  })
})
