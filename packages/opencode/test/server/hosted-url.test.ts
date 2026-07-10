import { describe, expect, test } from "bun:test"

import { resolveNetworkOptionsNoConfig } from "../../src/cli/network"
import { isAllowedCorsOrigin, isAllowedRequestOrigin } from "../../src/server/cors"

describe("hosted URL compatibility", () => {
  test("requires explicit configuration for hosted CORS origins", () => {
    expect(isAllowedCorsOrigin("https://oc2.ai")).toBe(false)
    expect(isAllowedCorsOrigin("https://app.oc2.ai")).toBe(false)
    expect(isAllowedCorsOrigin("https://app.opencode.ai")).toBe(false)
    expect(isAllowedCorsOrigin("https://app.oc2.ai", { cors: ["https://app.oc2.ai"] })).toBe(true)
    expect(isAllowedCorsOrigin(undefined)).toBe(true)
    expect(isAllowedCorsOrigin("http://127.0.0.1:3000")).toBe(true)
    expect(isAllowedCorsOrigin("http://localhost:3000")).toBe(true)
    expect(isAllowedRequestOrigin("https://dev.example:4096", "dev.example:4096")).toBe(true)
    expect(isAllowedCorsOrigin("https://example.com")).toBe(false)
  })

  test("defaults mDNS to oc2.local", () => {
    expect(
      resolveNetworkOptionsNoConfig({
        port: 0,
        hostname: "127.0.0.1",
        mdns: false,
        "mdns-domain": "oc2.local",
        cors: [],
      }).mdnsDomain,
    ).toBe("oc2.local")
  })
})
