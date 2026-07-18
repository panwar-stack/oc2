import type { TeamInfo, TeamMessage, TeamTask } from "@oc2-ai/sdk/v2"
import { StatusGlyph } from "@oc2-ai/ui/v2/status-glyph"
import { For, Match, Show, Switch, createMemo, createResource, onCleanup, onMount } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { groupTeamTasks, stableAgentColor, teamTaskGroup, type TeamTaskGroup } from "./session-chrome-model"
import "./team-board.css"

const groups: { id: TeamTaskGroup; label: string; glyph: "running" | "needs-you" | "pending" | "done" | "failed" }[] = [
  { id: "working", label: "Working", glyph: "running" },
  { id: "needs-you", label: "Waiting on you", glyph: "needs-you" },
  { id: "idle", label: "Idle", glyph: "pending" },
  { id: "errored", label: "Errored", glyph: "failed" },
  { id: "completed", label: "Completed", glyph: "done" },
]

export function TeamBoard(props: { sessionID: string; mode: "board" | "tasks"; onExit: () => void }) {
  const sdk = useSDK()
  const sync = useSync()
  const [data, { refetch }] = createResource(
    () => [props.sessionID, sdk.directory] as const,
    async ([sessionID]) => {
      const response = await sdk.client.team.get({ sessionID }, { throwOnError: false })
      const team = response.data
      if (!team) return
      const access = { teamID: team.id, sessionID }
      const [tasks, messages] = await Promise.all([
        sdk.client.team.tasks(access, { throwOnError: true }).then((result) => result.data),
        sdk.client.team.messages(access, { throwOnError: true }).then((result) => result.data),
      ])
      return { team, tasks, messages } satisfies { team: TeamInfo; tasks: TeamTask[]; messages: TeamMessage[] }
    },
  )

  onMount(() => {
    const timer = window.setInterval(() => void refetch(), 5000)
    onCleanup(() => window.clearInterval(timer))
  })

  const taskGroups = createMemo(() => groupTeamTasks(data()?.tasks ?? []))
  const completed = createMemo(() => taskGroups().completed.length)
  const children = createMemo(() => sync.data.session.filter((item) => item.parentID === props.sessionID))
  const memberFor = (assignee?: string) =>
    assignee ? children().find((item) => item.id === assignee || item.title === assignee) : undefined
  const pendingFor = (assignee?: string) => {
    const member = memberFor(assignee)
    if (!member) return 0
    return (sync.data.permission[member.id]?.length ?? 0) + (sync.data.question[member.id]?.length ?? 0)
  }
  const workers = createMemo(() => {
    const assigned = new Map<string, TeamTask[]>()
    for (const task of data()?.tasks ?? []) {
      if (!task.assignee) continue
      const tasks = assigned.get(task.assignee)
      if (tasks) tasks.push(task)
      else assigned.set(task.assignee, [task])
    }
    return [...assigned].map(([name, tasks]) => {
      const pending = pendingFor(name)
      const state = pending
        ? ("needs-you" as const)
        : tasks.some((task) => teamTaskGroup(task.status) === "working")
          ? ("working" as const)
          : tasks.some((task) => teamTaskGroup(task.status) === "errored")
            ? ("errored" as const)
            : tasks.every((task) => teamTaskGroup(task.status) === "completed")
              ? ("completed" as const)
              : ("idle" as const)
      const current =
        tasks.find((task) => teamTaskGroup(task.status) === "working") ??
        tasks.find((task) => teamTaskGroup(task.status) === "idle") ??
        tasks[0]!
      return {
        name,
        tasks,
        current,
        pending,
        state,
        dependencies: [...new Set(tasks.flatMap((task) => task.dependency_ids ?? []))],
      }
    })
  })
  type Worker = ReturnType<typeof workers>[number]
  const workerGroups = createMemo(() =>
    workers().reduce<Record<TeamTaskGroup, Worker[]>>(
      (result, worker) => {
        result[worker.state].push(worker)
        return result
      },
      { working: [], "needs-you": [], idle: [], completed: [], errored: [] },
    ),
  )
  const dependency = (id: string) => data()?.tasks.find((task) => task.id === id)?.description ?? id

  return (
    <div
      class="size-full overflow-y-auto bg-[var(--v2-background-bg-base)] px-4 py-4 sm:px-6"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        props.onExit()
      }}
    >
      <Switch>
        <Match when={data.loading && !data()}>
          <div role="status" class="text-[var(--v2-text-text-muted)]">
            <StatusGlyph name="running" /> loading team board…
          </div>
        </Match>
        <Match when={data.error}>
          <div role="alert" class="text-[var(--v2-state-fg-danger)]">
            <StatusGlyph name="failed" /> team board unavailable
          </div>
        </Match>
        <Match when={!data()}>
          <div class="text-[var(--v2-text-text-muted)]">
            <StatusGlyph name="pending" /> no team · this session runs a single agent
          </div>
        </Match>
        <Match when={data()}>
          {(result) => (
            <div class="mx-auto flex w-full max-w-[1100px] flex-col gap-5">
              <header class="min-w-0">
                <h2
                  class="truncate text-[var(--v2-font-size-title)] font-bold text-[var(--v2-text-text-base)]"
                  title={result().team.goal}
                >
                  Team · {result().team.name}
                </h2>
                <div
                  role="status"
                  aria-live="polite"
                  class="mt-1 truncate font-mono text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]"
                >
                  {workers().length} workers · {workerGroups().working.length} working · {workerGroups().idle.length}{" "}
                  idle · {workerGroups().completed.length} done · tasks {completed()}/{result().tasks.length}
                </div>
              </header>

              <Show
                when={result().tasks.length > 0}
                fallback={
                  <div class="text-[var(--v2-text-text-muted)]">
                    <StatusGlyph name="pending" /> no team tasks yet
                  </div>
                }
              >
                <Show
                  when={props.mode === "board"}
                  fallback={
                    <div class="flex flex-col gap-2" role="list" aria-label="Team tasks">
                      <For each={result().tasks}>
                        {(task) => (
                          <article
                            role="listitem"
                            class="min-w-0 rounded-[var(--v2-radius-card)] border border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-layer-02)] px-3 py-2"
                          >
                            <div class="flex min-w-0 items-center gap-2">
                              <StatusGlyph
                                name={
                                  groups.find((group) => group.id === teamTaskGroup(task.status))?.glyph ?? "pending"
                                }
                              />
                              <strong class="min-w-0 flex-1 truncate">{task.description}</strong>
                              <span class="shrink-0 text-[var(--v2-text-text-faint)]">
                                {task.assignee ?? "unassigned"}
                              </span>
                            </div>
                            <Show when={task.dependency_ids?.length}>
                              <div
                                class="mt-1 truncate text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]"
                                title={task.dependency_ids!.map(dependency).join(", ")}
                              >
                                waits on {task.dependency_ids!.map(dependency).join(" · ")}
                              </div>
                            </Show>
                          </article>
                        )}
                      </For>
                    </div>
                  }
                >
                  <Show
                    when={workers().length > 0}
                    fallback={
                      <div class="text-[var(--v2-text-text-muted)]">
                        <StatusGlyph name="pending" /> no assigned workers · open Tasks for unassigned work
                      </div>
                    }
                  >
                    <For each={groups}>
                      {(group) => (
                        <Show when={workerGroups()[group.id].length > 0}>
                          <section aria-labelledby={`team-${group.id}`} class="flex flex-col gap-2">
                            <h3
                              id={`team-${group.id}`}
                              class="font-mono text-[var(--v2-font-size-label)] font-bold uppercase tracking-[0.08em] text-[var(--v2-text-text-muted)]"
                            >
                              <StatusGlyph name={group.glyph} /> {group.label} · {workerGroups()[group.id].length}
                            </h3>
                            <div data-component="team-board-grid">
                              <For each={workerGroups()[group.id]}>
                                {(worker) => (
                                  <article
                                    tabIndex={0}
                                    aria-label={`${worker.name}, ${group.label}, ${worker.current.description}`}
                                    class="min-w-0 rounded-[var(--v2-radius-card)] border bg-[var(--v2-background-bg-layer-02)] px-3 py-3 outline-none focus-visible:shadow-[var(--v2-shadow-focus)]"
                                    style={{
                                      "border-color":
                                        group.id === "working"
                                          ? "var(--v2-state-border-thinking)"
                                          : `var(--v2-agent-${stableAgentColor(worker.name) + 1})`,
                                    }}
                                  >
                                    <div class="flex min-w-0 items-center gap-2">
                                      <StatusGlyph name={group.glyph} />
                                      <strong
                                        class="min-w-0 flex-1 truncate text-[var(--v2-text-text-base)]"
                                        title={worker.name}
                                      >
                                        {worker.name}
                                      </strong>
                                    </div>
                                    <div
                                      class="mt-2 line-clamp-2 min-h-10 text-[var(--v2-font-size-small)] text-[var(--v2-text-text-muted)]"
                                      title={worker.current.description}
                                    >
                                      {worker.current.description}
                                    </div>
                                    <Show when={worker.dependencies.length}>
                                      <div
                                        class="mt-2 truncate text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]"
                                        title={worker.dependencies.map(dependency).join(", ")}
                                      >
                                        waits on {worker.dependencies.map(dependency).join(" · ")}
                                      </div>
                                    </Show>
                                    <div class="mt-2 flex min-w-0 items-center gap-2 font-mono text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                                      <span>
                                        {worker.tasks.length} task{worker.tasks.length === 1 ? "" : "s"}
                                      </span>
                                      <span class="flex-1" />
                                      <Show when={worker.pending > 0}>
                                        <span class="text-[var(--v2-state-fg-decision)]">
                                          <StatusGlyph name="needs-you" /> {worker.pending} pending
                                        </span>
                                      </Show>
                                    </div>
                                  </article>
                                )}
                              </For>
                            </div>
                          </section>
                        </Show>
                      )}
                    </For>
                  </Show>
                </Show>
              </Show>
            </div>
          )}
        </Match>
      </Switch>
    </div>
  )
}
