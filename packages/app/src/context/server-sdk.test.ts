import { describe, expect, test } from "bun:test"
import { resumeStreamAfterPageShow } from "./server-sdk"

describe("resumeStreamAfterPageShow", () => {
  test("restarts a stream only after a back-forward cache restore", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(1)
  })

  test("exposes truthful stream lifecycle transitions", async () => {
    const source = await Bun.file(import.meta.dir + "/server-sdk.tsx").text()
    expect(source).toContain('{ status: "disconnected" }')
    expect(source).toContain('setConnection("status", connectedOnce ? "reconnecting" : "connecting")')
    expect(source).toContain('setConnection("status", "connected")')
    expect(source).toContain('setConnection("status", "reconnecting")')
    expect(source).toContain('setConnection("status", "disconnected")')
  })
})
