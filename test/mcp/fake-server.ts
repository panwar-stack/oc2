#!/usr/bin/env bun

const encoder = new TextEncoder()

/** Minimal line-delimited JSON-RPC MCP fixture used by CLI smoke tests. */
async function main() {
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of new TextDecoder().decode(chunk).split("\n")) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> }
      if (message.id === undefined) continue
      if (message.method === "initialize") {
        write({
          id: message.id,
          result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake" } },
        })
      }
      if (message.method === "tools/list") {
        write({
          id: message.id,
          result: {
            tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: {} } }],
          },
        })
      }
      if (message.method === "tools/call") {
        write({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify(message.params ?? {}) }] } })
      }
    }
  }
}

await main()

function write(message: Record<string, unknown>) {
  Bun.stdout.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`))
}
