export type ToastVariant = "default" | "info" | "success" | "warning" | "error" | "loading"

const presentation = {
  info: { label: "Info", glyph: "▲" },
  success: { label: "Success", glyph: "✓" },
  warning: { label: "Warning", glyph: "◐" },
  error: { label: "Error", glyph: "✕" },
} as const

export function toastPresentation(variant: ToastVariant = "default", persistent?: boolean) {
  const tone = variant === "default" ? "info" : variant === "loading" ? "warning" : variant
  return { tone, ...presentation[tone], persistent: persistent ?? tone === "error" }
}

export function focusNewestToast(event: FocusEvent & { currentTarget: HTMLOListElement }) {
  if (event.target !== event.currentTarget) return
  const toast = event.currentTarget.lastElementChild
  if (toast instanceof HTMLElement) toast.focus()
}
