#!/usr/bin/env bun

const encoder = new TextEncoder()
let sessionId = `sess-${crypto.randomUUID()}`
const sseClients = new Set<(data: string) => void>()

function notifyChanged(method: string) {
  const data = JSON.stringify({ jsonrpc: "2.0", method })
  for (const send of sseClients) send(data)
}

function handleRequest(body: Record<string, unknown>): Record<string, unknown> {
  const id = body.id as number | undefined
  const method = body.method as string | undefined
  const params = body.params as Record<string, unknown> | undefined

  if (id === undefined) return {}

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true, subscribe: false },
          prompts: { listChanged: true },
        },
        serverInfo: { name: "http-fixture", version: "1.0.0" },
      },
    }
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          { name: "echo", description: "Echo input", inputSchema: { type: "object", properties: {} } },
          {
            name: "trigger_change",
            description: "Trigger list-changed notifications",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    }
  }

  if (method === "tools/call") {
    const toolName = params?.name as string | undefined
    if (toolName === "trigger_change") {
      notifyChanged("notifications/tools/list_changed")
      notifyChanged("notifications/resources/list_changed")
      notifyChanged("notifications/prompts/list_changed")
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "all list-changed notifications emitted" }] },
      }
    }
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(params ?? {}) }] },
    }
  }

  if (method === "resources/list") {
    return {
      jsonrpc: "2.0",
      id,
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
    }
  }

  if (method === "resources/read") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [
          {
            uri: "file:///tmp/fixture-readme.md",
            mimeType: "text/markdown",
            text: "# Fixture Resource\n\nHello from fixture.",
          },
        ],
      },
    }
  }

  if (method === "prompts/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        prompts: [
          {
            name: "fixture-greeting",
            description: "A fixture prompt",
            arguments: [{ name: "name", description: "Your name", required: true }],
          },
        ],
      },
    }
  }

  if (method === "prompts/get") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        description: "Greeting prompt",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Hello ${(params?.arguments as Record<string, unknown>)?.name ?? "world"}!`,
            },
          },
        ],
      },
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  }
}

const server = Bun.serve({
  port: 0,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    const method = req.method.toUpperCase()

    if (method === "DELETE" && url.pathname === "/session") {
      sessionId = `sess-${crypto.randomUUID()}`
      for (const send of sseClients) send("close")
      sseClients.clear()
      return new Response(null, { status: 204 })
    }

    if (method === "GET" && url.pathname === "/sse") {
      let closed = false
      const stream = new ReadableStream({
        start(controller) {
          const send = (data: string) => {
            if (closed) return
            try {
              controller.enqueue(encoder.encode(`data: ${data}\n\n`))
            } catch {}
          }
          sseClients.add(send)
          send(JSON.stringify({ type: "connected", sessionId }))
        },
        cancel() {
          closed = true
        },
      })
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Mcp-Session-Id": sessionId,
        },
      })
    }

    if (method === "POST" && (url.pathname === "/" || url.pathname === "/mcp")) {
      let rawBody: string
      try {
        rawBody = await Bun.readableStreamToText(req.body!)
      } catch {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        )
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>
      } catch {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        )
      }
      const result = handleRequest(body)
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json", "Mcp-Session-Id": sessionId },
      })
    }

    return new Response("Not found", { status: 404 })
  },
})

// Print port and url for test discovery
const port = server.port
const url = `http://localhost:${port}`
Bun.stdout.write(encoder.encode(`${JSON.stringify({ port, url })}\n`))

// Keep alive until stdin closes
async function keepAlive() {
  for await (const _ of Bun.stdin.stream()) {
  }
  server.stop()
}
void keepAlive()
