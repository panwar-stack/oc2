import { Show, splitProps, type ComponentProps, type JSX } from "solid-js"
import { StatusGlyph } from "./status-glyph"
import "./section-head-v2.css"

type SectionHeadV2BaseProps = Pick<
  ComponentProps<"div">,
  "id" | "class" | "classList" | "style" | "title" | "aria-label" | "aria-describedby" | "aria-controls"
> & {
  label: JSX.Element
  aggregate?: JSX.Element
  size?: "compact" | "normal"
}

export type SectionHeadV2Props = SectionHeadV2BaseProps &
  ({ expanded: boolean; onClick: ComponentProps<"button">["onClick"] } | { expanded?: never; onClick?: never })

export function SectionHeadV2(props: SectionHeadV2Props) {
  const [local, rest] = splitProps(props, [
    "label",
    "aggregate",
    "size",
    "expanded",
    "onClick",
    "class",
    "classList",
    "aria-label",
    "aria-describedby",
    "aria-controls",
  ])
  const label = () => (
    <span data-slot="section-head-v2-label">
      <Show when={local.onClick}>
        <StatusGlyph name={local.expanded ? "expanded" : "collapsed"} size="small" />
      </Show>
      <span data-slot="section-head-v2-label-text">{local.label}</span>
    </span>
  )
  return (
    <div
      {...rest}
      data-component="section-head-v2"
      data-variant={local.onClick ? "collapsible" : "static"}
      data-size={local.size ?? "normal"}
      aria-label={local.onClick ? undefined : local["aria-label"]}
      aria-describedby={local.onClick ? undefined : local["aria-describedby"]}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Show when={local.onClick} fallback={label()}>
        {(onClick) => (
          <button
            type="button"
            data-slot="section-head-v2-trigger"
            aria-label={local["aria-label"]}
            aria-describedby={local["aria-describedby"]}
            aria-controls={local["aria-controls"]}
            aria-expanded={local.expanded}
            onClick={onClick()}
          >
            {label()}
          </button>
        )}
      </Show>
      <Show when={local.aggregate}>
        <span data-slot="section-head-v2-aggregate" role="status" aria-live="polite">
          {local.aggregate}
        </span>
      </Show>
    </div>
  )
}
