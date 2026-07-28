type Definition = {
  [method: string]: (input: any) => any
}

const MAX_TRACE_PENDING = 128

type TraceRequest = Readonly<{
  requestID: number
  request: string
  encodedBytes: number
}>

type TraceResponse = TraceRequest

type TraceDispatch = Readonly<{
  requestID: number
  request: string
  durationMs: number
}>

export type RpcTrace = Readonly<{
  requestName(method: string, input: unknown): string | undefined
  onRequest?(input: TraceRequest): void
  onResponse?(input: TraceResponse): void
  onDispatch?(input: TraceDispatch): void
  clock?: () => number
}>

function observe(fn: (() => void) | undefined) {
  try {
    fn?.()
  } catch {}
}

function traceName(trace: RpcTrace | undefined, method: string, input: unknown) {
  try {
    return trace?.requestName(method, input)
  } catch {
    return undefined
  }
}

function encodedBytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

export function listen(rpc: Definition, trace?: RpcTrace) {
  onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.request") {
      const request = traceName(trace, parsed.method, parsed.input)
      const clock = trace ? (trace.clock ?? performance.now.bind(performance)) : undefined
      let start: number | undefined
      try {
        if (request !== undefined) start = clock!()
      } catch {}
      const result = await rpc[parsed.method](parsed.input)
      if (request !== undefined && start !== undefined) {
        try {
          const durationMs = Math.max(0, clock!() - start)
          if (Number.isFinite(durationMs)) {
            observe(() => trace?.onDispatch?.({ requestID: parsed.id, request, durationMs }))
          }
        } catch {}
      }
      const encoded = JSON.stringify({ type: "rpc.result", result, id: parsed.id })
      postMessage(encoded)
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}, trace?: RpcTrace) {
  const pending = new Map<number, (result: any) => void>()
  const tracePending = trace ? new Map<number, string>() : undefined
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.result") {
      const resolve = pending.get(parsed.id)
      if (resolve) {
        const request = tracePending?.get(parsed.id)
        tracePending?.delete(parsed.id)
        if (request !== undefined) {
          observe(() =>
            trace?.onResponse?.({
              requestID: parsed.id,
              request,
              encodedBytes: encodedBytes(evt.data),
            }),
          )
        }
        resolve(parsed.result)
        pending.delete(parsed.id)
      }
    }
    if (parsed.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve) => {
        const request = traceName(trace, String(method), input)
        pending.set(requestId, resolve)
        const encoded = JSON.stringify({ type: "rpc.request", method, input, id: requestId })
        if (request !== undefined && tracePending && tracePending.size < MAX_TRACE_PENDING) {
          tracePending.set(requestId, request)
          observe(() => trace?.onRequest?.({ requestID: requestId, request, encodedBytes: encodedBytes(encoded) }))
        }
        target.postMessage(encoded)
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}

export * as Rpc from "./rpc"
