import type { TeamInfo, TeamTask } from "@oc2-ai/sdk/v2"
import { StatusGlyph } from "@oc2-ai/ui/v2/status-glyph"
import { StateBlockV2 } from "@oc2-ai/ui/v2/state-block-v2"
import { ButtonV2 } from "@oc2-ai/ui/v2/button-v2"
import { KeyHintV2 } from "@oc2-ai/ui/v2/key-hint-v2"
import { For, Match, Show, Switch, createMemo, createResource, onCleanup, onMount } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import {
  groupTeamTasks,
  rootSessionID,
  stableAgentColor,
  teamTaskGroup,
  type TeamTaskGroup,
} from "./session-chrome-model"
import "./team-board.css"

const groups: { id: TeamTaskGroup; label: string; glyph: "running" | "needs-you" | "pending" | "done" | "failed" }[] = [
  { id: "working", label: "Working", glyph: "running" },
  { id: "blocked", label: "Dependency blocked", glyph: "pending" },
  { id: "needs-you", label: "Waiting on you", glyph: "needs-you" },
  { id: "idle", label: "Idle", glyph: "pending" },
  { id: "errored", label: "Errored", glyph: "failed" },
  { id: "completed", label: "Completed", glyph: "done" },
]

export function TeamBoard(props: { sessionID: string; mode: "board" | "tasks"; onExit: () => void }) {
  const sdk = useSDK()
  const sync = useSync()
  const teamSessionID = createMemo(() => rootSessionID(sync.data.session, props.sessionID))
  const [data, { refetch }] = createResource(
    () => [teamSessionID(), sdk.directory] as const,
    async ([sessionID]) => {
      const response = await sdk.client.team.get({ sessionID }, { throwOnError: false })
      if (response.error && response.response.status === 400) return
      if (response.error) throw response.error
      const team = response.data
      if (!team || typeof team !== "object" || Array.isArray(team) || typeof team.id !== "string") return
      const access = { teamID: team.id, sessionID }
      const result = await sdk.client.team.tasks(access, { throwOnError: false })
      if (result.error) throw result.error
      const tasks = Array.isArray(result.data) ? result.data : []
      return { team, tasks } satisfies { team: TeamInfo; tasks: TeamTask[] }
    },
  )

  onMount(() => {
    const timer = window.setInterval(() => void refetch(), 5000)
    onCleanup(() => window.clearInterval(timer))
  })

  const taskGroups = createMemo(() => groupTeamTasks(data()?.tasks ?? []))
  const completed = createMemo(() => taskGroups().completed.length)
  const children = createMemo(() => sync.data.session.filter((item) => item.parentID === teamSessionID()))
  const memberFor = (assignee?: string) =>
    assignee ? children().find((item) => item.id === assignee || item.title === assignee) : undefined
  const pendingFor = (assignee?: string) => {
    const member = memberFor(assignee)
    if (!member) return 0
    return (sync.data.permission[member.id]?.length ?? 0) + (sync.data.question[member.id]?.length ?? 0)
  }
  const assignees = createMemo(() => {
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
        : tasks.some((task) => teamTaskGroup(task, data()?.tasks ?? []) === "working")
          ? ("working" as const)
          : tasks.some((task) => teamTaskGroup(task, data()?.tasks ?? []) === "blocked")
            ? ("blocked" as const)
            : tasks.some((task) => teamTaskGroup(task, data()?.tasks ?? []) === "errored")
              ? ("errored" as const)
              : tasks.every((task) => teamTaskGroup(task, data()?.tasks ?? []) === "completed")
                ? ("completed" as const)
                : ("idle" as const)
      const current =
        tasks.find((task) => teamTaskGroup(task, data()?.tasks ?? []) === "working") ??
        tasks.find((task) => teamTaskGroup(task, data()?.tasks ?? []) === "blocked") ??
        tasks.find((task) => teamTaskGroup(task, data()?.tasks ?? []) === "idle") ??
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
  type Assignee = ReturnType<typeof assignees>[number]
  const assigneeGroups = createMemo(() =>
    assignees().reduce<Record<TeamTaskGroup, Assignee[]>>(
      (result, assignee) => {
        result[assignee.state].push(assignee)
        return result
      },
      { working: [], blocked: [], "needs-you": [], idle: [], completed: [], errored: [] },
    ),
  )
  const dependency = (id: string) => data()?.tasks.find((task) => task.id === id)?.description ?? id

  return (
    <div
      class="size-full overflow-y-auto bg-[var(--v2-background-bg-base)] px-4 py-4 sm:px-6 flex flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        props.onExit()
      }}
    >
      <Switch>
        <Match when={data.loading && !data()}>
          <StateBlockV2 variant="loading" title="Loading team board…" scale="full" />
        </Match>
        <Match when={data.error}>
          <StateBlockV2
            variant="error"
            title="Team board unavailable"
            description="The latest team data could not be loaded."
            scale="full"
            action={
              <ButtonV2 size="small" onClick={() => void refetch()}>
                Retry
              </ButtonV2>
            }
            hint={<KeyHintV2 shortcut="enter" label="retry" />}
          />
        </Match>
        <Match when={!data()}>
          <StateBlockV2
            variant="empty"
            title="No team for this session"
            description="This session runs a single agent."
            scale="full"
          />
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
                  {assignees().length} assignees · {assigneeGroups().working.length} working ·{" "}
                  {assigneeGroups().blocked.length} blocked · {assigneeGroups().idle.length} idle ·{" "}
                  {assigneeGroups().completed.length} done · tasks {completed()}/{result().tasks.length}
                </div>
              </header>

              <Show
                when={result().tasks.length > 0}
                fallback={
                  <StateBlockV2
                    variant="empty"
                    title="No team tasks yet"
                    description="Create a task to start tracking team work."
                  />
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
                                  groups.find((group) => group.id === teamTaskGroup(task, result().tasks))?.glyph ??
                                  "pending"
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
                    when={assignees().length > 0}
                    fallback={
                      <div class="text-[var(--v2-text-text-muted)]">
                        <StatusGlyph name="pending" /> no task assignees · open Tasks for unassigned work
                      </div>
                    }
                  >
                    <For each={groups}>
                      {(group) => (
                        <Show when={assigneeGroups()[group.id].length > 0}>
                          <section aria-labelledby={`team-${group.id}`} class="flex flex-col gap-2">
                            <h3
                              id={`team-${group.id}`}
                              class="font-mono text-[var(--v2-font-size-label)] font-bold uppercase tracking-[0.08em] text-[var(--v2-text-text-muted)]"
                            >
                              <StatusGlyph name={group.glyph} /> {group.label} · {assigneeGroups()[group.id].length}
                            </h3>
                            <div data-component="team-board-grid">
                              <For each={assigneeGroups()[group.id]}>
                                {(assignee) => (
                                  <article
                                    tabIndex={0}
                                    aria-label={`${assignee.name}, ${group.label}, ${assignee.current.description}`}
                                    class="min-w-0 rounded-[var(--v2-radius-card)] border bg-[var(--v2-background-bg-layer-02)] px-3 py-3 outline-none focus-visible:shadow-[var(--v2-shadow-focus)]"
                                    style={{
                                      "border-color":
                                        group.id === "working"
                                          ? "var(--v2-state-border-thinking)"
                                          : `var(--v2-agent-${stableAgentColor(assignee.name) + 1})`,
                                    }}
                                  >
                                    <div class="flex min-w-0 items-center gap-2">
                                      <StatusGlyph name={group.glyph} />
                                      <strong
                                        class="min-w-0 flex-1 truncate text-[var(--v2-text-text-base)]"
                                        title={assignee.name}
                                      >
                                        {assignee.name}
                                      </strong>
                                    </div>
                                    <div
                                      class="mt-2 line-clamp-2 min-h-10 text-[var(--v2-font-size-small)] text-[var(--v2-text-text-muted)]"
                                      title={assignee.current.description}
                                    >
                                      {assignee.current.description}
                                    </div>
                                    <Show when={assignee.dependencies.length}>
                                      <div
                                        class="mt-2 truncate text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]"
                                        title={assignee.dependencies.map(dependency).join(", ")}
                                      >
                                        waits on {assignee.dependencies.map(dependency).join(" · ")}
                                      </div>
                                    </Show>
                                    <div class="mt-2 flex min-w-0 items-center gap-2 font-mono text-[var(--v2-font-size-meta)] text-[var(--v2-text-text-faint)]">
                                      <span>
                                        {assignee.tasks.length} task{assignee.tasks.length === 1 ? "" : "s"}
                                      </span>
                                      <span class="flex-1" />
                                      <Show when={assignee.pending > 0}>
                                        <span class="text-[var(--v2-state-fg-decision)]">
                                          <StatusGlyph name="needs-you" /> {assignee.pending} pending
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
