import { Show, createMemo, splitProps, type ComponentProps } from "solid-js"
import { StatusGlyph } from "./status-glyph"
import "./gauge-v2.css"

export interface GaugeV2Props extends Omit<ComponentProps<"div">, "role"> {
  value?: number
  max?: number
  label: string
  kind?: "bar" | "text"
  variant?: "budget" | "progress"
  loading?: boolean
}

export function gaugeVariant(percentage: number, variant: GaugeV2Props["variant"] = "budget") {
  if (variant === "progress" || percentage < 70) return "success"
  if (percentage < 90) return "warning"
  return "danger"
}

export function GaugeV2(props: GaugeV2Props) {
  const [local, rest] = splitProps(props, [
    "value",
    "max",
    "label",
    "kind",
    "variant",
    "loading",
    "class",
    "classList",
    "children",
  ])
  const max = createMemo(() => (local.max && local.max > 0 ? local.max : 100))
  const value = createMemo(() => Math.min(Math.max(local.value ?? 0, 0), max()))
  const percentage = createMemo(() => Math.round((value() / max()) * 100))
  const state = createMemo(() => gaugeVariant(percentage(), local.variant))
  const cells = createMemo(() => Math.round((percentage() / 100) * 8))

  return (
    <div
      {...rest}
      data-component="gauge-v2"
      data-variant={state()}
      data-size={local.kind ?? "bar"}
      data-loading={local.loading ? "true" : undefined}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <div
        data-slot="gauge-v2-progress"
        role="progressbar"
        aria-label={local.label}
        aria-valuemin="0"
        aria-valuemax={max()}
        aria-valuenow={local.loading ? undefined : value()}
        aria-valuetext={local.loading ? `${local.label} loading` : `${percentage()}%`}
        aria-busy={local.loading ? "true" : undefined}
      >
        <Show
          when={!local.loading}
          fallback={
            <span data-slot="gauge-v2-loading">
              <StatusGlyph name="running" /> loading…
            </span>
          }
        >
          <span data-slot="gauge-v2-label">{local.label}</span>
          <Show
            when={(local.kind ?? "bar") === "text"}
            fallback={
              <span data-slot="gauge-v2-track" aria-hidden="true">
                <span data-slot="gauge-v2-fill" style={{ width: `${percentage()}%` }} />
              </span>
            }
          >
            <span data-slot="gauge-v2-text" aria-hidden="true">
              <span data-slot="gauge-v2-text-filled">{"▰".repeat(cells())}</span>
              <span data-slot="gauge-v2-text-empty">{"▱".repeat(8 - cells())}</span>
            </span>
          </Show>
          <span data-slot="gauge-v2-value">{percentage()}%</span>
        </Show>
      </div>
      <Show when={local.children}>
        <div data-slot="gauge-v2-supplemental">{local.children}</div>
      </Show>
    </div>
  )
}
