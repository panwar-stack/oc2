import { describe, expect, test } from "bun:test"
import { createTuiStartupProfile, type TuiStartupTraceSink } from "@oc2-ai/core/util/tui-startup-profile"

function harness(times: number[], options?: { failWrite?: boolean; failClose?: boolean; maxRecords?: number }) {
  const lines: string[] = []
  let clocks = 0
  let closes = 0
  const sink: TuiStartupTraceSink = {
    write(line) {
      if (options?.failWrite) throw new Error("broken pipe")
      lines.push(line)
    },
    close() {
      closes++
      if (options?.failClose) throw new Error("close failed")
    },
  }
  const profile = createTuiStartupProfile({
    enabled: "1",
    fd: "3",
    runID: "run_test-1",
    sink,
    inspectFD: () => true,
    maxRecords: options?.maxRecords,
    clock: () => {
      clocks++
      const value = times.shift()
      if (value === undefined) throw new Error("unexpected clock read")
      return value
    },
  })
  return {
    profile,
    lines,
    get clocks() {
      return clocks
    },
    get closes() {
      return closes
    },
  }
}

describe("tui startup profile", () => {
  test("stays inert for missing or invalid descriptors", () => {
    for (const fd of [undefined, "", " 3", "2", "3x", "-1", "2147483648"]) {
      let clocks = 0
      let writes = 0
      const profile = createTuiStartupProfile({
        enabled: "1",
        fd,
        runID: "run_test-1",
        clock: () => {
          clocks++
          return 0
        },
        sink: {
          write() {
            writes++
          },
          close() {
            writes++
          },
        },
        inspectFD: () => true,
      })

      expect(profile.enabled).toBe(false)
      expect(profile.emit({ event: "cli.entry", role: "main" })).toBe(false)
      profile.adopt().close()
      expect(clocks).toBe(0)
      expect(writes).toBe(0)
    }
  })

  test("requires the strict opt-in flag, a bounded run ID, and a pipe descriptor", () => {
    for (const options of [
      { enabled: undefined, fd: "3", runID: "run_test-1", inspectFD: () => true },
      { enabled: "true", fd: "3", runID: "run_test-1", inspectFD: () => true },
      { enabled: "1", fd: "3", runID: "contains spaces", inspectFD: () => true },
      { enabled: "1", fd: "3", runID: "x".repeat(129), inspectFD: () => true },
      { enabled: "1", fd: "3", runID: "run_test-1", inspectFD: () => false },
    ]) {
      let touched = 0
      const profile = createTuiStartupProfile({
        ...options,
        clock: () => {
          touched++
          return 0
        },
        sink: {
          write() {
            touched++
          },
          close() {
            touched++
          },
        },
      })

      expect(profile.enabled).toBe(false)
      expect(profile.emit({ event: "cli.entry", role: "main" })).toBe(false)
      expect(touched).toBe(0)
    }
  })

  test("preserves monotonic origin, sequence, and ordering across adoption", () => {
    const out = harness([100, 112, 130])

    expect(out.profile.emit({ event: "cli.entry", role: "main" })).toBe(true)
    const adopted = out.profile.adopt()
    expect(adopted).toBe(out.profile)
    expect(out.profile.adopted).toBe(true)
    expect(adopted.emit({ event: "cli.entry", role: "main" })).toBe(true)

    expect(out.lines).toEqual([
      '{"version":1,"runID":"run_test-1","sequence":0,"elapsedMs":12,"event":"cli.entry","role":"main"}\n',
      '{"version":1,"runID":"run_test-1","sequence":1,"elapsedMs":30,"event":"cli.entry","role":"main"}\n',
    ])
    expect(out.clocks).toBe(3)
  })

  test("rejects fields and values outside the closed privacy schema", () => {
    const out = harness([10, 20])

    expect(out.profile.emit({ event: "prompt.content", role: "main", prompt: "secret" })).toBe(false)
    expect(out.profile.emit({ event: "cli.entry", role: "main", path: "/private/work" })).toBe(false)
    expect(out.profile.emit({ event: "cli.entry", role: "worker" })).toBe(false)
    expect(out.profile.emit(null)).toBe(false)
    expect(out.lines).toEqual([])
    expect(out.clocks).toBe(1)

    expect(out.profile.emit({ event: "cli.entry", role: "main" })).toBe(true)
    expect(out.lines).toHaveLength(1)
  })

  test("rejects accessor-backed fields without reading or serializing them", () => {
    const out = harness([10])
    let reads = 0
    const input = {
      get event() {
        reads++
        return reads === 1 ? "cli.entry" : "secret"
      },
      role: "main",
    }

    expect(out.profile.emit(input)).toBe(false)
    expect(reads).toBe(0)
    expect(out.lines).toEqual([])
    expect(out.clocks).toBe(1)
    expect(out.profile.enabled).toBe(true)
  })

  test("fails closed when finite clock values produce an infinite elapsed delta", () => {
    const out = harness([-Number.MAX_VALUE, Number.MAX_VALUE])

    expect(out.profile.emit({ event: "cli.entry", role: "main" })).toBe(false)
    expect(out.profile.enabled).toBe(false)
    expect(out.lines).toEqual([])
    expect(out.clocks).toBe(2)
    expect(out.closes).toBe(1)
  })

  test("fails closed after a sink error and closes once", () => {
    const out = harness([1, 2, 3], { failWrite: true })

    expect(out.profile.emit({ event: "cli.entry", role: "main" })).toBe(false)
    expect(out.profile.enabled).toBe(false)
    expect(out.profile.emit({ event: "cli.entry", role: "main" })).toBe(false)
    out.profile.close()

    expect(out.clocks).toBe(2)
    expect(out.closes).toBe(1)
  })

  test("bounds records and releases the sink", () => {
    const out = harness([0, 1, 2], { maxRecords: 1 })

    expect(out.profile.emit({ event: "cli.entry", role: "main" })).toBe(true)
    expect(out.profile.emit({ event: "cli.entry", role: "main" })).toBe(false)
    expect(out.profile.enabled).toBe(false)
    expect(out.lines).toHaveLength(1)
    expect(out.clocks).toBe(2)
    expect(out.closes).toBe(1)
  })

  test("closes exactly once across adopted and fallback cleanup", () => {
    const out = harness([0])

    out.profile.adopt().close()
    out.profile.close()
    out.profile.adopt().close()

    expect(out.profile.enabled).toBe(false)
    expect(out.closes).toBe(1)
  })

  test("contains close failures without affecting callers", () => {
    const out = harness([0], { failClose: true })

    expect(() => out.profile.close()).not.toThrow()
    expect(() => out.profile.close()).not.toThrow()
    expect(out.profile.enabled).toBe(false)
    expect(out.closes).toBe(1)
  })
})
