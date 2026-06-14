#!/usr/bin/env bun

import { runCli } from "./cli/index"

export { VERSION } from "./version"

export * from "./events/events"
export * from "./events/event-bus"
export * from "./events/projector"
export * from "./scheduler/task"
export * from "./scheduler/priority"
export * from "./scheduler/queue"
export * from "./scheduler/scheduler"
export * from "./persistence/db"
export * from "./persistence/migrations"
export * from "./persistence/schema"
export * from "./persistence/repositories/sessions"
export * from "./persistence/repositories/messages"
export * from "./persistence/repositories/tool-calls"
export * from "./persistence/repositories/runtime-events"
export * from "./persistence/repositories/mcp"
export * from "./session/message"
export * from "./session/session-service"
export * from "./session/transcript"

if (import.meta.main) {
  const result = await runCli()
  process.exitCode = result.exitCode
}
