import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
  startTransition,
  For,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { makeEventListener } from "@solid-primitives/event-listener"

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  setClosing: (closing: boolean) => void
  returnFocus?: HTMLElement
}

export interface DialogShowOptions {
  dismissible?: boolean
}

const Context = createContext<ReturnType<typeof init>>()
const LayerContext = createContext<DialogShowOptions>({})

function returnFocusTarget() {
  if (typeof document === "undefined") return
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return

  let target = active
  let popup = active.closest<HTMLElement>('[role="menu"], [role="listbox"]')
  while (popup?.id) {
    const popupID = popup.id
    const control = Array.from(document.querySelectorAll<HTMLElement>("[aria-controls]")).find(
      (element) => element.getAttribute("aria-controls") === popupID,
    )
    if (!control) break
    target = control
    popup = control.closest<HTMLElement>('[role="menu"], [role="listbox"]')
  }
  return target
}

function init() {
  const [stack, setStack] = createSignal<Active[]>([])
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }

  onCleanup(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const close = (id?: string) => {
    const items = stack()
    const current = id ? items.find((item) => item.id === id) : items.at(-1)
    if (!current || lock.value) return
    lock.value = true
    current.onClose?.()
    current.setClosing(true)

    const closed = current.id
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    timer.current = setTimeout(() => {
      timer.current = undefined
      current.dispose()
      setStack((items) => items.filter((item) => item.id !== closed))
      lock.value = false
      if (current.returnFocus?.isConnected) current.returnFocus.focus()
    }, 100)
  }

  createEffect(() => {
    if (stack().length === 0) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      close()
      event.preventDefault()
      event.stopPropagation()
    }

    makeEventListener(window, "keydown", onKeyDown, { capture: true })
  })

  const mount = (
    element: DialogElement,
    owner: Owner,
    onClose: (() => void) | undefined,
    layer: number,
    options?: DialogShowOptions,
    returnFocus = returnFocusTarget(),
  ) => {
    const id = Math.random().toString(36).slice(2)
    const scrimZIndex = layer === 0 ? "var(--v2-z-scrim)" : `calc(var(--v2-z-dialog) + ${layer * 2 - 1})`
    const dialogZIndex = layer === 0 ? "var(--v2-z-dialog)" : `calc(var(--v2-z-dialog) + ${layer * 2})`
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        return (
          <Kobalte
            modal
            open={!closing()}
            onOpenChange={(open: boolean) => {
              if (open) return
              close(id)
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay
                data-component="dialog-overlay"
                style={{ "z-index": scrimZIndex }}
                onClick={() => {
                  if (options?.dismissible === false) return
                  close(id)
                }}
              />
              <div
                data-dialog-layer={layer}
                style={{
                  position: "fixed",
                  inset: "0",
                  "z-index": dialogZIndex,
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  "pointer-events": "none",
                }}
              >
                <LayerContext.Provider value={options ?? {}}>{element()}</LayerContext.Provider>
              </div>
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing) return

    const active: Active = {
      id,
      node,
      dispose,
      owner,
      onClose,
      setClosing,
      returnFocus,
    }
    setStack((items) => [...items, active])
  }

  const push = (
    element: DialogElement,
    owner: Owner,
    onClose?: () => void,
    options?: DialogShowOptions,
    returnFocus?: HTMLElement,
  ) => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    mount(element, owner, onClose, stack().length, options, returnFocus)
  }

  const show = (
    element: DialogElement,
    owner: Owner,
    onClose?: () => void,
    options?: DialogShowOptions,
    returnFocus?: HTMLElement,
  ) => {
    const target = stack()[0]?.returnFocus ?? returnFocus
    for (const item of stack()) item.dispose()
    setStack([])
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false
    mount(element, owner, onClose, 0, options, target)
  }

  return {
    stack,
    close,
    show,
    push,
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">
        <For each={ctx.stack()}>{(item) => item.node}</For>
      </div>
    </Context.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      return ctx.stack().at(-1)
    },
    show(element: DialogElement, onClose?: () => void, options?: DialogShowOptions) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      const returnFocus = returnFocusTarget()
      return startTransition(() => ctx.show(element, base, onClose, options, returnFocus))
    },
    push(element: DialogElement, onClose?: () => void, options?: DialogShowOptions) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      const returnFocus = returnFocusTarget()
      return startTransition(() => ctx.push(element, base, onClose, options, returnFocus))
    },
    close() {
      ctx.close()
    },
  }
}

export function useDialogLayerOptions() {
  return useContext(LayerContext)
}
