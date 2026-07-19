import type { TeamBoard, TeamBoardTask, TeamBoardWorker, TeamInfo } from "@oc2-ai/sdk/v2"
import { ButtonV2 } from "@oc2-ai/ui/v2/button-v2"
import { KeyHintV2 } from "@oc2-ai/ui/v2/key-hint-v2"
import { StateBlockV2 } from "@oc2-ai/ui/v2/state-block-v2"
import { StatusGlyph } from "@oc2-ai/ui/v2/status-glyph"
import { For, Match, Show, Switch, createEffect, createMemo, createResource, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { acceptBoardSnapshot, moveBoardFocus, orderBoardItems, visibleBoardFocusIDs } from "./team-board-model"
import { stableAgentColor } from "./session-chrome-model"
import "./team-board.css"

const groups = [
  { id: "needs_you", label: "Waiting on you", glyph: "needs-you" },
  { id: "errored", label: "Errored", glyph: "failed" },
  { id: "working", label: "Working", glyph: "running" },
  { id: "blocked", label: "Dependency blocked", glyph: "pending" },
  { id: "idle", label: "Idle", glyph: "pending" },
  { id: "completed", label: "Completed", glyph: "done" },
] as const

const workerGlyph = (state: TeamBoardWorker["state"]) =>
  groups.find((group) => group.id === state)?.glyph ?? ("pending" as const)

const taskGlyph = (status: TeamBoardTask["status"]) => {
  if (status === "in_progress") return "running" as const
  if (status === "completed") return "done" as const
  if (status === "cancelled") return "failed" as const
  return "pending" as const
}

const elapsed = (value: number | null) => {
  if (value === null) return
  const seconds = Math.max(0, Math.floor(value / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

export function TeamBoardView(props: { sessionID: string; mode: "board" | "tasks"; onExit: () => void }) {
  const sdk = useSDK()
  const [view, setView] = createStore({
    focus: 0,
    completedOpen: false,
    detail: undefined as string | undefined,
    teamID: undefined as string | undefined,
    history: [] as TeamInfo[],
    snapshot: undefined as { revision: number; generation: number; value: TeamBoard } | undefined,
    failure: undefined as unknown,
  })
  let generation = 0
  let boardRoot: HTMLDivElement | undefined

  const [discovery, { refetch: refetchDiscovery }] = createResource(
    () => [props.sessionID, sdk.directory] as const,
    async ([viewer_session_id]) =>
      Promise.all([
        sdk.client.team.get({ viewer_session_id }, { throwOnError: false }),
        sdk.client.team.history({ viewer_session_id }, { throwOnError: false }),
      ])
        .then(([current, history]) => {
          const teams = !history.error && Array.isArray(history.data) ? history.data : []
          if (!current.error && current.data && typeof current.data.id === "string") {
            return { status: "ready", teams, teamID: current.data.id } as const
          }
          if (current.error && current.response.status !== 400) {
            return { status: "error", error: current.error } as const
          }
          if (history.error) return { status: "error", error: history.error } as const
          return { status: "ready", teams, teamID: teams[0]?.id } as const
        })
        .catch((error) => ({ status: "error", error }) as const),
  )

  createEffect(() => {
    const result = discovery.latest
    if (!result) return
    if (result.status === "error") {
      setView("failure", result.error)
      return
    }
    setView({
      history: result.teams,
      teamID: view.teamID && result.teams.some((team) => team.id === view.teamID) ? view.teamID : result.teamID,
      failure: undefined,
    })
  })

  const [load, { refetch }] = createResource(
    () => (view.teamID ? ([view.teamID, props.sessionID, sdk.directory] as const) : undefined),
    async ([teamID, viewer_session_id]) => {
      const request = ++generation
      return sdk.client.team
        .board({ teamID, viewer_session_id }, { throwOnError: false })
        .then((response) =>
          response.error
            ? ({ status: "error", error: response.error } as const)
            : ({ status: "ready", value: response.data, generation: request } as const),
        )
        .catch((error) => ({ status: "error", error }) as const)
    },
  )

  createEffect(() => {
    const result = load.latest
    if (!result) return
    if (result.status === "error") {
      setView("failure", result.error)
      return
    }
    setView({
      snapshot: acceptBoardSnapshot(view.snapshot, {
        revision: result.value.revision,
        generation: result.generation,
        value: result.value,
      }),
      failure: undefined,
    })
  })

  createEffect(
    on(
      () => [props.sessionID, view.teamID] as const,
      () => setView({ snapshot: undefined, detail: undefined, focus: 0, completedOpen: false }),
      { defer: true },
    ),
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
        void refetchDiscovery()
        void refetch()
      },
      { defer: true },
    ),
  )

  const board = createMemo(() => view.snapshot?.value)
  const workers = createMemo(() =>
    orderBoardItems(
      board()?.workers ?? [],
      (worker) => worker.state,
      (worker) => worker.member_id,
    ),
  )
  const grouped = createMemo(
    () =>
      Object.fromEntries(
        groups.map((group) => [group.id, workers().filter((worker) => worker.state === group.id)]),
      ) as Record<TeamBoardWorker["state"], TeamBoardWorker[]>,
  )
  const focusIDs = createMemo(() =>
    visibleBoardFocusIDs(
      groups.map((group) => ({
        collapsed: group.id === "completed" && !view.completedOpen,
        items: grouped()[group.id].map((worker) => ({ id: worker.member_id })),
      })),
    ),
  )
  const detail = createMemo(() => workers().find((worker) => worker.member_id === view.detail))
  const task = (id: string) => board()?.tasks.find((item) => item.id === id)
  const worker = (id: string) => board()?.workers.find((item) => item.member_id === id)
  const dependency = (id: string) => task(id)?.description ?? worker(id)?.name ?? id
  const current = (item: TeamBoardWorker) =>
    item.display_summary ??
    (item.current_work?.id ? (task(item.current_work.id)?.description ?? item.current_work.id) : undefined)
  const assigned = (item: TeamBoardWorker) => board()?.tasks.filter((task) => task.assignee === item.member_id) ?? []
  const focusCard = (index: number) => {
    setView("focus", index)
    queueMicrotask(() => boardRoot?.querySelector<HTMLElement>(`[data-board-card='${index}']`)?.focus())
  }
  const handleCardKeyDown = (event: KeyboardEvent, index: number, item: TeamBoardWorker) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      setView("detail", item.member_id)
      return
    }
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "ArrowUp" &&
      event.key !== "ArrowDown" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return
    event.preventDefault()
    focusCard(
      moveBoardFocus({
        current: index,
        count: focusIDs().length,
        columns: window.innerWidth >= 1100 ? 3 : window.innerWidth >= 760 ? 2 : 1,
        key: event.key,
      }),
    )
  }

  return (
    <div
      ref={boardRoot}
      class="size-full overflow-y-auto bg-[var(--v2-background-bg-base)] px-4 py-4 sm:px-6 flex flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        props.onExit()
      }}
    >
      <div class="mx-auto mb-3 flex w-full max-w-[1100px] items-center gap-2">
        <ButtonV2 size="small" variant="ghost-muted" onClick={props.onExit}>
          Back
        </ButtonV2>
        <Show when={view.history.length > 1}>
          <select
            aria-label="Team history"
            class="min-w-0 rounded-[var(--v2-radius-option)] border border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-layer-01)] px-2 py-1 text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-base)]"
            value={view.teamID}
            onChange={(event) => setView("teamID", event.currentTarget.value)}
          >
            <For each={view.history}>{(team) => <option value={team.id}>{team.name}</option>}</For>
          </select>
        </Show>
      </div>
      <Show when={sdk.connection.status() !== "connected"}>
        <div
          role="status"
          aria-live="polite"
          class="mx-auto mb-3 w-full max-w-[1100px] rounded-[var(--v2-radius-card)] border border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-layer-02)] px-3 py-2 font-mono text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-muted)]"
        >
          <StatusGlyph name={sdk.connection.status() === "reconnecting" ? "running" : "pending"} />{" "}
          {sdk.connection.status() === "connecting"
            ? "Connecting to team updates…"
            : sdk.connection.status() === "reconnecting"
              ? "Reconnecting · showing the last team update"
              : "Disconnected · showing the last team update"}
        </div>
      </Show>
      <Show when={view.failure && board()}>
        <div
          role="status"
          class="mx-auto mb-3 w-full max-w-[1100px] rounded-[var(--v2-radius-card)] border border-[var(--v2-state-border-danger)] bg-[var(--v2-state-bg-danger)] px-3 py-2 font-mono text-[var(--v2-font-size-meta)] text-[var(--v2-state-fg-danger)]"
        >
          <StatusGlyph name="failed" /> Refresh failed · showing the last team update
        </div>
      </Show>
      <Switch>
        <Match when={(discovery.loading || load.loading) && !board()}>
          <StateBlockV2 variant="loading" title="Loading team board…" scale="full" />
        </Match>
        <Match when={view.failure && !board()}>
          <StateBlockV2
            variant="error"
            title="Team board unavailable"
            description="The latest team data could not be loaded."
            scale="full"
            action={
              <ButtonV2
                size="small"
                onClick={() => {
                  void refetchDiscovery()
                  void refetch()
                }}
              >
                Retry
              </ButtonV2>
            }
            hint={<KeyHintV2 shortcut="enter" label="retry" />}
          />
        </Match>
        <Match when={!view.teamID && !discovery.loading}>
          <StateBlockV2
            variant="empty"
            title="No team for this session"
            description="This session runs a single agent."
            scale="full"
          />
        </Match>
        <Match when={board()}>
          {(result) => (
            <div class="mx-auto flex w-full max-w-[1100px] flex-col gap-5">
              <header class="min-w-0">
                <h2 class="truncate text-[var(--v2-font-size-title)] font-bold text-[var(--v2-text-text-base)]">
                  Team · {result().team.name}
                </h2>
                <div class="mt-1 line-clamp-2 text-[var(--v2-font-size-small)] text-[var(--v2-text-text-muted)]">
                  {result().team.goal}
                </div>
                <div
                  role="status"
                  aria-live="polite"
                  class="mt-1 truncate font-mono text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]"
                >
                  {result().counts.workers} workers · {result().counts.working} working · {result().counts.blocked}{" "}
                  blocked · {result().counts.idle} idle · {result().counts.done} done · tasks {result().counts.claimed}/
                  {result().counts.total_tasks} · revision {result().revision}
                </div>
              </header>

              <Show
                when={result().tasks.length > 0 || result().workers.length > 0}
                fallback={
                  <StateBlockV2
                    variant="empty"
                    title="No team activity yet"
                    description="The team has no workers or tasks."
                  />
                }
              >
                <Show
                  when={props.mode === "board"}
                  fallback={
                    <div class="flex flex-col gap-2" role="list" aria-label="Team tasks">
                      <For each={result().tasks}>
                        {(item) => (
                          <article
                            role="listitem"
                            class="min-w-0 rounded-[var(--v2-radius-card)] border border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-layer-02)] px-3 py-2"
                          >
                            <div class="flex min-w-0 items-center gap-2">
                              <StatusGlyph name={taskGlyph(item.status)} />
                              <strong class="min-w-0 flex-1 truncate">{item.description}</strong>
                              <span class="shrink-0 text-[var(--v2-text-text-faint)]">
                                {item.assignee ? (worker(item.assignee)?.name ?? item.assignee) : "unassigned"}
                              </span>
                            </div>
                            <Show when={item.dependency_ids.length > 0}>
                              <div class="mt-1 truncate text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                                waits on {item.dependency_ids.map(dependency).join(" · ")}
                              </div>
                            </Show>
                          </article>
                        )}
                      </For>
                    </div>
                  }
                >
                  <For each={groups}>
                    {(group) => (
                      <Show when={grouped()[group.id].length > 0}>
                        <section aria-labelledby={`team-${group.id}`} class="flex flex-col gap-2">
                          <h3
                            id={`team-${group.id}`}
                            class="font-mono text-[var(--v2-font-size-label)] font-bold uppercase tracking-[0.08em] text-[var(--v2-text-text-muted)]"
                          >
                            <Show
                              when={group.id === "completed"}
                              fallback={
                                <span>
                                  <StatusGlyph name={group.glyph} /> {group.label} · {grouped()[group.id].length}
                                </span>
                              }
                            >
                              <button
                                type="button"
                                aria-expanded={view.completedOpen}
                                aria-controls="team-completed-cards"
                                class="rounded-[var(--v2-radius-chip)] outline-none focus-visible:shadow-[var(--v2-shadow-focus)]"
                                onClick={() => {
                                  setView("completedOpen", !view.completedOpen)
                                  setView("focus", 0)
                                }}
                              >
                                <StatusGlyph name={group.glyph} /> {group.label} · {grouped()[group.id].length} ·{" "}
                                {view.completedOpen ? "collapse" : "expand"}
                              </button>
                            </Show>
                          </h3>
                          <Show when={group.id !== "completed" || view.completedOpen}>
                            <div
                              id={group.id === "completed" ? "team-completed-cards" : undefined}
                              data-component="team-board-grid"
                            >
                              <For each={grouped()[group.id]}>
                                {(item) => {
                                  const index = () => focusIDs().indexOf(item.member_id)
                                  return (
                                    <article
                                      role="button"
                                      data-board-card={index()}
                                      tabIndex={view.focus === index() ? 0 : -1}
                                      aria-label={`${item.name}, ${group.label}${current(item) ? `, ${current(item)}` : ""}`}
                                      class="min-w-0 rounded-[var(--v2-radius-card)] border bg-[var(--v2-background-bg-layer-02)] px-3 py-3 outline-none focus-visible:shadow-[var(--v2-shadow-focus)]"
                                      style={{
                                        "border-color":
                                          group.id === "working"
                                            ? "var(--v2-state-border-thinking)"
                                            : `var(--v2-agent-${stableAgentColor(item.member_id) + 1})`,
                                      }}
                                      onFocus={() => setView("focus", index())}
                                      onClick={() => setView("detail", item.member_id)}
                                      onKeyDown={(event) => handleCardKeyDown(event, index(), item)}
                                    >
                                      <div class="flex min-w-0 items-center gap-2">
                                        <StatusGlyph name={group.glyph} />
                                        <strong class="min-w-0 flex-1 truncate" title={item.name}>
                                          {item.name}
                                        </strong>
                                        <Show when={elapsed(item.elapsed_ms)}>
                                          <span class="shrink-0 font-mono text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                                            {elapsed(item.elapsed_ms)}
                                          </span>
                                        </Show>
                                      </div>
                                      <div class="mt-1 truncate font-mono text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                                        {item.agent_type} · {item.work_mode} · {item.mutability.replaceAll("_", " ")}
                                      </div>
                                      <div class="mt-2 line-clamp-2 min-h-10 text-[var(--v2-font-size-small)] text-[var(--v2-text-text-muted)]">
                                        {current(item) ?? "No active work summary"}
                                      </div>
                                      <Show when={item.dependency_ids.length > 0}>
                                        <div class="mt-2 truncate text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                                          waits on {item.dependency_ids.map(dependency).join(" · ")}
                                        </div>
                                      </Show>
                                      <div class="mt-2 flex min-w-0 gap-2 font-mono text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                                        <Show when={item.attention.permissions + item.attention.questions > 0}>
                                          <span class="text-[var(--v2-state-fg-decision)]">
                                            <StatusGlyph name="needs-you" />{" "}
                                            {item.attention.permissions + item.attention.questions} requests
                                          </span>
                                        </Show>
                                        <Show when={item.mailbox.unread > 0}>
                                          <span>{item.mailbox.unread} unread</span>
                                        </Show>
                                        <Show when={item.outcome}>{(outcome) => <span>{outcome().label}</span>}</Show>
                                      </div>
                                    </article>
                                  )
                                }}
                              </For>
                            </div>
                          </Show>
                        </section>
                      </Show>
                    )}
                  </For>
                  <Show when={detail()}>
                    {(item) => (
                      <aside
                        aria-label={`${item().name} details`}
                        class="rounded-[var(--v2-radius-card)] border border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-layer-01)] px-4 py-3"
                      >
                        <div class="flex items-center gap-2">
                          <StatusGlyph name={workerGlyph(item().state)} />
                          <strong class="min-w-0 flex-1 truncate">{item().name}</strong>
                          <ButtonV2 size="small" variant="ghost-muted" onClick={() => setView("detail", undefined)}>
                            Close
                          </ButtonV2>
                        </div>
                        <Show when={item().role}>
                          <div class="mt-1 text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                            {item().role}
                          </div>
                        </Show>
                        <div class="mt-2 text-[var(--v2-font-size-small)] text-[var(--v2-text-text-muted)]">
                          {current(item()) ?? "No active work summary"}
                        </div>
                        <Show when={item().attention.plan}>
                          {(plan) => (
                            <div class="mt-2 text-[var(--v2-state-fg-decision)]">Plan review · {plan().state}</div>
                          )}
                        </Show>
                        <Show when={item().dependency_ids.length > 0}>
                          <div class="mt-3 font-mono text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                            Dependencies · {item().dependency_ids.map(dependency).join(" · ")}
                          </div>
                        </Show>
                        <div class="mt-3 flex flex-col gap-1" role="list" aria-label="Assigned tasks">
                          <For each={assigned(item())}>
                            {(entry) => (
                              <div
                                role="listitem"
                                class="text-[var(--v2-font-size-small)] text-[var(--v2-text-text-muted)]"
                              >
                                <StatusGlyph name={taskGlyph(entry.status)} /> {entry.description}
                              </div>
                            )}
                          </For>
                        </div>
                      </aside>
                    )}
                  </Show>
                </Show>
              </Show>
              <Show when={result().dependencies.length > 0}>
                <section aria-label="Team dependencies" class="flex flex-col gap-2">
                  <h3 class="font-mono text-[var(--v2-font-size-label)] font-bold uppercase tracking-[0.08em] text-[var(--v2-text-text-muted)]">
                    Dependencies · {result().dependencies.length}
                  </h3>
                  <div class="flex flex-col gap-1" role="list">
                    <For each={result().dependencies}>
                      {(edge) => (
                        <div
                          role="listitem"
                          class="rounded-[var(--v2-radius-card)] border border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-layer-01)] px-3 py-2 text-[var(--v2-font-size-small)] text-[var(--v2-text-text-muted)]"
                        >
                          <StatusGlyph name={edge.satisfied ? "done" : "pending"} /> {dependency(edge.from_id)} waits on{" "}
                          {dependency(edge.to_id)} · {edge.satisfied ? "satisfied" : "pending"}
                        </div>
                      )}
                    </For>
                  </div>
                </section>
              </Show>
              <Show when={result().attention_items.length > 0}>
                <section aria-label="Team attention" class="flex flex-col gap-2">
                  <h3 class="font-mono text-[var(--v2-font-size-label)] font-bold uppercase tracking-[0.08em] text-[var(--v2-text-text-muted)]">
                    Attention · {result().attention_items.length}
                  </h3>
                  <div class="flex flex-col gap-1" role="list">
                    <For each={result().attention_items}>
                      {(attention) => (
                        <div
                          role="listitem"
                          class="rounded-[var(--v2-radius-card)] border border-[var(--v2-state-border-decision)] bg-[var(--v2-state-bg-decision)] px-3 py-2 text-[var(--v2-font-size-small)] text-[var(--v2-state-fg-decision)]"
                        >
                          <StatusGlyph name="needs-you" /> {worker(attention.member_id)?.name ?? attention.member_id} ·{" "}
                          {attention.kind} · {attention.actionable ? "action required" : "informational"}
                        </div>
                      )}
                    </For>
                  </div>
                </section>
              </Show>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  )
}
