import { describe, expect, test } from "bun:test"
import * as Fence from "@/server/shared/fence"
import { hasPtyConnectToken, PTY_CONNECT_TOKEN_HEADER_VALUE } from "@/server/shared/pty-ticket"

describe("HTTP headers", () => {
  test("parses x-oc2-sync", () => {
    expect(Fence.parse(new Headers({ "x-oc2-sync": JSON.stringify({ synced: 1 }) }))).toEqual({ synced: 1 })
  })

  test("accepts x-oc2-ticket", () => {
    expect(hasPtyConnectToken({ "x-oc2-ticket": PTY_CONNECT_TOKEN_HEADER_VALUE })).toBe(true)
    expect(hasPtyConnectToken({ "x-oc2-ticket": "wrong" })).toBe(false)
  })
})
