import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "error-test", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: "fail",
      description: "Return an MCP tool error result",
      inputSchema: {
        type: "object",
        properties: { detail: { type: "string" } },
        required: ["detail"],
        additionalProperties: false,
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, () => ({
  content: [{ type: "text", text: "MCP_RAW_DETAIL_SECRET" }],
  isError: true,
}))

await server.connect(new StdioServerTransport())
