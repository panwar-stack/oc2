import { afterEach, describe, expect, test } from "bun:test"
import { ServerAddress } from "@/server/address"
import {
  DEFAULT_CONTROL_PLANE_HOST,
  DEFAULT_CONTROL_PLANE_PORT,
  isMultiprocessEnabled,
  resolveLeadControlPlaneURL,
} from "@/team/control-plane"

// The env var name is duplicated here (rather than imported from core) so this
// test stays a pure unit test over the module's own precedence rules.
const ENV_KEY = "OC2_TEAM_LEAD_URL"
const originalEnv = process.env[ENV_KEY]

afterEach(() => {
  if (originalEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = originalEnv
  ServerAddress.setServerURL(undefined)
})

describe("control-plane defaults", () => {
  test("exposes the loopback host and 4096 port defaults", () => {
    expect(DEFAULT_CONTROL_PLANE_HOST).toBe("127.0.0.1")
    expect(DEFAULT_CONTROL_PLANE_PORT).toBe(4096)
  })
})

describe("resolveLeadControlPlaneURL", () => {
  test("returns undefined when env is absent and ServerAddress is cleared", () => {
    delete process.env[ENV_KEY]
    ServerAddress.setServerURL(undefined)
    expect(resolveLeadControlPlaneURL()).toBeUndefined()
  })

  test("uses ServerAddress origin when env is absent", () => {
    delete process.env[ENV_KEY]
    ServerAddress.setServerURL(new URL("http://127.0.0.1:49152"))
    expect(resolveLeadControlPlaneURL()).toBe("http://127.0.0.1:49152")
  })

  test("explicit env wins and is trimmed", () => {
    process.env[ENV_KEY] = "  http://10.0.0.5:7777  "
    expect(resolveLeadControlPlaneURL()).toBe("http://10.0.0.5:7777")
  })

  test("blank or whitespace-only env is ignored", () => {
    ServerAddress.setServerURL(undefined)
    for (const blank of ["", "   ", "\t\n"]) {
      process.env[ENV_KEY] = blank
      expect(resolveLeadControlPlaneURL()).toBeUndefined()
    }
  })

  test("explicit env wins over a set ServerAddress URL", () => {
    ServerAddress.setServerURL(new URL("http://127.0.0.1:49152"))
    process.env[ENV_KEY] = "http://10.0.0.5:7777"
    expect(resolveLeadControlPlaneURL()).toBe("http://10.0.0.5:7777")
  })
})

describe("isMultiprocessEnabled", () => {
  test("is true by default and false only when the experimental flag is exactly false", () => {
    expect(isMultiprocessEnabled({ experimental: { team_multiprocess: true } })).toBe(true)
    expect(isMultiprocessEnabled(undefined)).toBe(true)
    expect(isMultiprocessEnabled({})).toBe(true)
    expect(isMultiprocessEnabled({ experimental: {} })).toBe(true)
    expect(isMultiprocessEnabled({ experimental: { team_multiprocess: false } })).toBe(false)
  })
})
