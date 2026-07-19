const stateOrder = ["needs_you", "errored", "working", "blocked", "idle", "completed"] as const

export function boardStateRank(state: string) {
  const rank = stateOrder.findIndex((item) => item === state)
  return rank === -1 ? stateOrder.length : rank
}

export function orderBoardItems<T>(items: readonly T[], state: (item: T) => string, identity: (item: T) => string) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const stateDelta = boardStateRank(state(a.item)) - boardStateRank(state(b.item))
      if (stateDelta !== 0) return stateDelta
      const identityDelta = identity(a.item).localeCompare(identity(b.item))
      return identityDelta === 0 ? a.index - b.index : identityDelta
    })
    .map((entry) => entry.item)
}

export function acceptBoardSnapshot<T>(
  current: { revision: number; generation: number; value: T } | undefined,
  next: { revision: number; generation: number; value: T },
) {
  if (!current) return next
  if (next.revision > current.revision) return next
  if (next.revision < current.revision) return current
  return next.generation > current.generation ? next : current
}

export function visibleBoardFocusIDs(groups: readonly { collapsed: boolean; items: readonly { id: string }[] }[]) {
  return groups.flatMap((group) => (group.collapsed ? [] : group.items.map((item) => item.id)))
}

export function moveBoardFocus(input: {
  current: number
  count: number
  columns: number
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End"
}) {
  if (input.count <= 0) return -1
  if (input.key === "Home") return 0
  if (input.key === "End") return input.count - 1
  const current = Math.min(input.count - 1, Math.max(0, input.current))
  const delta =
    input.key === "ArrowLeft"
      ? -1
      : input.key === "ArrowRight"
        ? 1
        : input.key === "ArrowUp"
          ? -Math.max(1, input.columns)
          : Math.max(1, input.columns)
  return (current + delta + input.count) % input.count
}
