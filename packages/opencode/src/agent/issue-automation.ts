export const issueAutomationNames = ["issue-task", "issue-planner", "issue-implementer"] as const

const names = new Set<string>(issueAutomationNames)

export function isIssueAutomationName(name: string) {
  return names.has(name)
}
