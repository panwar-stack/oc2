/** Builds the isolated prompt sent to a teammate child session. */
export function buildTeamMemberPrompt(input: {
  readonly teamName: string
  readonly teamGoal: string
  readonly memberName: string
  readonly rolePrompt: string
  readonly daemonReportingCriteria?: string
}): string {
  const daemon = input.daemonReportingCriteria
    ? `\nDaemon reporting criteria:\n${input.daemonReportingCriteria}\nReport only when these criteria are met.`
    : ""
  return `Team: ${input.teamName}\nGoal: ${input.teamGoal}\nMember: ${input.memberName}\n\nAssignment:\n${input.rolePrompt}${daemon}`
}
