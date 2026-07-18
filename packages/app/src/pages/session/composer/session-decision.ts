import { createEffect, onCleanup, type Accessor } from "solid-js"

const titlePrefix = "▲ "

export function questionDecisionPresentation(input: {
  multiple: boolean
  selected: number
  total: number
  last: boolean
  planApproval?: boolean
  planDecision?: string
}) {
  return {
    groupRole: input.multiple ? ("group" as const) : ("radiogroup" as const),
    optionRole: input.multiple ? ("checkbox" as const) : ("radio" as const),
    selection: `${input.selected} of ${input.total} selected`,
    confirm: input.last
      ? input.planApproval
        ? input.planDecision === "No"
          ? "Keep planning"
          : input.planDecision === "Yes"
            ? "Approve plan"
            : "Choose plan action"
        : input.multiple
          ? `Confirm ${input.selected}`
          : "Confirm answer"
      : "Next question",
  }
}

export function decisionKey(key: string, total: number) {
  if (key === "Escape") return { type: "cancel" as const }
  if (key === "Enter") return { type: "confirm" as const }
  if (key === " " || key === "Spacebar") return { type: "toggle" as const }
  if (key === "ArrowDown" || key === "ArrowRight") return { type: "move" as const, step: 1 }
  if (key === "ArrowUp" || key === "ArrowLeft") return { type: "move" as const, step: -1 }
  if (key === "Home") return { type: "index" as const, index: 0 }
  if (key === "End") return { type: "index" as const, index: Math.max(0, total - 1) }
  if (!/^[1-9]$/.test(key)) return
  const index = Number(key) - 1
  if (index >= total) return
  return { type: "pick" as const, index }
}

export function decisionDocumentTitle(title: string, pending: boolean) {
  const base = title.startsWith(titlePrefix) ? title.slice(titlePrefix.length) : title
  return pending ? `${titlePrefix}${base}` : base
}

export function pendingDecisionTitleController(target: Document) {
  let active = false
  const update = () => {
    const next = decisionDocumentTitle(target.title, active)
    if (target.title !== next) target.title = next
  }
  const observer = new MutationObserver(update)
  observer.observe(target.head, { childList: true, subtree: true, characterData: true })

  return {
    set(pending: boolean) {
      active = pending
      update()
    },
    dispose() {
      observer.disconnect()
      active = false
      update()
    },
  }
}

export function usePendingDecisionTitle(pending: Accessor<boolean>) {
  if (typeof document !== "object") return
  const controller = pendingDecisionTitleController(document)

  createEffect(() => {
    controller.set(pending())
  })

  onCleanup(controller.dispose)
}
