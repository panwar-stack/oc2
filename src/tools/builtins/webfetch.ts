import { z } from "zod"

import { ToolExecutionError, type ToolDefinition } from "../tool"
import { objectSchema, stringProperty } from "./schema"

const inputSchema = z.object({
  url: z.string().url(),
  format: z.enum(["text", "markdown", "html"]).optional(),
})

/** Creates the built-in web fetch tool with protocol, content-type, and response-size guards. */
export const createWebfetchTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "webfetch",
  description: "Fetch HTTP or HTTPS content with a bounded response size.",
  inputSchema,
  modelInputSchema: objectSchema(
    { url: stringProperty("URL to fetch"), format: stringProperty("text, markdown, or html") },
    ["url"],
  ),
  permission: { action: "network", resource: (input) => input.url },
  async execute(input, context) {
    const url = new URL(input.url)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ToolExecutionError({ code: "unsupported_url", message: "Only HTTP and HTTPS URLs are supported" })
    }
    const response = await (context.fetch ?? fetch)(url, { signal: context.signal })
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > 5 * 1024 * 1024) {
      throw new ToolExecutionError({ code: "response_too_large", message: "Response exceeded 5 MiB" })
    }
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text") && !contentType.includes("json") && !contentType.includes("html")) {
      throw new ToolExecutionError({ code: "unsupported_content", message: `Unsupported content type: ${contentType}` })
    }
    return {
      url: url.toString(),
      status: response.status,
      contentType,
      content: new TextDecoder().decode(bytes),
      format: input.format ?? "markdown",
    }
  },
})
