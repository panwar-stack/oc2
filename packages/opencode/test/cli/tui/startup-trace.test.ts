import { expect, test } from "bun:test"

test("adopts the startup trace immediately after worker creation and closes the current path", async () => {
  const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()
  const spawn = source.indexOf("const worker = constructTuiWorker(file")
  const adopt = source.indexOf("currentProfile.adopt()", spawn)
  const handler = source.indexOf("worker.onerror", spawn)
  const rpc = source.indexOf("Rpc.client", spawn)
  const close = source.indexOf("startupProfile.close()", adopt)

  expect(spawn).toBeGreaterThan(-1)
  expect(adopt).toBeGreaterThan(spawn)
  expect(source.slice(spawn, adopt)).not.toContain("worker.onerror")
  expect(source.slice(spawn, adopt)).not.toContain("worker.terminate")
  expect(source.slice(spawn, adopt)).not.toContain("Rpc.")
  expect(adopt).toBeLessThan(handler)
  expect(adopt).toBeLessThan(rpc)
  expect(close).toBeGreaterThan(adopt)
  expect(source).toContain("delete env[OC2_TUI_STARTUP_PROFILE]")
  expect(source).toContain("delete env[OC2_TUI_STARTUP_PROFILE_FD]")
  expect(source).toContain('env[OC2_TUI_STARTUP_PROFILE_WORKER] = "1"')
  expect(source).toContain("createParentRpcTrace(startupProfile)")
  expect(source).toContain('client.on("startup.trace"')
  expect(source).toContain("startupTrace: startupProfile.enabled")
})

test("keeps RPC envelopes unchanged while tracing exact finalized strings and dispatch only", async () => {
  const source = await Bun.file(new URL("../../../src/util/rpc.ts", import.meta.url)).text()
  const parse = source.indexOf("const parsed = JSON.parse(evt.data)")
  const start = source.indexOf("start = clock!()", parse)
  const dispatch = source.indexOf("await rpc[parsed.method](parsed.input)", start)
  const stop = source.indexOf("clock!() - start", dispatch)
  const result = source.indexOf('JSON.stringify({ type: "rpc.result", result, id: parsed.id })', stop)
  const post = source.indexOf("postMessage(encoded)", result)

  expect(parse).toBeGreaterThan(-1)
  expect(start).toBeGreaterThan(parse)
  expect(dispatch).toBeGreaterThan(start)
  expect(stop).toBeGreaterThan(dispatch)
  expect(result).toBeGreaterThan(stop)
  expect(post).toBeGreaterThan(result)
  expect(source).toContain("new TextEncoder().encode(value).byteLength")
  expect(source).toContain('JSON.stringify({ type: "rpc.request", method, input, id: requestId })')
})

test("worker reports durations through RPC without inheriting the trace descriptor", async () => {
  const source = await Bun.file(new URL("../../../src/cli/tui/worker.ts", import.meta.url)).text()

  expect(source).toContain('process.env[OC2_TUI_STARTUP_PROFILE_WORKER] === "1"')
  expect(source).toContain('Rpc.emit("startup.trace", input)')
  expect(source).toContain("Rpc.listen(rpc, trace)")
  expect(source).not.toContain("OC2_TUI_STARTUP_PROFILE_FD")
})

test("reports synchronous worker construction failure before preserving the throw", async () => {
  const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()
  const construct = source.indexOf("constructTuiWorker(file")
  const failed = source.indexOf('outcome: "error"', construct)
  const adopt = source.indexOf("currentProfile.adopt()", failed)
  const succeeded = source.indexOf('outcome: "ok"', adopt)

  expect(construct).toBeGreaterThan(-1)
  expect(failed).toBeGreaterThan(construct)
  expect(adopt).toBeGreaterThan(failed)
  expect(succeeded).toBeGreaterThan(adopt)
})
