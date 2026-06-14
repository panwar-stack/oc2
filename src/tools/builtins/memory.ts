import { z } from "zod"

import { ToolExecutionError, type ToolDefinition } from "../tool"
import { numberProperty, objectSchema, stringProperty } from "./schema"

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("store"),
    repository: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    key: z.string().min(1),
    content: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    action: z.literal("search"),
    repository: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    query: z.string(),
    limit: z.number().int().positive().max(50).optional(),
  }),
  z.object({
    action: z.literal("get"),
    repository: z.string().min(1).optional(),
    kind: z.string().min(1).optional(),
    key: z.string().min(1),
  }),
])

/** Creates the local repository memory tool backed by an injected SQLite repository. */
export const createMemoryTool = (): ToolDefinition<z.infer<typeof inputSchema>> => ({
  name: "memory",
  description: "Store and retrieve local-only repository memory entries.",
  inputSchema,
  modelInputSchema: objectSchema(
    {
      action: { type: "string", enum: ["store", "search", "get"], description: "Memory operation" },
      repository: stringProperty("Local repository path; defaults to cwd or first workspace root"),
      kind: stringProperty("Entry kind, such as note, decision, or file"),
      key: stringProperty("Stable entry key for store/get"),
      content: stringProperty("Entry content for store"),
      metadata: { type: "object", description: "Local metadata to store with the entry" },
      query: stringProperty("Search query"),
      limit: numberProperty("Maximum search results"),
    },
    ["action"],
  ),
  permission: {
    action: "memory",
    resource: (input, context) => input.repository ?? context.cwd ?? "repository-memory",
  },
  execute(input, context) {
    if (!context.memory) {
      throw new ToolExecutionError({
        code: "memory_unavailable",
        message: "Repository memory is not configured for this runtime",
      })
    }
    const repositoryIdentity = input.repository ?? context.cwd ?? context.workspaceRoots[0]?.path
    if (!repositoryIdentity) {
      throw new ToolExecutionError({ code: "missing_repository", message: "A repository path is required" })
    }

    if (input.action === "store") {
      const entry = context.memory.storeEntry({
        repositoryIdentity,
        kind: input.kind,
        key: input.key,
        content: input.content,
        metadata: input.metadata,
      })
      return { action: input.action, entry }
    }
    if (input.action === "get") {
      const entry = context.memory.getEntry({ repositoryIdentity, kind: input.kind, key: input.key })
      return { action: input.action, entry: entry ?? null }
    }
    const entries = context.memory.search({
      repositoryIdentity,
      kind: input.kind,
      query: input.query,
      limit: input.limit,
      sessionId: context.sessionId,
      tool: "memory",
    })
    return { action: input.action, entries }
  },
})
