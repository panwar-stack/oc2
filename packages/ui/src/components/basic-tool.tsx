import { createEffect, createMemo, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { animate, type AnimationPlaybackControls } from "motion"
import { useI18n } from "../context/i18n"
import { createStore } from "solid-js/store"
import { Collapsible } from "./collapsible"
import type { IconProps } from "./icon"
import { TextShimmer } from "./text-shimmer"
import { StatusGlyph } from "../v2/components/status-glyph"
import { isDeniedToolError, toolDetails, toolErrorSummary, toolState, toolSummary } from "./tool-summary"

export type TriggerTitle = {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  args?: string[]
  argsClass?: string
  action?: JSX.Element
}

const isTriggerTitle = (val: any): val is TriggerTitle => {
  return (
    typeof val === "object" && val !== null && "title" in val && (typeof Node === "undefined" || !(val instanceof Node))
  )
}

export interface BasicToolProps {
  icon: IconProps["name"]
  trigger: TriggerTitle | JSX.Element
  children?: JSX.Element
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  forceOpen?: boolean
  defer?: boolean
  locked?: boolean
  animated?: boolean
  onSubtitleClick?: () => void
  onTriggerClick?: JSX.EventHandlerUnion<HTMLElement, MouseEvent>
  triggerHref?: string
  clickable?: boolean
  redesigned?: boolean
  tool?: string
  name?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  duration?: string
  error?: string
}

const SPRING = { type: "spring" as const, visualDuration: 0.35, bounce: 0 }
const deferredMounts: Array<{ active: boolean; fn: () => void }> = []
let deferredFrame: number | undefined

function flushDeferredMounts() {
  while (deferredMounts.length > 0) {
    // Timeline tools are mounted top-to-bottom, but the viewport starts at the latest turn.
    // Pop from the end so heavy default-open bodies near the bottom become interactive first.
    const item = deferredMounts.pop()!
    if (item.active) {
      deferredFrame = deferredMounts.length > 0 ? requestAnimationFrame(flushDeferredMounts) : undefined
      item.fn()
      return
    }
  }
  deferredFrame = undefined
}

function scheduleDeferredFlush() {
  if (deferredFrame !== undefined) return
  deferredFrame = requestAnimationFrame(() => {
    deferredFrame = requestAnimationFrame(flushDeferredMounts)
  })
}

function scheduleDeferredMount(fn: () => void) {
  const item = { active: true, fn }
  deferredMounts.push(item)
  scheduleDeferredFlush()
  return () => {
    item.active = false
  }
}

function scheduleFrameMount(fn: () => void) {
  const frame = requestAnimationFrame(fn)
  return () => cancelAnimationFrame(frame)
}

export function BasicTool(props: BasicToolProps) {
  const [state, setState] = createStore({
    open: props.defaultOpen ?? false,
    ready: !props.defer && (props.defaultOpen ?? false),
  })
  const open = () => props.open ?? state.open
  const ready = () => state.ready
  const pending = () => props.status === "pending" || props.status === "running"
  const denied = createMemo(() => isDeniedToolError(props.error))
  const status = createMemo(() => toolState(props.status, denied()))
  const details = createMemo(() =>
    toolDetails({ tool: props.tool ?? "", input: props.input, metadata: props.metadata }),
  )
  const summary = createMemo(() =>
    toolSummary({ tool: props.tool ?? "", input: props.input, metadata: props.metadata }),
  )
  const name = () => {
    if (props.name) return props.name
    if (isTriggerTitle(props.trigger)) return props.trigger.title
    return props.tool ?? "Tool"
  }
  const hasChildren = () =>
    props.redesigned
      ? Boolean(props.error || details().length || (props.defer ? "children" in props : props.children))
      : props.defer
        ? "children" in props
        : props.children
  const shortcutEnabled = () =>
    Boolean(props.redesigned && hasChildren() && !props.hideDetails && !props.locked && !pending())

  let cancelReady: (() => void) | undefined

  const cancel = () => {
    cancelReady?.()
    cancelReady = undefined
  }

  const scheduleReady = (initial = false) => {
    cancel()
    cancelReady = (initial ? scheduleDeferredMount : scheduleFrameMount)(() => {
      cancelReady = undefined
      if (!open()) return
      setState("ready", true)
    })
  }

  onCleanup(cancel)

  onMount(() => {
    if (props.defer && open()) scheduleReady(true)
  })

  const setOpen = (value: boolean) => {
    if (props.open === undefined) setState("open", value)
    props.onOpenChange?.(value)
  }

  createEffect(() => {
    if (!props.forceOpen) return
    if (open()) return
    setOpen(true)
  })

  createEffect(
    on(
      open,
      (value) => {
        if (!props.defer) return
        if (!value) {
          cancel()
          setState("ready", false)
          return
        }

        scheduleReady()
      },
      { defer: true },
    ),
  )

  // Animated height for collapsible open/close
  let contentRef: HTMLDivElement | undefined
  let heightAnim: AnimationPlaybackControls | undefined
  const initialOpen = open()

  createEffect(
    on(
      open,
      (isOpen) => {
        if (!props.animated || !contentRef) return
        heightAnim?.stop()
        if (isOpen) {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "auto" }, SPRING)
          void heightAnim.finished.then(() => {
            if (!contentRef || !open()) return
            contentRef.style.overflow = "visible"
            contentRef.style.height = "auto"
          })
        } else {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "0px" }, SPRING)
        }
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    heightAnim?.stop()
  })

  const handleOpenChange = (value: boolean) => {
    if (pending()) return
    if (props.locked && !value) return
    setOpen(value)
  }
  const handleShortcut = (event: KeyboardEvent) => {
    if (!shortcutEnabled() || !event.ctrlKey || event.key.toLowerCase() !== "e") return
    event.preventDefault()
    event.stopPropagation()
    handleOpenChange(!open())
  }

  const trigger = () => (
    <div
      data-component="tool-trigger"
      data-variant={props.redesigned ? "v2" : "legacy"}
      data-status={status()?.status}
      data-clickable={props.clickable ? "true" : undefined}
      data-hide-details={props.hideDetails ? "true" : undefined}
    >
      <Show
        when={props.redesigned}
        fallback={
          <div data-slot="basic-tool-tool-trigger-content">
            <div data-slot="basic-tool-tool-info">
              <Switch>
                <Match when={isTriggerTitle(props.trigger) && props.trigger}>
                  {(title) => (
                    <div data-slot="basic-tool-tool-info-structured">
                      <div data-slot="basic-tool-tool-info-main">
                        <span
                          data-slot="basic-tool-tool-title"
                          classList={{
                            [title().titleClass ?? ""]: !!title().titleClass,
                          }}
                        >
                          <TextShimmer text={title().title} active={pending()} />
                        </span>
                        <Show when={!pending()}>
                          <Show when={title().subtitle}>
                            <span
                              data-slot="basic-tool-tool-subtitle"
                              classList={{
                                [title().subtitleClass ?? ""]: !!title().subtitleClass,
                                clickable: !!props.onSubtitleClick,
                              }}
                              onClick={(e) => {
                                if (props.onSubtitleClick) {
                                  e.stopPropagation()
                                  props.onSubtitleClick()
                                }
                              }}
                            >
                              {title().subtitle}
                            </span>
                          </Show>
                          <Show when={title().args?.length}>
                            <For each={title().args}>
                              {(arg) => (
                                <span
                                  data-slot="basic-tool-tool-arg"
                                  classList={{
                                    [title().argsClass ?? ""]: !!title().argsClass,
                                  }}
                                >
                                  {arg}
                                </span>
                              )}
                            </For>
                          </Show>
                        </Show>
                      </div>
                      <Show when={!pending() && title().action}>
                        <span data-slot="basic-tool-tool-action">{title().action}</span>
                      </Show>
                    </div>
                  )}
                </Match>
                <Match when={true}>{props.trigger as JSX.Element}</Match>
              </Switch>
            </div>
          </div>
        }
      >
        <div data-component="tool-call-row" data-denied={denied() ? "true" : undefined}>
          <Show when={status()} fallback={<StatusGlyph name="tool-group" label="Tool" />}>
            {(value) => <StatusGlyph name={value().glyph} label={value().label} />}
          </Show>
          <span data-slot="tool-call-row-name">{name()}</span>
          <Show when={summary()}>{(value) => <span data-slot="tool-call-row-summary">{value()}</span>}</Show>
          <Show when={props.duration}>
            <span data-slot="tool-call-row-duration">{props.duration}</span>
          </Show>
          <Show when={props.error}>
            <span data-slot="tool-call-row-error-summary">↳ {toolErrorSummary(props.error)}</span>
          </Show>
        </div>
      </Show>
      <Show when={hasChildren() && !props.hideDetails && !props.locked && !pending()}>
        <Collapsible.Arrow />
      </Show>
    </div>
  )

  const content = () => (
    <>
      <Show when={props.redesigned && (details().length > 0 || props.error)}>
        <div data-component="tool-call-detail">
          <For each={details()}>
            {(item) => (
              <div data-slot="tool-call-detail-pair">
                <span data-slot="tool-call-detail-key">{item.key}:</span>
                <span data-slot="tool-call-detail-value">{item.value}</span>
              </div>
            )}
          </For>
          <Show when={props.error}>
            {(error) => (
              <div data-slot="tool-call-detail-error" role="alert">
                ↳ {error()}
              </div>
            )}
          </Show>
        </div>
      </Show>
      {props.children}
    </>
  )

  return (
    <Collapsible open={open()} onOpenChange={handleOpenChange} class="tool-collapsible">
      <Show
        when={props.triggerHref}
        fallback={
          <Collapsible.Trigger
            data-hide-details={props.hideDetails ? "true" : undefined}
            onClick={props.onTriggerClick}
            aria-keyshortcuts={shortcutEnabled() ? "Control+E" : undefined}
            onKeyDown={handleShortcut}
          >
            {trigger()}
          </Collapsible.Trigger>
        }
      >
        {(href) => (
          <Collapsible.Trigger
            as="a"
            href={href()}
            data-hide-details={props.hideDetails ? "true" : undefined}
            onClick={props.onTriggerClick}
            aria-keyshortcuts={shortcutEnabled() ? "Control+E" : undefined}
            onKeyDown={handleShortcut}
          >
            {trigger()}
          </Collapsible.Trigger>
        )}
      </Show>
      <Show when={props.animated && hasChildren() && !props.hideDetails}>
        <div
          ref={contentRef}
          data-slot="collapsible-content"
          data-animated
          style={{
            height: initialOpen ? "auto" : "0px",
            overflow: initialOpen ? "visible" : "hidden",
          }}
        >
          <Show when={!props.defer || ready()}>{content()}</Show>
        </div>
      </Show>
      <Show when={!props.animated && hasChildren() && !props.hideDetails}>
        <Collapsible.Content>
          <Show when={!props.defer || ready()}>{content()}</Show>
        </Collapsible.Content>
      </Show>
    </Collapsible>
  )
}

function label(input: Record<string, unknown> | undefined) {
  const keys = ["description", "query", "url", "filePath", "path", "pattern", "name"]
  return keys.map((key) => input?.[key]).find((value): value is string => typeof value === "string" && value.length > 0)
}

function args(input: Record<string, unknown> | undefined) {
  if (!input) return []
  const skip = new Set(["description", "query", "url", "filePath", "path", "pattern", "name"])
  return Object.entries(input)
    .filter(([key]) => !skip.has(key))
    .flatMap(([key, value]) => {
      if (typeof value === "string") return [`${key}=${value}`]
      if (typeof value === "number") return [`${key}=${value}`]
      if (typeof value === "boolean") return [`${key}=${value}`]
      return []
    })
    .slice(0, 3)
}

export function GenericTool(props: {
  tool: string
  status?: string
  name?: string
  metadata?: Record<string, unknown>
  duration?: string
  error?: string
  redesigned?: boolean
  hideDetails?: boolean
  input?: Record<string, unknown>
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const i18n = useI18n()

  return (
    <BasicTool
      icon="mcp"
      tool={props.tool}
      name={props.name ?? i18n.t("ui.basicTool.called", { tool: props.tool })}
      status={props.status}
      input={props.input}
      metadata={props.metadata}
      duration={props.duration}
      error={props.error}
      redesigned={props.redesigned}
      trigger={{
        title: i18n.t("ui.basicTool.called", { tool: props.tool }),
        subtitle: label(props.input),
        args: args(props.input),
      }}
      hideDetails={props.hideDetails}
      defaultOpen={props.defaultOpen}
      open={props.open}
      onOpenChange={props.onOpenChange}
    />
  )
}
