import { describe, expect, test } from "bun:test"
import { isMemberWorking, statusLabel } from "../../src/feature-plugins/sidebar/team"

describe("sidebar team status", () => {
  test("live busy overrides a durable completed status after reactivation", () => {
    const live = { type: "busy" }
    const durable = { status: "completed" }

    expect(isMemberWorking(live, durable)).toBe(true)
    expect(statusLabel(live, durable)).toBe("working")
  })

  test("uses durable active and starting states only without a live status", () => {
    for (const status of ["active", "starting"]) {
      const durable = { status }

      expect(isMemberWorking(undefined, durable)).toBe(true)
      expect(statusLabel(undefined, durable)).toBe("working")
      expect(isMemberWorking({ type: "idle" }, durable)).toBe(true)
      expect(statusLabel({ type: "idle" }, durable)).toBe("working")
    }
  })

  test("keeps daemon lifecycle labels when no live status exists", () => {
    const durable = { status: "active", lifecycle: "daemon", daemonState: "running" }

    expect(isMemberWorking(undefined, durable)).toBe(true)
    expect(statusLabel(undefined, durable)).toBe("daemon:running")
    expect(statusLabel({ type: "idle" }, durable)).toBe("daemon:running")
  })

  test("keeps terminal labels when the live session is idle", () => {
    for (const status of ["completed", "cancelled", "failed", "blocked"]) {
      expect(statusLabel({ type: "idle" }, { status })).toBe(status)
    }
  })
})
