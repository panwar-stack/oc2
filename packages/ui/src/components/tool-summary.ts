export type ToolStatus = "pending" | "running" | "completed" | "error"

export type ToolDetail = {
  key: string
  value: string
}

type ToolSummaryInput = {
  tool: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export function toolState(status: unknown, denied = false) {
  if (denied) return { glyph: "failed" as const, label: "Denied", tone: "error" as const, status: "denied" as const }
  if (status === "pending") return { glyph: "pending" as const, label: "Pending", tone: "muted" as const, status }
  if (status === "running") return { glyph: "running" as const, label: "Running", tone: "active" as const, status }
  if (status === "completed") return { glyph: "done" as const, label: "Completed", tone: "success" as const, status }
  if (status === "error") return { glyph: "failed" as const, label: "Failed", tone: "error" as const, status }
}

export function toolDuration(state: unknown, now = Date.now()) {
  if (!state || typeof state !== "object" || Array.isArray(state) || !("time" in state)) return
  const time = state.time
  if (!time || typeof time !== "object" || Array.isArray(time) || !("start" in time)) return
  if (typeof time.start !== "number") return
  const end = "end" in time && typeof time.end === "number" ? time.end : now
  const duration = Math.max(0, end - time.start)
  if (duration < 1_000) return `${Math.round(duration)}ms`
  return `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)}s`
}

export function toolDetails(value: ToolSummaryInput): ToolDetail[] {
  const input = value.input ?? {}
  const fields = (keys: readonly string[]) =>
    keys.flatMap((key) => {
      const item = input[key]
      if (typeof item !== "string" && typeof item !== "number") return []
      return [{ key, value: String(item) }]
    })

  if (value.tool === "read") return fields(["filePath", "path", "offset", "limit"])
  if (value.tool === "glob") return fields(["pattern", "path"])
  if (value.tool === "grep") return fields(["pattern", "path", "include", "exclude"])
  if (value.tool === "list") return fields(["path"])
  if (value.tool === "webfetch") {
    const url = safeWebHref(input.url)
    return url ? [{ key: "url", value: url }] : []
  }
  if (value.tool === "websearch") return fields(["query"])
  if (value.tool === "write" || value.tool === "edit") return fields(["filePath", "path"]).slice(0, 1)
  if (value.tool === "apply_patch") return patchDetails(value.metadata)
  if (value.tool === "bash" || value.tool === "shell") {
    const exit = value.metadata?.exit ?? value.metadata?.exitCode
    return typeof exit === "number" && Number.isFinite(exit) ? [{ key: "exit", value: String(exit) }] : []
  }
  if (value.tool === "task") {
    const status =
      typeof value.metadata?.status === "string" && taskStatuses.has(value.metadata.status)
        ? value.metadata.status
        : undefined
    return [
      ...fields(["subagent_type", "agent_type", "name", "session_id"]),
      ...(status ? [{ key: "status", value: status }] : []),
    ]
  }
  if (value.tool === "todowrite") return countDetails(input.todos, todoStatuses)
  if (value.tool === "question") return questionDetails(input.questions)
  if (value.tool === "skill") return fields(["name"])
  if (isTeamTool(value.tool))
    return fields(["team_id", "task_id", "session_id", "member_name", "recipient", "name", "assignee"])
  return []
}

export function toolSummary(value: ToolSummaryInput) {
  if (value.tool === "bash" || value.tool === "shell") {
    const exit = toolDetails(value).find((item) => item.key === "exit")
    return exit ? `Shell command · exit=${exit.value}` : "Shell command"
  }
  if (value.tool === "webfetch") return safeWebHref(value.input?.url) ?? "Web request"
  if (value.tool === "apply_patch") {
    const details = toolDetails(value)
    if (details.length === 0) return
    if (details.length <= 2) return details.map((item) => item.value).join(", ")
    return `${details.length} files`
  }
  if (value.tool === "todowrite") return countSummary(value.input?.todos, todoStatuses)
  if (value.tool === "question") return questionSummary(value.input?.questions)
  const details = toolDetails(value)
  return details.map((item) => `${item.key}=${item.value}`).join(" · ") || undefined
}

export function toolAggregate(items: ReadonlyArray<{ status: unknown; error?: string; approval?: boolean }>) {
  const approval = items.filter((item) => item.approval).length
  const denied = items.filter((item) => isDeniedToolError(item.error)).length
  const failed = items.filter((item) => item.status === "error" && !isDeniedToolError(item.error)).length
  const running = items.filter((item) => item.status === "running").length
  const pending = items.filter((item) => item.status === "pending").length
  if (approval)
    return {
      glyph: "needs-you" as const,
      label: approval === 1 ? "1 approval" : `${approval} approvals`,
      tone: "purple" as const,
    }
  if (denied)
    return { glyph: "failed" as const, label: denied === 1 ? "1 denied" : `${denied} denied`, tone: "red" as const }
  if (failed)
    return { glyph: "failed" as const, label: failed === 1 ? "failed" : `${failed} failed`, tone: "red" as const }
  if (running) return { glyph: "running" as const, label: "running", tone: "amber" as const }
  if (pending) return { glyph: "pending" as const, label: `${pending} pending`, tone: "neutral" as const }
  return { glyph: "done" as const, label: "all ok", tone: "green" as const }
}

export function isDeniedToolError(error: unknown) {
  if (typeof error !== "string") return false
  const value = error.toLowerCase()
  return (
    value.includes("questionrejectederror") ||
    value.includes("rejected permission") ||
    value.includes("permission denied") ||
    value.includes("specified a rule") ||
    value.includes("user dismissed")
  )
}

export function toolErrorSummary(error: unknown) {
  if (isDeniedToolError(error)) return "permission denied"
  if (typeof error !== "string") return "failed"
  const value = error.toLowerCase()
  if (value.includes("timed out") || value.includes("timeout")) return "timed out"
  if (value.includes("not found") || value.includes("no such file")) return "not found"
  if (value.includes("rate limit")) return "rate limited"
  if (value.includes("unauthorized") || value.includes("authentication") || value.includes("auth error"))
    return "authentication failed"
  if (value.includes("network") || value.includes("connection") || value.includes("connect failed"))
    return "connection failed"
  if (value.includes("cancelled") || value.includes("canceled") || value.includes("aborted")) return "interrupted"
  const exit = value.match(/(?:exit(?:ed)?(?: with)?(?: code)?|code)\s*[:=]?\s*(-?\d+)/)
  if (exit?.[1]) return `exit ${exit[1]}`
  return "failed"
}

export function safeWebHref(value: unknown) {
  if (typeof value !== "string") return
  const url = URL.parse(value)
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.origin === "null") return
  return `${url.origin}${url.pathname}`
}

export function isTeamTool(tool: string) {
  return teamTools.has(tool)
}

function patchDetails(metadata: Record<string, unknown> | undefined) {
  if (!Array.isArray(metadata?.files)) return []
  return metadata.files.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const path =
      "filePath" in item && typeof item.filePath === "string"
        ? item.filePath
        : "relativePath" in item && typeof item.relativePath === "string"
          ? item.relativePath
          : undefined
    return path ? [{ key: `file ${index + 1}`, value: path }] : []
  })
}

function countDetails(value: unknown, known: ReadonlySet<string>) {
  if (!Array.isArray(value)) return []
  const statuses = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("status" in item)) return []
    if (typeof item.status !== "string") return []
    return [known.has(item.status) ? item.status : "other"]
  })
  const counts = statuses.reduce((result, status) => {
    result.set(status, (result.get(status) ?? 0) + 1)
    return result
  }, new Map<string, number>())
  return ["pending", "in_progress", "completed", "cancelled", "other"].flatMap((status) => {
    const count = counts.get(status)
    return count ? [{ key: status, value: String(count) }] : []
  })
}

function countSummary(value: unknown, known: ReadonlySet<string>) {
  const details = countDetails(value, known)
  return details.map((item) => `${item.value} ${item.key}`).join(" · ") || undefined
}

function questionDetails(value: unknown) {
  if (!Array.isArray(value)) return []
  const questions = value.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      "question" in item &&
      typeof item.question === "string",
  )
  if (questions.length === 0) return []
  const multiple = questions.filter((item) => "multiple" in item && item.multiple === true).length
  const single = questions.length - multiple
  return [
    { key: "questions", value: String(questions.length) },
    ...(single ? [{ key: "single-select", value: String(single) }] : []),
    ...(multiple ? [{ key: "multi-select", value: String(multiple) }] : []),
  ]
}

function questionSummary(value: unknown) {
  const details = questionDetails(value)
  if (details.length === 0) return
  const [count, ...kinds] = details
  return `${count!.value} question${count!.value === "1" ? "" : "s"}${
    kinds.length ? ` · ${kinds.map((item) => `${item.value} ${item.key}`).join(" · ")}` : ""
  }`
}

const todoStatuses = new Set(["pending", "in_progress", "completed", "cancelled"])
const taskStatuses = new Set(["pending", "working", "idle", "retry", "completed", "cancelled", "error"])
const teamTools = new Set([
  "team_create",
  "team_spawn",
  "team_send_message",
  "team_broadcast",
  "team_get_messages",
  "team_task_create",
  "team_task_list",
  "team_task_claim",
  "team_task_update",
  "team_plan_submit",
  "team_plan_decide",
  "team_shutdown",
  "team_report",
])
