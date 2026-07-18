import { For, Show, createContext, onCleanup, useContext, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "./border"
import { TextAttributes } from "@opentui/core"
import { useBindings } from "../keymap"

export type ToastVariant = "info" | "success" | "warning" | "error"
export type ToastOptions = {
  title?: string
  message: string
  variant: ToastVariant
  duration: number
  persistent?: boolean
}
type ToastInput = Omit<ToastOptions, "duration" | "persistent" | "variant"> & {
  variant?: ToastVariant
  duration?: number
  persistent?: boolean
}
type ToastItem = Omit<ToastOptions, "persistent"> & { id: number; persistent: boolean }

export const TOAST_GLYPHS: Record<ToastVariant, string> = {
  info: "▲",
  success: "✓",
  warning: "◐",
  error: "✕",
}

export function Toast(props: { dialogActive?: boolean }) {
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const persistent = () => toast.toasts.findLast((item) => item.persistent)

  useBindings(() => ({
    enabled: Boolean(persistent()) && !props.dialogActive,
    bindings: [
      {
        key: "escape",
        desc: "Dismiss notification",
        group: "Toast",
        cmd: () => {
          const current = persistent()
          if (current) toast.dismiss(current.id)
        },
      },
    ],
  }))

  return (
    <Show when={toast.toasts.length > 0}>
      <box position="absolute" flexDirection="column" gap={1} top={2} right={2} zIndex={2000}>
        <For each={toast.toasts}>
          {(current) => {
            const color = () => (current.variant === "info" ? theme.accent : theme[current.variant])
            return (
              <box
                maxWidth={Math.min(60, dimensions().width - 6)}
                paddingLeft={2}
                paddingRight={2}
                paddingTop={1}
                paddingBottom={1}
                backgroundColor={theme.backgroundElement}
                borderColor={color()}
                border={["left", "right"]}
                customBorderChars={SplitBorder.customBorderChars}
                onMouseUp={() => toast.dismiss(current.id)}
              >
                <Show when={current.title}>
                  {(title) => (
                    <text attributes={TextAttributes.BOLD} fg={theme.text} wrapMode="none">
                      {title()}
                    </text>
                  )}
                </Show>
                <box flexDirection="row" gap={1}>
                  <text fg={theme.text} wrapMode="word" flexGrow={1}>
                    {current.message}
                  </text>
                  <Show when={current.persistent && !props.dialogActive}>
                    <text fg={theme.textFaint}>esc</text>
                  </Show>
                  <text fg={color()} attributes={TextAttributes.BOLD}>
                    {TOAST_GLYPHS[current.variant]}
                  </text>
                </box>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

export function createToastStore() {
  const [store, setStore] = createStore({ toasts: [] as ToastItem[] })
  const timeouts = new Map<number, NodeJS.Timeout>()
  let nextID = 0

  const dismiss = (id: number) => {
    const timeout = timeouts.get(id)
    if (timeout) clearTimeout(timeout)
    timeouts.delete(id)
    setStore("toasts", (items) => items.filter((item) => item.id !== id))
  }

  const toast = {
    show(options: ToastInput) {
      const variant = options.variant ?? "info"
      const item: ToastItem = {
        ...options,
        id: nextID++,
        variant,
        duration: options.duration ?? 4000,
        persistent: options.persistent ?? (variant === "error" && options.duration === undefined),
      }
      const next = [...store.toasts, item]
      for (const removed of next.slice(0, -3)) dismiss(removed.id)
      setStore("toasts", next.slice(-3))

      if (!item.persistent) {
        const timeout = setTimeout(() => dismiss(item.id), item.duration)
        timeout.unref()
        timeouts.set(item.id, timeout)
      }
      return item.id
    },
    error(err: unknown) {
      return toast.show({
        variant: "error",
        message: err instanceof Error ? err.message : "An unknown error has occurred",
      })
    },
    dismiss,
    get currentToast(): ToastItem | null {
      return store.toasts.at(-1) ?? null
    },
    get toasts(): readonly ToastItem[] {
      return store.toasts
    },
    dispose() {
      for (const timeout of timeouts.values()) clearTimeout(timeout)
      timeouts.clear()
    },
  }
  return toast
}

export type ToastContext = ReturnType<typeof createToastStore>

const ctx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps) {
  const value = createToastStore()
  onCleanup(value.dispose)
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}
