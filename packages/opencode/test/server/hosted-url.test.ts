import { describe, expect, test } from "bun:test"

import { resolveNetworkOptionsNoConfig } from "../../src/cli/network"
import { isAllowedCorsOrigin } from "../../src/server/cors"
import { upstreamURL } from "../../src/server/shared/ui"

describe("hosted URL compatibility", () => {
  test("allows oc2 and legacy opencode hosted CORS origins", () => {
    expect(isAllowedCorsOrigin("https://oc2.ai")).toBe(true)
    expect(isAllowedCorsOrigin("https://app.oc2.ai")).toBe(true)
    expect(isAllowedCorsOrigin("https://app.opencode.ai")).toBe(true)
    expect(isAllowedCorsOrigin("https://example.com")).toBe(false)
  })

  test("uses app.oc2.ai as the upstream UI", () => {
    expect(upstreamURL("/assets/app.js")).toBe("https://app.oc2.ai/assets/app.js")
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
