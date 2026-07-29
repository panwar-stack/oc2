import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { constructTuiWorker, loadTuiRuntime, resolveThreadDirectory } from "../../../src/cli/cmd/tui"
import { Rpc, type RpcTrace } from "../../../src/util/rpc"
import { startupRequestName } from "../../../src/cli/tui/startup-trace"

describe("tui thread", () => {
  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    expect(source).toMatch(/import\(["']\.\.\/tui\/layer["']\)/)
    expect(source).toMatch(/import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toContain('import("./app")')
  })

  test("loads TUI runtime modules in the legacy sequential order", async () => {
    const effect = Promise.withResolvers<string>()
    const layer = Promise.withResolvers<string>()
    const calls: string[] = []
    const loading = loadTuiRuntime({
      effect: () => {
        calls.push("effect")
        return effect.promise
      },
      layer: () => {
        calls.push("layer")
        return layer.promise
      },
      plugin: async () => {
        calls.push("plugin")
        return "plugin"
      },
    })

    await Promise.resolve()
    expect(calls).toEqual(["effect"])
    effect.resolve("effect")
    await Promise.resolve()
    expect(calls).toEqual(["effect", "layer"])
    layer.resolve("layer")
    expect(await loading).toEqual(["effect", "layer", "plugin"])
    expect(calls).toEqual(["effect", "layer", "plugin"])
  })

  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })

  test("preserves synchronous worker constructor failure after tracing it", () => {
    const failure = new Error("worker constructor failed")
    let traced = 0

    expect(() =>
      constructTuiWorker(
        new URL("file:///worker.ts"),
        {},
        () => {
          traced++
          throw new Error("trace failed")
        },
        () => {
          throw failure
        },
      ),
    ).toThrow(failure)
    expect(traced).toBe(1)
  })

  test("maps RPC inputs to a closed startup request allowlist", () => {
    expect(startupRequestName("fetch", { method: "GET", url: "http://opencode.internal/config/providers?secret=x" })).toBe(
      "config.providers",
    )
    expect(startupRequestName("fetch", { method: "POST", url: "http://opencode.internal/private/user/123" })).toBe(
      "other",
    )
    expect(startupRequestName("server", { hostname: "private.example" })).toBe("worker.server")
    expect(startupRequestName("fetch", { method: "GET", url: "not a url" })).toBe("other")
  })

  test("counts exact UTF-8 RPC envelope bytes without changing envelopes", async () => {
    const sent: string[] = []
    const requests: Array<{ requestID: number; request: string; encodedBytes: number }> = []
    const responses: Array<{ requestID: number; request: string; encodedBytes: number }> = []
    const target = {
      postMessage(data: string) {
        sent.push(data)
      },
      onmessage: null as ((event: MessageEvent) => void) | null,
    }
    const trace: RpcTrace = {
      requestName: () => "other",
      onRequest: (input) => requests.push(input),
      onResponse: (input) => responses.push(input),
    }
    const client = Rpc.client<{ echo(input: string): string }>(target, trace)
    const result = client.call("echo", "雪")
    const response = JSON.stringify({ type: "rpc.result", result: "é", id: 0 })
    target.onmessage?.(new MessageEvent("message", { data: response }))

    expect(await result).toBe("é")
    expect(sent).toEqual([JSON.stringify({ type: "rpc.request", method: "echo", input: "雪", id: 0 })])
    expect(requests).toEqual([{ requestID: 0, request: "other", encodedBytes: new TextEncoder().encode(sent[0]).byteLength }])
    expect(responses).toEqual([
      { requestID: 0, request: "other", encodedBytes: new TextEncoder().encode(response).byteLength },
    ])
  })

  test("classifies the finalized RPC envelope without rereading live accessors", async () => {
    let methodReads = 0
    let urlReads = 0
    let proxyMethodReads = 0
    let proxyUrlReads = 0
    const input = new Proxy(
      {
        get method() {
          methodReads++
          return "GET"
        },
        get url() {
          urlReads++
          return "http://opencode.internal/config/providers?secret=x"
        },
      },
      {
        get(target, property, receiver) {
          if (property === "method") proxyMethodReads++
          if (property === "url") proxyUrlReads++
          return Reflect.get(target, property, receiver)
        },
      },
    )
    const sent: string[] = []
    const requests: Array<{ requestID: number; request: string; encodedBytes: number }> = []
    const target = {
      postMessage(data: string) {
        sent.push(data)
      },
      onmessage: null as ((event: MessageEvent) => void) | null,
    }
    const client = Rpc.client<{ fetch(value: { method: string; url: string }): string }>(target, {
      requestName: startupRequestName,
      onRequest: (request) => requests.push(request),
    })

    const result = client.call("fetch", input)
    const expected =
      '{"type":"rpc.request","method":"fetch","input":{"method":"GET","url":"http://opencode.internal/config/providers?secret=x"},"id":0}'
    expect(sent).toEqual([expected])
    expect({ methodReads, urlReads, proxyMethodReads, proxyUrlReads }).toEqual({
      methodReads: 1,
      urlReads: 1,
      proxyMethodReads: 1,
      proxyUrlReads: 1,
    })
    expect(requests).toEqual([
      { requestID: 0, request: "config.providers", encodedBytes: new TextEncoder().encode(expected).byteLength },
    ])
    target.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify({ type: "rpc.result", result: "ok", id: 0 }) }),
    )
    expect(await result).toBe("ok")
  })

  test("drops RPC trace correlation and telemetry when postMessage throws", async () => {
    const requests: unknown[] = []
    const responses: unknown[] = []
    const target = {
      postMessage() {
        throw new Error("post failed")
      },
      onmessage: null as ((event: MessageEvent) => void) | null,
    }
    const client = Rpc.client<{ echo(input: string): string }>(target, {
      requestName: () => "other",
      onRequest: (input) => requests.push(input),
      onResponse: (input) => responses.push(input),
    })

    const failure = await client.call("echo", "hello").then(
      () => undefined,
      (error) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.message).toBe("post failed")
    target.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify({ type: "rpc.result", result: "late", id: 0 }) }),
    )
    expect(requests).toEqual([])
    expect(responses).toEqual([])
  })

  test("orders trace request before a synchronous mock response", async () => {
    const order: string[] = []
    const target = {
      postMessage(data: string) {
        const request = JSON.parse(data)
        target.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify({ type: "rpc.result", result: request.input, id: request.id }),
          }),
        )
      },
      onmessage: null as ((event: MessageEvent) => void) | null,
    }
    const client = Rpc.client<{ echo(input: string): string }>(target, {
      requestName: () => "other",
      onRequest: () => order.push("request"),
      onResponse: () => order.push("response"),
    })

    expect(await client.call("echo", "hello")).toBe("hello")
    expect(order).toEqual(["request", "response"])
  })

  test.serial("times only worker handler dispatch and preserves result encoding", async () => {
    const previousOnMessage = globalThis.onmessage
    const previousPostMessage = globalThis.postMessage
    const posted: string[] = []
    const dispatches: Array<{ requestID: number; request: string; durationMs: number }> = []
    const times = [100, 125]
    try {
      Object.defineProperty(globalThis, "postMessage", {
        configurable: true,
        value(data: string) {
          posted.push(data)
        },
      })
      Rpc.listen(
        {
          async echo(input: string) {
            return input + "é"
          },
        },
        {
          requestName: () => "other",
          clock: () => times.shift()!,
          onDispatch: (input) => dispatches.push(input),
        },
      )
      const handler = globalThis.onmessage
      if (!handler) throw new Error("RPC listener not installed")
      await Promise.resolve(
        Reflect.apply(handler, globalThis, [
          new MessageEvent("message", {
            data: JSON.stringify({ type: "rpc.request", method: "echo", input: "雪", id: 3 }),
          }),
        ]),
      )

      expect(dispatches).toEqual([{ requestID: 3, request: "other", durationMs: 25 }])
      expect(posted).toEqual([JSON.stringify({ type: "rpc.result", result: "雪é", id: 3 })])
      expect(times).toEqual([])
    } finally {
      globalThis.onmessage = previousOnMessage
      Object.defineProperty(globalThis, "postMessage", { configurable: true, value: previousPostMessage })
    }
  })
})
