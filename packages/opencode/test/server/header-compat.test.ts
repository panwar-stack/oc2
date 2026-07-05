import { describe, expect, test } from "bun:test"
import * as Fence from "@/server/shared/fence"
import { hasPtyConnectToken, PTY_CONNECT_TOKEN_HEADER_VALUE } from "@/server/shared/pty-ticket"

describe("HTTP header compatibility", () => {
  test("prefers x-oc2-sync and falls back to x-opencode-sync", () => {
    expect(Fence.parse(new Headers({ "x-opencode-sync": JSON.stringify({ legacy: 1 }) }))).toEqual({ legacy: 1 })
    expect(
      Fence.parse(
        new Headers({
          "x-oc2-sync": JSON.stringify({ canonical: 2 }),
          "x-opencode-sync": JSON.stringify({ legacy: 1 }),
        }),
      ),
    ).toEqual({ canonical: 2 })
  })

  test("accepts x-oc2-ticket and x-opencode-ticket", () => {
    expect(hasPtyConnectToken({ "x-oc2-ticket": PTY_CONNECT_TOKEN_HEADER_VALUE })).toBe(true)
    expect(hasPtyConnectToken({ "x-opencode-ticket": PTY_CONNECT_TOKEN_HEADER_VALUE })).toBe(true)
    expect(
      hasPtyConnectToken({
        "x-oc2-ticket": PTY_CONNECT_TOKEN_HEADER_VALUE,
        "x-opencode-ticket": "wrong",
      }),
    ).toBe(true)
  })
})
