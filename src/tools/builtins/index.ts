import { createToolRegistry, type ToolRegistry } from "../registry"
import type { ToolDefinition } from "../tool"
import { createApplyPatchTool } from "./apply-patch"
import { createBashTool } from "./bash"
import { createEditTool } from "./edit"
import { createGlobTool } from "./glob"
import { createGrepTool } from "./grep"
import { createOpenGrepTool } from "./opengrep"
import { createQuestionTool } from "./question"
import { createReadTool } from "./read"
import { createTodoWriteTool } from "./todowrite"
import { createWebfetchTool } from "./webfetch"
import { createWriteTool } from "./write"

/** Instantiates the default built-in tools in the order exposed to the registry. */
export const createBuiltInTools = (): readonly ToolDefinition[] => [
  createReadTool(),
  createGlobTool(),
  createGrepTool(),
  createWriteTool(),
  createEditTool(),
  createApplyPatchTool(),
  createBashTool(),
  createTodoWriteTool(),
  createQuestionTool(),
  createWebfetchTool(),
  createOpenGrepTool(),
]

/** Creates a registry preloaded with all built-in tools. */
export const createBuiltInToolRegistry = (): ToolRegistry => createToolRegistry(createBuiltInTools())

export { createReadTool } from "./read"
export { createGlobTool } from "./glob"
export { createGrepTool } from "./grep"
export { createWriteTool } from "./write"
export { createEditTool } from "./edit"
export { createApplyPatchTool } from "./apply-patch"
export { createBashTool } from "./bash"
export { createTodoWriteTool } from "./todowrite"
export { createQuestionTool } from "./question"
export { createWebfetchTool } from "./webfetch"
export { createOpenGrepTool } from "./opengrep"
