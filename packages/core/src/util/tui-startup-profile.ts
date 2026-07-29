import { closeSync, fstatSync, writeSync } from "node:fs"

export const OC2_TUI_STARTUP_PROFILE = "OC2_TUI_STARTUP_PROFILE"
export const OC2_TUI_STARTUP_PROFILE_FD = "OC2_TUI_STARTUP_PROFILE_FD"
export const OC2_TUI_STARTUP_PROFILE_WORKER = "OC2_TUI_STARTUP_PROFILE_WORKER"
export const TUI_STARTUP_TRACE_VERSION = 1 as const

const MAX_RECORDS = 512
const MAX_LINE_BYTES = 512
const MAX_RUN_ID_BYTES = 128
const MIN_TRACE_FD = 3
const MAX_TRACE_FD = 0x7fffffff

export type TuiStartupPhase =
  | "cli.command.load"
  | "worker.spawn"
  | "tui.config"
  | "transport.ready"
  | "session.validate"
  | "tui.import"
  | "renderer.create"
  | "theme.wait"
  | "renderer.render"
  | "plugin.load"
  | "bootstrap.critical"
  | "bootstrap.optional"

export type TuiStartupRequestName =
  | "config.providers"
  | "provider.list"
  | "app.agents"
  | "config.get"
  | "project.path"
  | "project.current"
  | "session.list"
  | "worker.server"
  | "other"

type GenerationZero = {
  readonly workspaceGeneration: 0
  readonly attemptGeneration: 0
}

export type TuiStartupTraceInput =
  | {
      readonly event: "cli.entry"
      readonly role: "main"
    }
  | {
      readonly event: "phase"
      readonly role: "main" | "worker"
      readonly phase: TuiStartupPhase
      readonly outcome: "ok" | "error"
      readonly durationMs: number
    }
  | {
      readonly event: "rpc.request"
      readonly role: "main"
      readonly requestID: number
      readonly request: TuiStartupRequestName
      readonly encodedBytes: number
    }
  | {
      readonly event: "rpc.response"
      readonly role: "main"
      readonly requestID: number
      readonly request: TuiStartupRequestName
      readonly encodedBytes: number
      readonly removableDuplicateBytes: 0
    }
  | {
      readonly event: "rpc.dispatch"
      readonly role: "worker"
      readonly requestID: number
      readonly request: TuiStartupRequestName
      readonly durationMs: number
    }
  | ({ readonly event: "prompt.mounted" | "bootstrap.critical.ready" | "input.accepted"; readonly role: "main" } &
      GenerationZero)
  | ({
      readonly event: "theme.settled"
      readonly role: "main"
      readonly outcome: "locked" | "resolved" | "fallback-final"
    } & GenerationZero)
  | ({ readonly event: "theme.reconciled"; readonly role: "main" } & GenerationZero)

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

function isPhase(value: unknown): value is TuiStartupPhase {
  if (typeof value !== "string") return false
  switch (value) {
    case "cli.command.load":
    case "worker.spawn":
    case "tui.config":
    case "transport.ready":
    case "session.validate":
    case "tui.import":
    case "renderer.create":
    case "theme.wait":
    case "renderer.render":
    case "plugin.load":
    case "bootstrap.critical":
    case "bootstrap.optional":
      return true
    default:
      return false
  }
}

function isRequest(value: unknown): value is TuiStartupRequestName {
  if (typeof value !== "string") return false
  switch (value) {
    case "config.providers":
    case "provider.list":
    case "app.agents":
    case "config.get":
    case "project.path":
    case "project.current":
    case "session.list":
    case "worker.server":
    case "other":
      return true
    default:
      return false
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function snapshotInput(input: unknown): TuiStartupTraceInput | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== "string")) return undefined
  const value = (key: string) => {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    return descriptor.value as unknown
  }
  const exact = (...expected: string[]) => keys.length === expected.length && expected.every((key) => keys.includes(key))
  const event = value("event")
  const role = value("role")

  if (event === "cli.entry" && role === "main" && exact("event", "role")) return { event, role }

  if (event === "phase" && (role === "main" || role === "worker") && exact("event", "role", "phase", "outcome", "durationMs")) {
    const phase = value("phase")
    const outcome = value("outcome")
    const durationMs = value("durationMs")
    if (!isPhase(phase)) return undefined
    if (outcome !== "ok" && outcome !== "error") return undefined
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined
    return { event, role, phase, outcome, durationMs }
  }

  if (
    event === "rpc.request" &&
    role === "main" &&
    exact("event", "role", "requestID", "request", "encodedBytes")
  ) {
    const requestID = value("requestID")
    const request = value("request")
    const encodedBytes = value("encodedBytes")
    if (!isNonNegativeSafeInteger(requestID)) return undefined
    if (!isRequest(request)) return undefined
    if (!isNonNegativeSafeInteger(encodedBytes)) return undefined
    return {
      event,
      role,
      requestID,
      request,
      encodedBytes,
    }
  }

  if (
    event === "rpc.response" &&
    role === "main" &&
    exact("event", "role", "requestID", "request", "encodedBytes", "removableDuplicateBytes")
  ) {
    const requestID = value("requestID")
    const request = value("request")
    const encodedBytes = value("encodedBytes")
    if (!isNonNegativeSafeInteger(requestID)) return undefined
    if (!isRequest(request)) return undefined
    if (!isNonNegativeSafeInteger(encodedBytes)) return undefined
    if (value("removableDuplicateBytes") !== 0) return undefined
    return {
      event,
      role,
      requestID,
      request,
      encodedBytes,
      removableDuplicateBytes: 0,
    }
  }

  if (
    event === "rpc.dispatch" &&
    role === "worker" &&
    exact("event", "role", "requestID", "request", "durationMs")
  ) {
    const requestID = value("requestID")
    const request = value("request")
    const durationMs = value("durationMs")
    if (!isNonNegativeSafeInteger(requestID)) return undefined
    if (!isRequest(request)) return undefined
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return undefined
    return {
      event,
      role,
      requestID,
      request,
      durationMs,
    }
  }

  const generationZero = () => value("workspaceGeneration") === 0 && value("attemptGeneration") === 0
  if (
    (event === "prompt.mounted" || event === "bootstrap.critical.ready" || event === "input.accepted") &&
    role === "main" &&
    exact("event", "role", "workspaceGeneration", "attemptGeneration") &&
    generationZero()
  ) {
    return { event, role, workspaceGeneration: 0, attemptGeneration: 0 }
  }
  if (
    event === "theme.settled" &&
    role === "main" &&
    exact("event", "role", "workspaceGeneration", "attemptGeneration", "outcome") &&
    generationZero()
  ) {
    const outcome = value("outcome")
    if (outcome !== "locked" && outcome !== "resolved" && outcome !== "fallback-final") return undefined
    return { event, role, workspaceGeneration: 0, attemptGeneration: 0, outcome }
  }
  if (
    event === "theme.reconciled" &&
    role === "main" &&
    exact("event", "role", "workspaceGeneration", "attemptGeneration") &&
    generationZero()
  ) {
    return { event, role, workspaceGeneration: 0, attemptGeneration: 0 }
  }
  return undefined
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
      let snapshot: TuiStartupTraceInput | undefined
      try {
        snapshot = snapshotInput(input)
      } catch {
        return false
      }
      if (!snapshot) return false
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
        const elapsedMs = Math.max(0, now - origin)
        if (!Number.isFinite(elapsedMs)) {
          fail()
          return false
        }
        const record: TuiStartupTraceRecord = {
          version: TUI_STARTUP_TRACE_VERSION,
          runID,
          sequence,
          elapsedMs,
          ...snapshot,
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
