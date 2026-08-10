type Definition = {
  [method: string]: (input: any) => any
}

type SerializedError = {
  name: string
  message: string
  stack?: string
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return {
    name: "Error",
    message: typeof error === "string" ? error : String(error),
  }
}

function deserializeError(error: SerializedError) {
  const result = new Error(error.message)
  result.name = error.name
  if (error.stack) result.stack = error.stack
  return result
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.request") {
      try {
        const result = await rpc[parsed.method](parsed.input)
        postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
      } catch (error) {
        postMessage(JSON.stringify({ type: "rpc.error", error: serializeError(error), id: parsed.id }))
      }
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
  addEventListener?: (type: string, listener: (event: any) => any) => void
}) {
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let failure: Error | undefined
  let id = 0
  const rejectPending = (error: Error) => {
    failure ??= error
    const calls = [...pending.values()]
    pending.clear()
    for (const call of calls) call.reject(failure)
  }
  target.addEventListener?.("error", (event) => {
    rejectPending(event.error instanceof Error ? event.error : new Error(event.message || "RPC worker error"))
  })
  target.addEventListener?.("close", (event) => {
    const code = typeof event.code === "number" ? ` (code ${event.code})` : ""
    rejectPending(new Error(`RPC worker closed${code}`))
  })
  target.onmessage = async (evt) => {
    const parsed = JSON.parse(evt.data)
    if (parsed.type === "rpc.result") {
      const call = pending.get(parsed.id)
      if (call) {
        pending.delete(parsed.id)
        call.resolve(parsed.result)
      }
    }
    if (parsed.type === "rpc.error") {
      const call = pending.get(parsed.id)
      if (call) {
        pending.delete(parsed.id)
        call.reject(deserializeError(parsed.error))
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
      if (failure) return Promise.reject(failure)
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        try {
          target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
        } catch (error) {
          pending.delete(requestId)
          reject(error)
        }
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
