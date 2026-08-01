import { describe, expect, test } from "bun:test"
import { previewStatusLabel } from "../../src/feature-plugins/session/preview-pane"

describe("session preview status label", () => {
  test("paused wins over a live busy status", () => {
    expect(previewStatusLabel("busy", true)).toBe("paused")
    expect(previewStatusLabel("idle", true)).toBe("paused")
  })

  test("maps live session status when not paused", () => {
    expect(previewStatusLabel("busy", false)).toBe("working")
    expect(previewStatusLabel("retry", false)).toBe("retrying")
    expect(previewStatusLabel("idle", false)).toBe("idle")
    expect(previewStatusLabel(undefined, false)).toBe("idle")
  })
})
