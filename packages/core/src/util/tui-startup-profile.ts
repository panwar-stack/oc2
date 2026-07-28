import { closeSync, fstatSync, writeSync } from "node:fs"

export const OC2_TUI_STARTUP_PROFILE = "OC2_TUI_STARTUP_PROFILE"
export const OC2_TUI_STARTUP_PROFILE_FD = "OC2_TUI_STARTUP_PROFILE_FD"
export const TUI_STARTUP_TRACE_VERSION = 1 as const

const MAX_RECORDS = 512
const MAX_LINE_BYTES = 512
const MAX_RUN_ID_BYTES = 128
const MIN_TRACE_FD = 3
const MAX_TRACE_FD = 0x7fffffff

export type TuiStartupTraceInput = {
  readonly event: "cli.entry"
  readonly role: "main"
}

export type TuiStartupTraceRecord = TuiStartupTraceInput & {
  readonly version: typeof TUI_STARTUP_TRACE_VERSION
  readonly runID: string
  readonly sequence: number
  readonly elapsedMs: number
}

export type TuiStartupTraceSink = {
  write(line: string): void
  close(): void
}

export type TuiStartupProfile = {
  readonly enabled: boolean
  readonly adopted: boolean
  emit(input: unknown): boolean
  adopt(): TuiStartupProfile
  close(): void
  [Symbol.dispose](): void
}

export type TuiStartupProfileOptions = {
  readonly enabled?: string
  readonly fd?: string
  readonly runID?: string
  readonly clock?: () => number
  readonly sink?: TuiStartupTraceSink
  readonly maxRecords?: number
  readonly inspectFD?: (fd: number) => boolean
}

const disabled: TuiStartupProfile = {
  enabled: false,
  adopted: false,
  emit() {
    return false
  },
  adopt() {
    return this
  },
  close() {},
  [Symbol.dispose]() {},
}

function parseFD(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) return undefined
  const fd = Number(value)
  if (!Number.isSafeInteger(fd) || fd < MIN_TRACE_FD || fd > MAX_TRACE_FD) return undefined
  return fd
}

function fileDescriptorSink(fd: number): TuiStartupTraceSink {
  return {
    write(line) {
      const data = Buffer.from(line)
      let offset = 0
      while (offset < data.byteLength) {
        const written = writeSync(fd, data, offset, data.byteLength - offset)
        if (!Number.isSafeInteger(written) || written <= 0) throw new Error("startup trace write failed")
        offset += written
      }
    },
    close() {
      closeSync(fd)
    },
  }
}

function validRunID(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_RUN_ID_BYTES &&
    /^[0-9A-Za-z_-]+$/.test(value)
  )
}

function traceDescriptor(fd: number) {
  const stat = fstatSync(fd)
  return stat.isFIFO() || stat.isSocket()
}

function validInput(input: unknown): input is TuiStartupTraceInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const keys = Object.keys(input)
  return (
    keys.length === 2 &&
    keys.includes("event") &&
    keys.includes("role") &&
    Reflect.get(input, "event") === "cli.entry" &&
    Reflect.get(input, "role") === "main"
  )
}

export function createTuiStartupProfile(options: TuiStartupProfileOptions = {}): TuiStartupProfile {
  if (options.enabled !== "1") return disabled
  const fd = parseFD(options.fd)
  if (fd === undefined) return disabled
  if (!validRunID(options.runID)) return disabled
  const runID = options.runID
  const maxRecords = options.maxRecords ?? MAX_RECORDS
  if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0 || maxRecords > MAX_RECORDS) return disabled
  try {
    if (!(options.inspectFD ?? traceDescriptor)(fd)) return disabled
  } catch {
    return disabled
  }

  const clock = options.clock ?? performance.now.bind(performance)
  const sink = options.sink ?? fileDescriptorSink(fd)

  let origin: number
  try {
    origin = clock()
  } catch {
    try {
      sink.close()
    } catch {}
    return disabled
  }
  if (!Number.isFinite(origin)) {
    try {
      sink.close()
    } catch {}
    return disabled
  }

  let state: "active" | "disabled" | "closed" = "active"
  let sequence = 0
  let adopted = false

  const close = () => {
    if (state !== "active") return
    state = "closed"
    try {
      sink.close()
    } catch {
      state = "disabled"
    }
  }

  const fail = () => {
    if (state !== "active") return
    state = "disabled"
    try {
      sink.close()
    } catch {}
  }

  const profile: TuiStartupProfile = {
    get enabled() {
      return state === "active"
    },
    get adopted() {
      return adopted
    },
    emit(input) {
      if (state !== "active") return false
      try {
        if (!validInput(input)) return false
      } catch {
        return false
      }
      if (sequence >= maxRecords) {
        fail()
        return false
      }

      try {
        const now = clock()
        if (!Number.isFinite(now)) {
          fail()
          return false
        }
        const record: TuiStartupTraceRecord = {
          version: TUI_STARTUP_TRACE_VERSION,
          runID,
          sequence,
          elapsedMs: Math.max(0, now - origin),
          event: input.event,
          role: input.role,
        }
        const line = JSON.stringify(record) + "\n"
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
          fail()
          return false
        }
        sink.write(line)
        sequence++
        return true
      } catch {
        fail()
        return false
      }
    },
    adopt() {
      if (state === "active") adopted = true
      return profile
    },
    close,
    [Symbol.dispose]: close,
  }
  return profile
}

let current: TuiStartupProfile = disabled
let initialized = false

export function initializeTuiStartupProfile(
  options: TuiStartupProfileOptions = {
    enabled: process.env[OC2_TUI_STARTUP_PROFILE],
    fd: process.env[OC2_TUI_STARTUP_PROFILE_FD],
    runID: process.env.OC2_RUN_ID,
  },
) {
  if (initialized) return current
  initialized = true
  current = createTuiStartupProfile(options)
  return current
}

export function getTuiStartupProfile() {
  return current
}
