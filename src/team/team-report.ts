import type { TeamMailboxCounts, TeamMailboxMessage } from "../persistence/repositories/mailbox"
import type { TeamTaskRecord, TeamTaskStatus } from "../persistence/repositories/team-tasks"
import type { TeamMemberRecord, TeamMemberStatus, TeamRecord } from "../persistence/repositories/teams"

export interface TeamReportInput {
  readonly team: TeamRecord
  readonly members: readonly TeamMemberRecord[]
  readonly tasks: readonly TeamTaskRecord[]
  readonly messages: readonly TeamMailboxMessage[]
  readonly mailboxCounts: TeamMailboxCounts
}

export interface TeamReportSummary {
  readonly teamId: string
  readonly teamName: string
  readonly status: string
  readonly members: Record<TeamMemberStatus, number>
  readonly tasks: Record<TeamTaskStatus, number>
  readonly mailbox: TeamMailboxCounts
  readonly daemon: {
    readonly total: number
    readonly states: Record<string, number>
  }
  readonly planApprovals: {
    readonly pending: number
    readonly submitted: number
    readonly approved: number
    readonly rejected: number
  }
  readonly deterministicFindings: readonly string[]
  readonly residualFailures: readonly string[]
  readonly placeholders: {
    readonly runtimeMs: null
    readonly costUsd: null
  }
}

export interface TeamReport {
  readonly summary: TeamReportSummary
  readonly markdown: string
}

const memberStatuses: readonly TeamMemberStatus[] = [
  "starting",
  "blocked",
  "plan_pending",
  "active",
  "idle",
  "completed",
  "failed",
  "cancelled",
]

const taskStatuses: readonly TeamTaskStatus[] = ["pending", "in_progress", "completed", "cancelled"]

/** Builds a deterministic team report from persisted records without reading live runtime state. */
export function buildTeamReport(input: TeamReportInput): TeamReport {
  const members = input.members.toSorted(compareByCreatedThenId)
  const tasks = input.tasks.toSorted(compareByCreatedThenId)
  const messages = input.messages.toSorted(compareByCreatedThenId)
  const memberCounts = countBy(
    memberStatuses,
    members.map((member) => member.status),
  )
  const taskCounts = countBy(
    taskStatuses,
    tasks.map((task) => task.status),
  )
  const daemonStates = countStrings(
    members.filter((member) => member.lifecycle === "daemon").map((member) => member.daemonState ?? "unknown"),
  )
  const pendingPlans = members.filter((member) => member.planMode && member.planStatus !== "approved")
  const planApprovals = {
    pending: pendingPlans.length,
    submitted: members.filter((member) => member.planStatus === "submitted").length,
    approved: members.filter((member) => member.planStatus === "approved").length,
    rejected: members.filter((member) => member.planStatus === "rejected").length,
  }
  const deterministicFindings = findings({ team: input.team, members, tasks, messages, pendingPlans })
  const residualFailures = members
    .filter((member) => member.status === "failed" || member.status === "cancelled" || member.daemonState === "error")
    .map((member) => `${member.name}: ${member.status}${member.daemonError ? ` (${member.daemonError.message})` : ""}`)

  const summary: TeamReportSummary = {
    teamId: input.team.id,
    teamName: input.team.name,
    status: input.team.status,
    members: memberCounts,
    tasks: taskCounts,
    mailbox: input.mailboxCounts,
    daemon: { total: members.filter((member) => member.lifecycle === "daemon").length, states: daemonStates },
    planApprovals,
    deterministicFindings,
    residualFailures,
    placeholders: { runtimeMs: null, costUsd: null },
  }
  return { summary, markdown: renderMarkdown(input.team, summary, members, tasks, messages) }
}

function findings(input: {
  readonly team: TeamRecord
  readonly members: readonly TeamMemberRecord[]
  readonly tasks: readonly TeamTaskRecord[]
  readonly messages: readonly TeamMailboxMessage[]
  readonly pendingPlans: readonly TeamMemberRecord[]
}): readonly string[] {
  const result: string[] = []
  if (input.members.length === 0) result.push("No team members were spawned.")
  if (input.tasks.length === 0) result.push("No shared team tasks were created.")
  for (const member of input.pendingPlans) result.push(`Member ${member.name} is awaiting plan approval.`)
  for (const member of input.members.filter(
    (candidate) => candidate.lifecycle === "daemon" && !candidate.daemonReportingCriteria,
  )) {
    result.push(`Daemon member ${member.name} has no reporting criteria.`)
  }
  const duplicateNames = duplicates(input.members.map((member) => member.name))
  for (const name of duplicateNames) result.push(`Duplicate member name: ${name}`)
  if (input.team.status === "shutdown" && input.messages.some((message) => message.deliveryStatus === "pending")) {
    result.push("Team was shut down with pending mailbox delivery.")
  }
  return result.toSorted()
}

function renderMarkdown(
  team: TeamRecord,
  summary: TeamReportSummary,
  members: readonly TeamMemberRecord[],
  tasks: readonly TeamTaskRecord[],
  messages: readonly TeamMailboxMessage[],
): string {
  return [
    `# Team Report: ${team.name}`,
    "",
    `Goal: ${team.goal}`,
    `Status: ${summary.status}`,
    "",
    "## Members",
    ...members.map(
      (member) => `- ${member.name}: ${member.status}, lifecycle=${member.lifecycle}, plan=${member.planStatus}`,
    ),
    members.length ? "" : "- none",
    "## Tasks",
    ...tasks.map((task) => `- ${task.id}: ${task.status}${task.assignee ? `, assignee=${task.assignee}` : ""}`),
    tasks.length ? "" : "- none",
    "## Mailbox",
    `- messages=${summary.mailbox.messages}`,
    `- delivered=${summary.mailbox.deliveredDeliveries}`,
    `- pending=${summary.mailbox.pendingDeliveries}`,
    `- latest=${messages.at(-1)?.id ?? "none"}`,
    "",
    "## Deterministic Findings",
    ...(summary.deterministicFindings.length ? summary.deterministicFindings : ["No deterministic findings."]).map(
      (finding) => `- ${finding}`,
    ),
    "",
    "## Runtime And Cost",
    "- runtimeMs: unavailable",
    "- costUsd: unavailable",
    "",
    "## Residual Failures",
    ...(summary.residualFailures.length ? summary.residualFailures : ["No residual failures."]).map(
      (failure) => `- ${failure}`,
    ),
  ].join("\n")
}

function countBy<T extends string>(keys: readonly T[], values: readonly T[]): Record<T, number> {
  const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>
  for (const value of values) result[value] = (result[value] ?? 0) + 1
  return result
}

function countStrings(values: readonly string[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const value of values.toSorted()) result[value] = (result[value] ?? 0) + 1
  return result
}

function compareByCreatedThenId<T extends { readonly createdAt: string; readonly id: string }>(
  left: T,
  right: T,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
}

function duplicates(values: readonly string[]): readonly string[] {
  const counts = countStrings(values)
  return Object.keys(counts)
    .filter((value) => (counts[value] ?? 0) > 1)
    .toSorted()
}
