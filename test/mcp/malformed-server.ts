#!/usr/bin/env bun

const encoder = new TextEncoder()
Bun.stdout.write(encoder.encode("not json from a noisy server\n"))

async function main() {
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of new TextDecoder().decode(chunk).split("\n")) {
      if (!line.trim()) continue
      let message: { id?: number; method?: string }
      try {
        message = JSON.parse(line) as { id?: number; method?: string }
      } catch {
        continue
      }
      if (message.id === undefined) continue
      if (message.method === "initialize") {
        write({ id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } })
        continue
      }
      if (message.method === "tools/list") {
        write({ id: message.id, result: { tools: [] } })
        continue
      }
      if (message.method === "resources/list") {
        write({ id: message.id, result: { resources: [] } })
        continue
      }
      if (message.method === "prompts/list") {
        write({ id: message.id, result: { prompts: [] } })
        continue
      }
      if (message.method === "resources/read") {
        write({ id: message.id, result: { contents: [] } })
        continue
      }
      if (message.method === "prompts/get") {
        write({ id: message.id, result: { messages: [] } })
        continue
      }
      write({ id: message.id, error: { code: -32601, message: "Method not found" } })
    }
  }
}

await main()

function write(message: Record<string, unknown>) {
  Bun.stdout.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`))
}
