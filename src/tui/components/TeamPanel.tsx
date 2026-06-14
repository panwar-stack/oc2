import type { TuiState, TuiTeamView } from "../state"

export function TeamPanel({ state }: { readonly state: TuiState }): string {
  const team = state.teams.at(-1)
  if (!team) return "Team panel:\nNo active team."
  return [
    `Team: ${team.name ?? team.id}`,
    `Goal: ${team.goal ?? "not set"}`,
    `Status: ${team.status}`,
    `Report: ${team.reportAvailable || state.teamReportAvailable ? "available (export with team_report)" : "not generated"}`,
    "Members:",
    renderMembers(team),
    "Shared tasks:",
    renderTasks(team),
    "Mailbox:",
    renderMailbox(team),
    "Pending plans:",
    state.pendingPlanApprovals.length
      ? state.pendingPlanApprovals.map((approval) => `- ${approval.memberName}: ${approval.status}`).join("\n")
      : "- none",
  ].join("\n")
}

function renderMembers(team: TuiTeamView): string {
  if (!team.members.length) return "- none"
  return team.members
    .map((member) => {
      const deps = member.dependencyIds.length ? ` deps=${member.dependencyIds.join(",")}` : ""
      const daemon = member.daemonState ? ` daemon=${member.daemonState}` : ""
      const plan = member.planStatus ? ` plan=${member.planStatus}` : ""
      const lifecycle = member.lifecycle ? ` lifecycle=${member.lifecycle}` : ""
      return `- ${member.name}: ${member.status}${lifecycle}${deps}${daemon}${plan}`
    })
    .join("\n")
}

function renderTasks(team: TuiTeamView): string {
  if (!team.tasks.length) return "- none"
  return team.tasks
    .map((task) => {
      const assignee = task.assignee ? ` @${task.assignee}` : ""
      const deps = task.dependencyIds.length ? ` deps=${task.dependencyIds.join(",")}` : ""
      return `- ${task.description ?? task.id}: ${task.status}${assignee}${deps}`
    })
    .join("\n")
}

function renderMailbox(team: TuiTeamView): string {
  if (!team.mailbox.length) return "- no activity"
  return team.mailbox
    .map((message) => `- ${message.sender ?? "unknown"} -> ${message.recipientId}: ${message.body ?? message.id}`)
    .join("\n")
}
