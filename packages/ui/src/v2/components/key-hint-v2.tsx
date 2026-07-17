import { Show, splitProps, type ComponentProps, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import "./key-hint-v2.css"

export interface KeyHintV2Props
  extends Pick<
    ComponentProps<"span">,
    | "id"
    | "class"
    | "classList"
    | "style"
    | "title"
    | "aria-label"
    | "aria-hidden"
    | "aria-describedby"
    | "aria-keyshortcuts"
  > {
  shortcut: string
  label?: JSX.Element
  variant?: "single" | "combo" | "sequence"
  active?: boolean
  pressed?: boolean
  disabled?: boolean
  decorative?: boolean
  onClick?: ComponentProps<"button">["onClick"]
}

export function KeyHintV2(props: KeyHintV2Props) {
  const [local, rest] = splitProps(props, [
    "shortcut",
    "label",
    "variant",
    "active",
    "pressed",
    "disabled",
    "decorative",
    "onClick",
    "class",
    "classList",
  ])
  const content = () => (
    <>
      <span data-slot="key-hint-v2-key">{local.shortcut}</span>
      <Show when={local.label}>
        <span data-slot="key-hint-v2-label">{local.label}</span>
      </Show>
    </>
  )
  return (
    <Dynamic
      {...rest}
      component={local.onClick ? "button" : "span"}
      data-component="key-hint-v2"
      data-variant={local.variant ?? "single"}
      data-size="normal"
      data-state={local.disabled ? "disabled" : local.pressed ? "pressed" : local.active ? "active" : undefined}
      type={local.onClick ? "button" : undefined}
      disabled={local.onClick ? local.disabled : undefined}
      aria-hidden={!local.onClick && local.decorative ? "true" : rest["aria-hidden"]}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      onClick={local.onClick}
    >
      {content()}
    </Dynamic>
  )
}
