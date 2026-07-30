import type {
  TuiStartupProfile,
  TuiStartupRequestName,
  TuiStartupTraceInput,
} from "@oc2-ai/core/util/tui-startup-profile"
import type { RpcTrace } from "@/util/rpc"

const fetchRequests = new Map<string, TuiStartupRequestName>([
  ["GET /config/providers", "config.providers"],
  ["GET /provider", "provider.list"],
  ["GET /agent", "app.agents"],
  ["GET /config", "config.get"],
  ["GET /path", "project.path"],
  ["GET /project/current", "project.current"],
  ["GET /session", "session.list"],
])

export function startupRequestName(method: string, input: unknown): TuiStartupRequestName {
  if (method === "server") return "worker.server"
  if (method !== "fetch" || input === null || typeof input !== "object" || !("url" in input) || !("method" in input)) {
    return "other"
  }
  const url = Reflect.get(input, "url")
  const requestMethod = Reflect.get(input, "method")
  if (typeof url !== "string" || typeof requestMethod !== "string") return "other"
  try {
    return fetchRequests.get(`${requestMethod.toUpperCase()} ${new URL(url).pathname}`) ?? "other"
  } catch {
    return "other"
  }
}

function requestName(value: string): TuiStartupRequestName | undefined {
  switch (value) {
    case "config.providers":
    case "provider.list":
    case "app.agents":
    case "config.get":
    case "project.path":
    case "project.current":
    case "core.bootstrap":
    case "session.list":
    case "worker.server":
    case "other":
      return value
    default:
      return undefined
  }
}

export function createParentRpcTrace(profile: TuiStartupProfile): RpcTrace | undefined {
  if (!profile.enabled) return undefined
  return {
    requestName: startupRequestName,
    onRequest(input) {
      profile.emit({ event: "rpc.request", role: "main", ...input })
    },
    onResponse(input) {
      profile.emit({ event: "rpc.response", role: "main", ...input, removableDuplicateBytes: 0 })
    },
  }
}

export function createWorkerRpcTrace(send: (input: TuiStartupTraceInput) => void): RpcTrace {
  return {
    requestName: startupRequestName,
    onDispatch(input) {
      const request = requestName(input.request)
      if (!request) return
      send({ event: "rpc.dispatch", role: "worker", ...input, request })
    },
  }
}
