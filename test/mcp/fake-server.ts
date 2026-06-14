#!/usr/bin/env bun

const encoder = new TextEncoder()

async function main() {
  let nextRequestId = 1000
  const pendingRequests = new Map<number, number>()
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of new TextDecoder().decode(chunk).split("\n")) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line) as {
          id?: number
          method?: string
          params?: Record<string, unknown>
          result?: unknown
          error?: unknown
        }
        if (message.id === undefined) {
          if (message.method === "notifications/initialized") continue
          continue
        }
        const pendingTool = pendingRequests.get(message.id as number)
        if (pendingTool !== undefined) {
          pendingRequests.delete(message.id as number)
          write({
            id: pendingTool,
            result: { content: [{ type: "text", text: JSON.stringify(message.result ?? message.error ?? {}) }] },
          })
          continue
        }
        if (message.method === "initialize") {
          write({
            id: message.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: { listChanged: true },
                resources: { listChanged: true, subscribe: false },
                prompts: { listChanged: true },
              },
              serverInfo: { name: "fake-fixture", version: "1.0.0" },
            },
          })
          continue
        }
        if (message.method === "tools/list") {
          write({
            id: message.id,
            result: {
              tools: [
                { name: "echo", description: "Echo input", inputSchema: { type: "object", properties: {} } },
                {
                  name: "trigger_change",
                  description: "Trigger list-changed notifications",
                  inputSchema: { type: "object", properties: {} },
                },
                {
                  name: "request_roots",
                  description: "Sends roots/list to client and returns response",
                  inputSchema: { type: "object", properties: {} },
                },
                {
                  name: "request_sampling",
                  description: "Sends sampling/createMessage to client and returns response",
                  inputSchema: { type: "object", properties: {} },
                },
                {
                  name: "request_sampling_cancel",
                  description: "Sends sampling/createMessage then cancellation to client",
                  inputSchema: { type: "object", properties: {} },
                },
                {
                  name: "request_elicitation",
                  description: "Sends elicitation/create to client and returns response",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          })
          continue
        }
        if (message.method === "tools/call") {
          const args = message.params as Record<string, unknown> | undefined
          const toolName = args?.name as string | undefined
          if (toolName === "trigger_change") {
            write({
              id: message.id,
              result: { content: [{ type: "text", text: "all list-changed notifications emitted" }] },
            })
            notifyChanged("notifications/tools/list_changed")
            notifyChanged("notifications/resources/list_changed")
            notifyChanged("notifications/prompts/list_changed")
            continue
          }
          if (toolName === "request_roots") {
            const requestId = nextRequestId++
            pendingRequests.set(requestId, message.id as number)
            Bun.stdout.write(
              encoder.encode(
                `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "roots/list", params: {} })}\n`,
              ),
            )
            continue
          }
          if (toolName === "request_sampling") {
            const requestId = nextRequestId++
            pendingRequests.set(requestId, message.id as number)
            Bun.stdout.write(
              encoder.encode(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: requestId,
                  method: "sampling/createMessage",
                  params: { messages: [{ role: "user", content: { type: "text", text: "sample" } }] },
                })}\n`,
              ),
            )
            continue
          }
          if (toolName === "request_sampling_cancel") {
            const requestId = nextRequestId++
            pendingRequests.set(requestId, message.id as number)
            Bun.stdout.write(
              encoder.encode(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: requestId,
                  method: "sampling/createMessage",
                  params: { messages: [{ role: "user", content: { type: "text", text: "cancel sample" } }] },
                })}\n`,
              ),
            )
            setTimeout(() => {
              Bun.stdout.write(
                encoder.encode(
                  `${JSON.stringify({
                    jsonrpc: "2.0",
                    method: "notifications/cancelled",
                    params: { requestId, reason: "server cancelled sampling" },
                  })}\n`,
                ),
              )
            }, 10)
            continue
          }
          if (toolName === "request_elicitation") {
            const requestId = nextRequestId++
            pendingRequests.set(requestId, message.id as number)
            Bun.stdout.write(
              encoder.encode(
                `${JSON.stringify({
                  jsonrpc: "2.0",
                  id: requestId,
                  method: "elicitation/create",
                  params: {
                    message: "Approve request?",
                    requestedSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
                  },
                })}\n`,
              ),
            )
            continue
          }
          write({
            id: message.id,
            result: { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] },
          })
          continue
        }
        if (message.method === "resources/list") {
          write({
            id: message.id,
            result: {
              resources: [
                {
                  name: "fixture-readme",
                  uri: "file:///tmp/fixture-readme.md",
                  description: "A fixture resource",
                  mimeType: "text/markdown",
                },
              ],
            },
          })
          continue
        }
        if (message.method === "resources/read") {
          write({
            id: message.id,
            result: {
              contents: [
                {
                  uri: "file:///tmp/fixture-readme.md",
                  mimeType: "text/markdown",
                  text: "# Fixture Resource\n\nHello from fixture.",
                },
              ],
            },
          })
          continue
        }
        if (message.method === "prompts/list") {
          write({
            id: message.id,
            result: {
              prompts: [
                {
                  name: "fixture-greeting",
                  description: "A fixture prompt",
                  arguments: [{ name: "name", description: "Your name", required: true }],
                },
              ],
            },
          })
          continue
        }
        if (message.method === "prompts/get") {
          write({
            id: message.id,
            result: {
              description: "Greeting prompt",
              messages: [
                {
                  role: "user",
                  content: {
                    type: "text",
                    text: `Hello ${((message.params as Record<string, unknown>)?.arguments as Record<string, unknown>)?.name ?? "world"}!`,
                  },
                },
              ],
            },
          })
          continue
        }
        write({
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        })
      } catch {
        // Malformed JSON lines are ignored to avoid crashing on logs written to stdout.
      }
    }
  }
}

await main()

function write(message: Record<string, unknown>) {
  Bun.stdout.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`))
}

function notifyChanged(method: string) {
  Bun.stdout.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`))
}
