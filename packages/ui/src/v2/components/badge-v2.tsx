import { type ComponentProps, splitProps } from "solid-js"
import "./badge-v2.css"

export type BadgeV2Variant = "neutral" | "blue" | "amber" | "teal" | "purple" | "green" | "red"

export interface BadgeV2Props extends ComponentProps<"span"> {
  variant?: BadgeV2Variant
  size?: "small" | "normal"
}

export function BadgeV2(props: BadgeV2Props) {
  const [local, rest] = splitProps(props, ["variant", "size", "class", "classList", "children"])
  return (
    <span
      {...rest}
      data-component="badge-v2"
      data-variant={local.variant ?? "neutral"}
      data-size={local.size ?? "normal"}
      role={rest.role ?? "status"}
      aria-live={rest["aria-live"] ?? "polite"}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      {local.children}
    </span>
  )
}

export interface TagProps extends ComponentProps<"span"> {}

export function Tag(props: TagProps) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <span
      {...rest}
      data-component="tag"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </span>
  )
}
