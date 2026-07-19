import type { TeamBoard, Todo } from "@oc2-ai/sdk/v2"
import { GaugeV2 } from "@oc2-ai/ui/v2/gauge-v2"
import { KeyHintV2 } from "@oc2-ai/ui/v2/key-hint-v2"
import { SectionHeadV2 } from "@oc2-ai/ui/v2/section-head-v2"
import { StatusGlyph } from "@oc2-ai/ui/v2/status-glyph"
import { For, Show, createEffect, createMemo, createResource, on, onCleanup, onMount } from "solid-js"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { useCommand } from "@/context/command"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useProviders } from "@/hooks/use-providers"
import { visibleTodos } from "./session-chrome-model"
import { projectSessionContext } from "./session-projection"

function useSessionContext(sessionID: () => string | undefined) {
  const sync = useSync()
  const providers = useProviders()
  const messages = createMemo(() => (sessionID() ? (sync.data.message[sessionID()!] ?? []) : []))
  return createMemo(() => getSessionContextMetrics(messages(), [...providers.all().values()]).context)
}

function ContextGauge(props: { sessionID?: string; actions?: boolean; kind?: "bar" | "text" }) {
  const command = useCommand()
  const context = useSessionContext(() => props.sessionID)
  const projection = createMemo(() => {
    const value = context()
    return value ? projectSessionContext(value.total, value.limit) : undefined
  })
  const action = () => projection()?.action

  return (
    <Show when={context()} fallback={<span class="text-[var(--v2-text-text-faint)]">○ usage unavailable</span>}>
      {(ctx) => (
        <div class="min-w-0 flex flex-col gap-1.5">
          <Show
            when={projection()?.percent !== undefined}
            fallback={
              <span class="truncate text-[var(--v2-text-text-muted)]">
                ctx {projection()!.tokensLabel} tokens · limit unavailable
              </span>
            }
          >
            <GaugeV2
              value={projection()!.percent!}
              max={100}
              kind={props.kind ?? "bar"}
              label={`Context ${projection()!.tokensLabel} of ${projection()!.limitLabel} tokens, ${projection()!.percent}%`}
            />
          </Show>
          <Show when={props.actions && action()}>
            {(next) => (
              <button
                type="button"
                class="self-start truncate rounded-[var(--v2-radius-chip)] text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-accent)] outline-none focus-visible:shadow-[var(--v2-shadow-focus)]"
                onClick={() => command.trigger(next() === "compact" ? "session.compact" : "session.fork")}
              >
                {next() === "compact" ? "▲ compact suggested" : "✕ fork or start a new session"}
              </button>
            )}
          </Show>
          <Show when={props.actions && projection()?.headroomLabel}>
            <span class="truncate text-[var(--v2-font-size-micro)] text-[var(--v2-text-text-faint)]">
              {projection()!.headroomLabel} token headroom · warns at 70%
            </span>
          </Show>
        </div>
      )}
    </Show>
  )
}

function todoGlyph(status: Todo["status"]) {
  if (status === "completed") return "done" as const
  if (status === "in_progress") return "running" as const
  if (status === "cancelled") return "failed" as const
  return "pending" as const
}

export function SessionDetailsPanel(props: {
  sessionID?: string
  todos: Todo[]
  hidden?: boolean
  overlay?: boolean
  onClose?: () => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const session = createMemo(() => (props.sessionID ? sync.session.get(props.sessionID) : undefined))
  const [teamData, { refetch }] = createResource(
    () => props.sessionID,
    async (viewer_session_id) =>
      (async () => {
        const team = await sdk.client.team.get({ viewer_session_id }, { throwOnError: false })
        if (team.error && team.response.status === 400) return { status: "none" } as const
        if (team.error) return { status: "error", error: team.error } as const
        if (!team.data || typeof team.data.id !== "string") return { status: "none" } as const
        const board = await sdk.client.team.board({ teamID: team.data.id, viewer_session_id }, { throwOnError: false })
        return board.error
          ? ({ status: "error", error: board.error } as const)
          : ({ status: "ready", value: board.data } as const)
      })().catch((error) => ({ status: "error", error }) as const),
  )
  onMount(() => {
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return
      void refetch()
    }
    const timer = window.setInterval(refreshVisible, 30_000)
    document.addEventListener("visibilitychange", refreshVisible)
    onCleanup(() => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", refreshVisible)
    })
  })
  createEffect(
    on(
      sdk.connection.status,
      (status, previous) => {
        if (status !== "connected" || (previous !== "reconnecting" && previous !== "disconnected")) return
        void refetch()
      },
      { defer: true },
    ),
  )
  const board = createMemo((): TeamBoard | undefined => {
    const result = teamData.latest
    return result?.status === "ready" ? result.value : undefined
  })
  const workers = createMemo(() => board()?.workers ?? [])
  const working = createMemo(() => workers().filter((item) => item.state === "working"))
  const done = createMemo(() => props.todos.filter((todo) => todo.status === "completed").length)
  const todo = createMemo(() => visibleTodos(props.todos))

  return (
    <Show when={!props.hidden && session()}>
      {(item) => (
        <>
          <Show when={props.overlay}>
            <button
              type="button"
              aria-label="Close session details"
              class="absolute inset-0 z-[var(--v2-z-scrim)] bg-[var(--v2-overlay-scrim-light)]"
              onClick={props.onClose}
            />
          </Show>
          <aside
            data-component="session-details-panel"
            role="complementary"
            aria-label="Session details"
            class="h-full shrink-0 flex-col overflow-y-auto border-l border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-base)] font-mono"
            classList={{
              "hidden min-[1100px]:flex": !props.overlay,
              "absolute inset-y-0 right-0 z-[var(--v2-z-dialog)] flex shadow-[var(--v2-shadow-dialog)]": props.overlay,
            }}
            style={{ width: "var(--v2-sidebar-width)" }}
          >
            <section role="region" aria-label="Session" class="px-[var(--v2-space-7)] py-[var(--v2-space-6)]">
              <SectionHeadV2 label="Session" aggregate="auto-saved" size="compact" />
              <div class="mt-2 line-clamp-2 text-[var(--v2-font-size-small)] font-bold text-[var(--v2-text-text-base)]">
                {item().title}
              </div>
              <div class="mt-1 flex min-w-0 items-center gap-2 text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                <span class="min-w-0 flex-1 truncate" title={item().id}>
                  {item().id}
                </span>
                <button
                  type="button"
                  class="shrink-0 rounded-[var(--v2-radius-chip)] text-[var(--v2-text-text-accent)] focus-visible:shadow-[var(--v2-shadow-focus)]"
                  onClick={() => void navigator.clipboard?.writeText(item().id)}
                >
                  copy
                </button>
              </div>
            </section>

            <section
              role="region"
              aria-label="Context"
              class="border-t border-[var(--v2-border-border-base)] px-[var(--v2-space-7)] py-[var(--v2-space-6)]"
            >
              <SectionHeadV2 label="Context" size="compact" />
              <div class="mt-2">
                <ContextGauge sessionID={props.sessionID} actions />
              </div>
            </section>

            <section
              role="region"
              aria-label="Team"
              class="border-t border-[var(--v2-border-border-base)] px-[var(--v2-space-7)] py-[var(--v2-space-6)]"
            >
              <SectionHeadV2 label="Team" aggregate={board()?.counts.workers ?? 0} size="compact" />
              <Show
                when={!teamData.loading}
                fallback={
                  <div class="mt-2 truncate text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                    ◐ loading team…
                  </div>
                }
              >
                <Show
                  when={teamData.latest?.status !== "error"}
                  fallback={<div class="mt-2 truncate text-[var(--v2-state-fg-danger)]">✕ team unavailable</div>}
                >
                  <Show
                    when={board()}
                    fallback={
                      <div class="mt-2 truncate text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                        ○ single agent
                      </div>
                    }
                  >
                    <Show
                      when={workers().length > 0}
                      fallback={
                        <div class="mt-2 truncate text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                          ○ no workers
                        </div>
                      }
                    >
                      <div class="mt-2 flex flex-col gap-1 text-[var(--v2-font-size-meta)]">
                        <div class="flex items-center gap-1.5 text-[var(--v2-state-fg-thinking)]">
                          <StatusGlyph name="running" /> <span class="min-w-0 flex-1 truncate">Working assignees</span>
                          <span>{working().length}</span>
                        </div>
                        <For each={working().slice(0, 3)}>
                          {(assignee) => (
                            <div class="ml-3 truncate border-l border-[var(--v2-border-border-base)] pl-2">
                              {assignee.name}
                            </div>
                          )}
                        </For>
                        <div class="flex items-center gap-1.5 text-[var(--v2-text-text-faint)]">
                          <StatusGlyph name="pending" /> <span class="min-w-0 flex-1 truncate">Dependency blocked</span>
                          <span>{board()!.counts.blocked}</span>
                        </div>
                        <div class="flex items-center gap-1.5 text-[var(--v2-text-text-faint)]">
                          <StatusGlyph name="pending" /> <span class="min-w-0 flex-1 truncate">Idle</span>
                          <span>{board()!.counts.idle}</span>
                        </div>
                        <div class="flex items-center gap-1.5 text-[var(--v2-state-fg-success)]">
                          <StatusGlyph name="done" /> <span class="min-w-0 flex-1 truncate">Completed</span>
                          <span>{board()!.counts.done}</span>
                        </div>
                        <Show when={board()!.counts.needs_you > 0}>
                          <div class="flex items-center gap-1.5 text-[var(--v2-state-fg-decision)]">
                            <StatusGlyph name="needs-you" /> <span class="min-w-0 flex-1 truncate">Waiting on you</span>
                            <span>{board()!.counts.needs_you}</span>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </Show>
                </Show>
              </Show>
            </section>

            <section
              role="region"
              aria-label="Todo"
              class="border-t border-[var(--v2-border-border-base)] px-[var(--v2-space-7)] py-[var(--v2-space-6)]"
            >
              <SectionHeadV2 label="Todo" aggregate={`${done()} / ${props.todos.length}`} size="compact" />
              <Show
                when={props.todos.length > 0}
                fallback={
                  <div class="mt-2 truncate text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                    ○ no tasks yet
                  </div>
                }
              >
                <div class="mt-2 flex flex-col gap-1">
                  <GaugeV2
                    value={done()}
                    max={props.todos.length}
                    label={`${done()} of ${props.todos.length} tasks done`}
                    variant="progress"
                  />
                  <For each={todo().items}>
                    {(entry) => (
                      <div
                        data-state={entry.status}
                        class="flex h-6 min-w-0 items-center gap-2 rounded-[var(--v2-radius-base)] px-1 text-[var(--v2-font-size-meta)] data-[state=in_progress]:bg-[var(--v2-state-bg-thinking)] data-[state=in_progress]:font-bold data-[state=in_progress]:text-[var(--v2-state-fg-thinking)]"
                      >
                        <StatusGlyph name={todoGlyph(entry.status)} />
                        <span
                          class="min-w-0 flex-1 truncate data-[done=true]:line-through"
                          data-done={entry.status === "completed" || entry.status === "cancelled" ? "true" : undefined}
                          title={entry.content}
                        >
                          {entry.content}
                        </span>
                      </div>
                    )}
                  </For>
                  <Show when={todo().overflow > 0}>
                    <div class="truncate text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                      + {todo().overflow} more
                    </div>
                  </Show>
                </div>
              </Show>
            </section>
          </aside>
        </>
      )}
    </Show>
  )
}

export function SessionStatusBar(props: { sessionID?: string; waiting: boolean; onDetailsToggle?: () => void }) {
  const sync = useSync()
  const command = useCommand()
  const session = createMemo(() => (props.sessionID ? sync.session.get(props.sessionID) : undefined))
  const context = useSessionContext(() => props.sessionID)
  const contextProjection = createMemo(() => {
    const value = context()
    return value ? projectSessionContext(value.total, value.limit) : undefined
  })
  const workers = createMemo(() =>
    props.sessionID
      ? sync.data.session.filter((item) => item.parentID === props.sessionID && sync.data.session_working(item.id))
          .length
      : 0,
  )

  return (
    <Show when={session()}>
      {(item) => (
        <div
          data-component="session-status-bar"
          role="status"
          aria-live="polite"
          class="h-7 shrink-0 flex items-center gap-2 overflow-hidden border-t border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-layer-01)] px-3 font-mono text-[length:var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]"
          aria-label={
            props.waiting
              ? `${item().agent ?? "agent"}, ${item().title}, waiting on you`
              : `${item().agent ?? "agent"}, ${item().title}, ${workers()} agents working, context ${contextProjection()?.percent ?? "unknown"} percent`
          }
        >
          <strong class="shrink-0 text-[var(--v2-text-text-muted)]">{item().agent ?? "agent"}</strong>
          <span aria-hidden="true">·</span>
          <span class="min-w-0 flex-1 truncate" title={item().title}>
            {item().title}
          </span>
          <Show
            when={!props.waiting}
            fallback={
              <span class="shrink-0 text-[var(--v2-state-fg-decision)]">
                <StatusGlyph name="needs-you" /> waiting on you
              </span>
            }
          >
            <Show when={workers() > 0}>
              <span class="shrink-0 text-[var(--v2-state-fg-thinking)]">
                <StatusGlyph name="running" /> {workers()} agents
              </span>
            </Show>
            <Show when={contextProjection()?.percent !== undefined}>
              <GaugeV2
                value={contextProjection()!.percent!}
                max={100}
                label={`ctx ${contextProjection()!.tokensLabel} ${contextProjection()!.percent}%`}
                kind="text"
              />
            </Show>
            <Show when={props.onDetailsToggle}>
              {(toggle) => (
                <button
                  type="button"
                  class="shrink-0 text-[var(--v2-text-text-muted)] min-[1100px]:hidden"
                  onClick={toggle()}
                >
                  details
                </button>
              )}
            </Show>
            <KeyHintV2 shortcut={command.keybind("command.palette") || "mod+shift+p"} label="palette" decorative />
          </Show>
        </div>
      )}
    </Show>
  )
}
