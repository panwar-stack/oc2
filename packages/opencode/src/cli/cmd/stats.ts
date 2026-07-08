import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { Database } from "@oc2-ai/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@oc2-ai/core/session/sql"
import { Project } from "@/project/project"
import { ProjectV2 } from "@oc2-ai/core/project"
import { InstanceRef } from "@/effect/instance-ref"
import { and, eq, gte, inArray, sql, type SQL } from "drizzle-orm"

export interface SessionStats {
  totalSessions: number
  totalMessages: number
  totalCost: number
  totalTokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
  toolUsage: Record<string, number>
  modelUsage: Record<
    string,
    {
      messages: number
      tokens: {
        input: number
        output: number
        cache: {
          read: number
          write: number
        }
      }
      cost: number
    }
  >
  dateRange: {
    earliest: number
    latest: number
  }
  days: number
  costPerDay: number
  tokensPerSession: number
  medianTokensPerSession: number
}

export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs) =>
    yargs
      .option("days", {
        describe: "show stats for the last N days (default: all time)",
        type: "number",
      })
      .option("tools", {
        describe: "number of tools to show (default: all)",
        type: "number",
      })
      .option("models", {
        describe: "show model statistics (default: hidden). Pass a number to show top N, otherwise shows all",
      })
      .option("project", {
        describe: "filter by project (default: all projects, empty string: current project)",
        type: "string",
      }),
  handler: Effect.fn("Cli.stats")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const stats = yield* aggregateSessionStats(args.days, args.project, ctx.project)
    let modelLimit: number | undefined
    if (args.models === true) {
      modelLimit = Infinity
    } else if (typeof args.models === "number") {
      modelLimit = args.models
    }
    displayStats(stats, args.tools, modelLimit)
  }),
})

export const aggregateSessionStats = Effect.fn("Cli.stats.aggregate")(function* (
  days?: number,
  projectFilter?: string,
  currentProject?: Project.Info,
) {
  const { db } = yield* Database.Service
  const MS_IN_DAY = 24 * 60 * 60 * 1000

  const cutoffTime = (() => {
    if (days === undefined) return 0
    if (days === 0) {
      const now = new Date()
      now.setHours(0, 0, 0, 0)
      return now.getTime()
    }
    return Date.now() - days * MS_IN_DAY
  })()

  const windowDays = (() => {
    if (days === undefined) return
    if (days === 0) return 1
    return days
  })()

  const filters: SQL[] = []
  if (cutoffTime > 0) filters.push(gte(SessionTable.time_updated, cutoffTime))
  if (projectFilter !== undefined) {
    const projectID: ProjectV2.ID = (() => {
      if (projectFilter !== "") return ProjectV2.ID.make(projectFilter)
      if (!currentProject) throw new Error("currentProject required when projectFilter is empty string")
      return ProjectV2.ID.make(currentProject.id)
    })()
    filters.push(eq(SessionTable.project_id, projectID))
  }

  const filteredSessions = yield* db
    .select()
    .from(SessionTable)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .all()
    .pipe(Effect.orDie)

  const stats: SessionStats = {
    totalSessions: filteredSessions.length,
    totalMessages: 0,
    totalCost: 0,
    totalTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    toolUsage: {},
    modelUsage: {},
    dateRange: {
      earliest: Date.now(),
      latest: Date.now(),
    },
    days: 0,
    costPerDay: 0,
    tokensPerSession: 0,
    medianTokensPerSession: 0,
  }

  if (filteredSessions.length > 1000) {
    console.log(`Large dataset detected (${filteredSessions.length} sessions). This may take a while...`)
  }

  if (filteredSessions.length === 0) {
    stats.days = windowDays ?? 0
    return stats
  }

  let earliestTime = Date.now()
  let latestTime = 0
  const sessionTotalTokens: number[] = []

  for (const session of filteredSessions) {
    earliestTime = Math.min(earliestTime, cutoffTime > 0 ? session.time_updated : session.time_created)
    latestTime = Math.max(latestTime, session.time_updated)
    sessionTotalTokens.push(
      session.tokens_input +
        session.tokens_output +
        session.tokens_reasoning +
        session.tokens_cache_read +
        session.tokens_cache_write,
    )

    stats.totalCost += session.cost
    stats.totalTokens.input += session.tokens_input
    stats.totalTokens.output += session.tokens_output
    stats.totalTokens.reasoning += session.tokens_reasoning
    stats.totalTokens.cache.read += session.tokens_cache_read
    stats.totalTokens.cache.write += session.tokens_cache_write
  }

  const sessionIDs = filteredSessions.map((session) => session.id)
  const messageCount = yield* db
    .select({ count: sql<number>`count(*)` })
    .from(MessageTable)
    .where(inArray(MessageTable.session_id, sessionIDs))
    .get()
    .pipe(Effect.orDie)
  stats.totalMessages = messageCount?.count ?? 0

  const modelRows = yield* db
    .select({
      providerID: sql<string>`json_extract(${MessageTable.data}, '$.providerID')`,
      modelID: sql<string>`json_extract(${MessageTable.data}, '$.modelID')`,
      messages: sql<number>`count(*)`,
      cost: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.cost'), 0)), 0)`,
      input: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.input'), 0)), 0)`,
      output: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.output'), 0) + coalesce(json_extract(${MessageTable.data}, '$.tokens.reasoning'), 0)), 0)`,
      cacheRead: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.read'), 0)), 0)`,
      cacheWrite: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.write'), 0)), 0)`,
    })
    .from(MessageTable)
    .where(
      and(
        inArray(MessageTable.session_id, sessionIDs),
        sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
      ),
    )
    .groupBy(
      sql`json_extract(${MessageTable.data}, '$.providerID')`,
      sql`json_extract(${MessageTable.data}, '$.modelID')`,
    )
    .all()
    .pipe(Effect.orDie)

  for (const row of modelRows) {
    if (!row.providerID || !row.modelID) continue
    stats.modelUsage[`${row.providerID}/${row.modelID}`] = {
      messages: row.messages,
      tokens: { input: row.input, output: row.output, cache: { read: row.cacheRead, write: row.cacheWrite } },
      cost: row.cost,
    }
  }

  const toolRows = yield* db
    .select({
      tool: sql<string>`json_extract(${PartTable.data}, '$.tool')`,
      count: sql<number>`count(*)`,
    })
    .from(PartTable)
    .where(and(inArray(PartTable.session_id, sessionIDs), sql`json_extract(${PartTable.data}, '$.type') = 'tool'`))
    .groupBy(sql`json_extract(${PartTable.data}, '$.tool')`)
    .all()
    .pipe(Effect.orDie)

  for (const row of toolRows) {
    if (row.tool) stats.toolUsage[row.tool] = row.count
  }

  const rangeDays = Math.max(1, Math.ceil((latestTime - earliestTime) / MS_IN_DAY))
  const effectiveDays = windowDays ?? rangeDays
  stats.dateRange = {
    earliest: earliestTime,
    latest: latestTime,
  }
  stats.days = effectiveDays
  stats.costPerDay = stats.totalCost / effectiveDays
  const totalTokens =
    stats.totalTokens.input +
    stats.totalTokens.output +
    stats.totalTokens.reasoning +
    stats.totalTokens.cache.read +
    stats.totalTokens.cache.write
  stats.tokensPerSession = filteredSessions.length > 0 ? totalTokens / filteredSessions.length : 0
  sessionTotalTokens.sort((a, b) => a - b)
  const mid = Math.floor(sessionTotalTokens.length / 2)
  stats.medianTokensPerSession =
    sessionTotalTokens.length === 0
      ? 0
      : sessionTotalTokens.length % 2 === 0
        ? (sessionTotalTokens[mid - 1] + sessionTotalTokens[mid]) / 2
        : sessionTotalTokens[mid]

  return stats
})

export function displayStats(stats: SessionStats, toolLimit?: number, modelLimit?: number) {
  const width = 56

  function renderRow(label: string, value: string): string {
    const availableWidth = width - 1
    const paddingNeeded = availableWidth - label.length - value.length
    const padding = Math.max(0, paddingNeeded)
    return `│${label}${" ".repeat(padding)}${value} │`
  }

  // Overview section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                       OVERVIEW                         │")
  console.log("├────────────────────────────────────────────────────────┤")
  console.log(renderRow("Sessions", stats.totalSessions.toLocaleString()))
  console.log(renderRow("Messages", stats.totalMessages.toLocaleString()))
  console.log(renderRow("Days", stats.days.toString()))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Cost & Tokens section
  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                    COST & TOKENS                       │")
  console.log("├────────────────────────────────────────────────────────┤")
  const cost = isNaN(stats.totalCost) ? 0 : stats.totalCost
  const costPerDay = isNaN(stats.costPerDay) ? 0 : stats.costPerDay
  const tokensPerSession = isNaN(stats.tokensPerSession) ? 0 : stats.tokensPerSession
  console.log(renderRow("Total Cost", `$${cost.toFixed(2)}`))
  console.log(renderRow("Avg Cost/Day", `$${costPerDay.toFixed(2)}`))
  console.log(renderRow("Avg Tokens/Session", formatNumber(Math.round(tokensPerSession))))
  const medianTokensPerSession = isNaN(stats.medianTokensPerSession) ? 0 : stats.medianTokensPerSession
  console.log(renderRow("Median Tokens/Session", formatNumber(Math.round(medianTokensPerSession))))
  console.log(renderRow("Input", formatNumber(stats.totalTokens.input)))
  console.log(renderRow("Output", formatNumber(stats.totalTokens.output)))
  console.log(renderRow("Cache Read", formatNumber(stats.totalTokens.cache.read)))
  console.log(renderRow("Cache Write", formatNumber(stats.totalTokens.cache.write)))
  console.log("└────────────────────────────────────────────────────────┘")
  console.log()

  // Model Usage section
  if (modelLimit !== undefined && Object.keys(stats.modelUsage).length > 0) {
    const sortedModels = Object.entries(stats.modelUsage).sort(([, a], [, b]) => b.messages - a.messages)
    const modelsToDisplay = modelLimit === Infinity ? sortedModels : sortedModels.slice(0, modelLimit)

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                      MODEL USAGE                       │")
    console.log("├────────────────────────────────────────────────────────┤")

    for (const [model, usage] of modelsToDisplay) {
      console.log(`│ ${model.padEnd(54)} │`)
      console.log(renderRow("  Messages", usage.messages.toLocaleString()))
      console.log(renderRow("  Input Tokens", formatNumber(usage.tokens.input)))
      console.log(renderRow("  Output Tokens", formatNumber(usage.tokens.output)))
      console.log(renderRow("  Cache Read", formatNumber(usage.tokens.cache.read)))
      console.log(renderRow("  Cache Write", formatNumber(usage.tokens.cache.write)))
      console.log(renderRow("  Cost", `$${usage.cost.toFixed(4)}`))
      console.log("├────────────────────────────────────────────────────────┤")
    }
    // Remove last separator and add bottom border
    process.stdout.write("\x1B[1A") // Move up one line
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()

  // Tool Usage section
  if (Object.keys(stats.toolUsage).length > 0) {
    const sortedTools = Object.entries(stats.toolUsage).sort(([, a], [, b]) => b - a)
    const toolsToDisplay = toolLimit ? sortedTools.slice(0, toolLimit) : sortedTools

    console.log("┌────────────────────────────────────────────────────────┐")
    console.log("│                      TOOL USAGE                        │")
    console.log("├────────────────────────────────────────────────────────┤")

    const maxCount = Math.max(...toolsToDisplay.map(([, count]) => count))
    const totalToolUsage = Object.values(stats.toolUsage).reduce((a, b) => a + b, 0)

    for (const [tool, count] of toolsToDisplay) {
      const barLength = Math.max(1, Math.floor((count / maxCount) * 20))
      const bar = "█".repeat(barLength)
      const percentage = ((count / totalToolUsage) * 100).toFixed(1)

      const maxToolLength = 18
      const truncatedTool = tool.length > maxToolLength ? tool.substring(0, maxToolLength - 2) + ".." : tool
      const toolName = truncatedTool.padEnd(maxToolLength)

      const content = ` ${toolName} ${bar.padEnd(20)} ${count.toString().padStart(3)} (${percentage.padStart(4)}%)`
      const padding = Math.max(0, width - content.length - 1)
      console.log(`│${content}${" ".repeat(padding)} │`)
    }
    console.log("└────────────────────────────────────────────────────────┘")
  }
  console.log()
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M"
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K"
  }
  return num.toString()
}
