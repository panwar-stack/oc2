import { describe, expect, test } from "bun:test"
import { isMemberWorking, statusLabel } from "../../src/feature-plugins/sidebar/team"

describe("sidebar team status", () => {
  test("live busy overrides a durable completed status after reactivation", () => {
    const live = { type: "busy" }
    const durable = { status: "completed" }

    expect(isMemberWorking(live, durable)).toBe(true)
    expect(statusLabel(live, durable)).toBe("working")
  })
})
