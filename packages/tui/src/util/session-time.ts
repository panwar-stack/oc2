export function activeTurnStartedAt(
  messages: readonly { id: string; role: string; time: { created: number } }[],
  userMessageID?: string,
) {
  const message = userMessageID
    ? messages.find((item) => item.id === userMessageID && item.role === "user")
    : messages.findLast((item) => item.role === "user")
  const created = message?.time.created
  return typeof created === "number" && Number.isFinite(created) ? created : undefined
}
