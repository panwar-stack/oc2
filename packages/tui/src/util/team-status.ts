export function isMemberWorking(
  status: { type: string } | undefined,
  teamStatus: { status: string } | undefined,
) {
  if (status?.type === "busy" || status?.type === "retry") return true
  return teamStatus?.status === "active" || teamStatus?.status === "starting"
}
