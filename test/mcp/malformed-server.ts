#!/usr/bin/env bun

const encoder = new TextEncoder()
Bun.stdout.write(encoder.encode("not json from a noisy server\n"))

async function main() {
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of new TextDecoder().decode(chunk).split("\n")) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (message.id === undefined) continue
      if (message.method === "initialize") {
        write({ id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {} } })
      }
      if (message.method === "tools/list") {
        write({ id: message.id, result: { tools: [] } })
      }
    }
  }
}

await main()

function write(message: Record<string, unknown>) {
  Bun.stdout.write(encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`))
}
