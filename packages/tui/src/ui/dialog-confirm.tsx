import { TextAttributes } from "@opentui/core"
import { selectedForeground, useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { Locale } from "../util/locale"
import { useBindings } from "../keymap"

export type DialogConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
  label?: string
  destructive?: boolean
  defaultOption?: "confirm" | "cancel"
}

export type DialogConfirmResult = boolean | undefined

export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: props.defaultOption ?? ("confirm" as "confirm" | "cancel"),
  })

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Confirm dialog selection",
        group: "Dialog",
        cmd: () => {
          if (store.active === "confirm") props.onConfirm?.()
          if (store.active === "cancel") props.onCancel?.()
          dialog.clear()
        },
      },
      {
        key: "left",
        desc: "Previous dialog option",
        group: "Dialog",
        cmd: () => {
          setStore("active", store.active === "confirm" ? "cancel" : "confirm")
        },
      },
      {
        key: "right",
        desc: "Next dialog option",
        group: "Dialog",
        cmd: () => {
          setStore("active", store.active === "confirm" ? "cancel" : "confirm")
        },
      },
    ],
  }))
  const background = (key: "confirm" | "cancel") =>
    key === "confirm" && props.destructive ? theme.error : theme.primary
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.destructive ? "✕ " : ""}
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{props.message}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <For each={["cancel", "confirm"] as const}>
          {(key) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={key === store.active ? background(key) : undefined}
              onMouseUp={() => {
                if (key === "confirm") props.onConfirm?.()
                if (key === "cancel") props.onCancel?.()
                dialog.clear()
              }}
            >
              <text fg={key === store.active ? selectedForeground(theme, background(key)) : theme.textMuted}>
                {Locale.titlecase(key === "cancel" ? (props.label ?? key) : key)}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

DialogConfirm.show = (
  dialog: DialogContext,
  title: string,
  message: string,
  label?: string,
  options?: { destructive?: boolean; defaultOption?: "confirm" | "cancel" },
) => {
  return new Promise<DialogConfirmResult>((resolve) => {
    dialog.replace(
      () => (
        <DialogConfirm
          title={title}
          message={message}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
          label={label}
          destructive={options?.destructive}
          defaultOption={options?.defaultOption}
        />
      ),
      () => resolve(undefined),
      { dismissible: options?.destructive !== true },
    )
  })
}
