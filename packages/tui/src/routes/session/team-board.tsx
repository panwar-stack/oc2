import type { TeamBoard as TeamBoardSnapshot, TeamBoardTask, TeamBoardWorker, TeamInfo } from "@oc2-ai/sdk/v2"
import { BoxRenderable, TextAttributes, type KeyEvent } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createResource,
  on,
  onCleanup,
  onMount,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Glyph, type GlyphName } from "../../component/glyph"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { useDialog } from "../../ui/dialog"
import { Locale } from "../../util/locale"
import { errorMessage } from "../../util/error"
import {
  BOARD_STATE_ORDER,
  acceptBoardSnapshot,
  boardDependencyRows,
  boardTaskGlyph,
  boardWidthTier,
  boardWorkerFocusIDs,
  boardWorkerSummary,
  cycleBoardView,
  groupBoardWorkers,
  moveBoardFocus,
  type BoardState,
  type BoardView,
} from "./team-board-model"

const stateMeta: Record<BoardState, { label: string; glyph: GlyphName }> = {
  needs_you: { label: "WAITING ON YOU", glyph: "needs-you" },
  errored: { label: "ERRORED", glyph: "failed" },
  working: { label: "WORKING", glyph: "running" },
  blocked: { label: "DEPENDENCY BLOCKED", glyph: "pending" },
  idle: { label: "IDLE", glyph: "pending" },
  completed: { label: "COMPLETED", glyph: "done" },
}

export function TeamBoard(props: {
  visible: boolean
  sessionID: string
  view: Exclude<BoardView, "session">
  teamID?: string
  onView: (view: BoardView) => void
  onTeamID: (teamID: string | undefined) => void
  onBack: () => void
}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    completedOpen: false,
    selectingTeam: false,
    focus: 0,
    snapshot: undefined as
      | { revision: number; generation: number; value: TeamBoardSnapshot; teamID: string }
      | undefined,
    failure: undefined as string | undefined,
  })
  let root: BoxRenderable | undefined
  let requestGeneration = 0
  const itemRefs = new Map<string, BoxRenderable>()

  const [discovery, { refetch: refetchDiscovery }] = createResource(
    () => (props.visible ? [props.sessionID, sdk.directory] as const : undefined),
    async ([viewerSessionID]) => {
      const responses = await Promise.all([
        sdk.client.team.get({ viewer_session_id: viewerSessionID }, { throwOnError: false }),
        sdk.client.team.history({ viewer_session_id: viewerSessionID }, { throwOnError: false }),
      ]).then(
        ([active, history]) => ({ active, history }),
        (error) => ({ error: errorMessage(error) }),
      )
      if ("error" in responses) return { error: responses.error, active: undefined, history: [] as TeamInfo[] }
      const { active, history } = responses
      if (history.error) return { error: errorMessage(history.error), active: undefined, history: [] as TeamInfo[] }
      if (active.error && active.response.status !== 400)
        return { error: errorMessage(active.error), active: undefined, history: history.data }
      return { active: active.error ? undefined : active.data, history: history.data }
    },
  )

  createEffect(() => {
    if (!props.visible || props.teamID || store.selectingTeam) return
    const result = discovery()
    if (!result || result.error || result.active?.status !== "active") return
    props.onTeamID(result.active.id)
  })

  const [board, { refetch: refetchBoard }] = createResource(
    () => (props.visible && props.teamID ? [props.teamID, props.sessionID, sdk.directory] as const : undefined),
    async ([teamID, viewerSessionID]) => {
      const generation = ++requestGeneration
      const response = await sdk.client.team
        .board({ teamID, viewer_session_id: viewerSessionID }, { throwOnError: false })
        .catch((error) => ({ failure: errorMessage(error) }))
      if ("failure" in response) return { status: "error" as const, teamID, error: response.failure }
      if (response.error) return { status: "error" as const, teamID, error: errorMessage(response.error) }
      return { status: "ready" as const, teamID, generation, value: response.data }
    },
  )

  createEffect(() => {
    const result = board.latest
    if (!result || result.teamID !== props.teamID) return
    if (result.status === "error") {
      setStore("failure", result.error)
      return
    }
    const next = acceptBoardSnapshot(
      store.snapshot?.teamID === result.teamID ? store.snapshot : undefined,
      { revision: result.value.revision, generation: result.generation, value: result.value },
    )
    setStore({ snapshot: { ...next, teamID: result.teamID }, failure: undefined })
  })

  createEffect(
    on(
      () => props.teamID,
      (teamID, previous) => {
        if (previous === undefined || teamID === previous) return
        setStore({ snapshot: undefined, failure: undefined, completedOpen: false, focus: 0 })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sdk.connection.status,
      (status, previous) => {
        if (!props.visible || status !== "connected" || previous === undefined || previous === "connected") return
        void refetchDiscovery()
        if (props.teamID) void refetchBoard()
      },
      { defer: true },
    ),
  )

  onMount(() => {
    const timer = setInterval(() => {
      if (!props.visible) return
      void refetchDiscovery()
      if (props.teamID) void refetchBoard()
    }, 30_000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    if (!props.visible) return
    setTimeout(() => {
      if (root && !root.isDestroyed) root.focus()
    }, 1)
  })

  const snapshot = createMemo(() => {
    const current = store.snapshot
    if (!current || current.teamID !== props.teamID) return
    return current.value
  })
  const groups = createMemo(() => groupBoardWorkers(snapshot()?.workers ?? []))
  const dependencies = createMemo(() => (snapshot() ? boardDependencyRows(snapshot()!) : []))
  const focusIDs = createMemo(() => {
    const result = snapshot()
    if (!props.teamID) return (discovery()?.history ?? []).map((team) => `team:${team.id}`)
    if (!result) return []
    const ids =
      props.view === "board"
        ? boardWorkerFocusIDs(groups(), store.completedOpen)
        : result.tasks.map((task) => `task:${task.id}`)
    if (dependencies().length > 0) ids.push("dependency-graph")
    if ((discovery()?.history.length ?? 0) > 1) ids.push("team-history")
    return ids
  })
  const tier = createMemo(() => boardWidthTier(dimensions().width))
  const cardWidth = createMemo(() => Math.max(20, dimensions().width - (dimensions().width >= 100 ? 44 : 10)))
  const selectedTeam = createMemo(() => discovery()?.history.find((team) => team.id === props.teamID))
  const dependencyName = (id: string) => {
    const result = snapshot()
    if (!result) return id
    return (
      result.workers.find((worker) => worker.member_id === id || worker.session_id === id)?.name ??
      result.tasks.find((task) => task.id === id)?.description ??
      id
    )
  }
  const focusItem = (index: number) => {
    setStore("focus", index)
    const id = focusIDs()[index]
    const item = id ? itemRefs.get(id) : undefined
    if (item && !item.isDestroyed) item.focus()
    else if (root && !root.isDestroyed) root.focus()
  }
  const workerFor = (id: string) => snapshot()?.workers.find((worker) => worker.member_id === id)
  const taskFor = (id: string) => snapshot()?.tasks.find((task) => task.id === id)
  const activate = (id: string | undefined) => {
    if (!id) {
      if (store.failure) void refetchBoard()
      else if (discovery()?.error) void refetchDiscovery()
      return
    }
    if (id.startsWith("team:")) {
      setStore("selectingTeam", false)
      props.onTeamID(id.slice("team:".length))
      return
    }
    if (id === "team-history") {
      setStore({ selectingTeam: true, focus: 0 })
      props.onTeamID(undefined)
      return
    }
    if (id === "completed-toggle") {
      setStore("completedOpen", !store.completedOpen)
      focusItem(0)
      return
    }
    if (id === "dependency-graph") {
      dialog.replace(() => <DependencyGraph rows={dependencies()} />)
      return
    }
    if (id.startsWith("worker:")) {
      const worker = workerFor(id.slice("worker:".length))
      if (worker) dialog.replace(() => <WorkerDetail worker={worker} dependencies={worker.dependency_ids.map(dependencyName)} />)
      return
    }
    const task = taskFor(id.slice("task:".length))
    if (task) dialog.replace(() => <TaskDetail task={task} dependencies={task.dependency_ids.map(dependencyName)} />)
  }
  const key = (event: KeyEvent) => {
    if (event.name === "escape") {
      event.preventDefault()
      event.stopPropagation()
      props.onBack()
      return
    }
    if (event.name === "left" || event.name === "right") {
      event.preventDefault()
      event.stopPropagation()
      props.onView(cycleBoardView(props.view, event.name === "left" ? -1 : 1))
      return
    }
    if (event.name === "up" || event.name === "down") {
      event.preventDefault()
      event.stopPropagation()
      focusItem(moveBoardFocus(store.focus, focusIDs().length, event.name === "up" ? -1 : 1))
      return
    }
    if (event.name !== "return") return
    event.preventDefault()
    event.stopPropagation()
    activate(focusIDs()[store.focus])
  }

  return (
    <box
      visible={props.visible}
      ref={(value) => (root = value)}
      focusable
      flexGrow={1}
      minHeight={0}
      onKeyDown={key}
      paddingTop={1}
    >
      <scrollbox flexGrow={1} minHeight={0}>
        <box gap={1} paddingRight={1}>
          <box flexDirection="row" justifyContent="space-between">
            <box onMouseUp={props.onBack}>
              <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                ← Back
              </text>
            </box>
            <box flexDirection="row" gap={1}>
              <For each={["session", "board", "tasks"] as const}>
                {(view) => (
                  <box onMouseUp={() => props.onView(view)}>
                    <text
                      fg={view === props.view ? theme.selectedListItemText : theme.textMuted}
                      bg={view === props.view ? theme.primary : theme.backgroundMenu}
                      attributes={view === props.view ? TextAttributes.BOLD : undefined}
                    >
                      {` ${Locale.titlecase(view)} `}
                    </text>
                  </box>
                )}
              </For>
            </box>
          </box>
          <Show when={sdk.connection.status() !== "connected"}>
            <text fg={theme.warning} wrapMode="none">
              ○ {sdk.connection.status()} · showing the last team update
            </text>
          </Show>
          <Show when={store.failure && snapshot()}>
            <text fg={theme.error} wrapMode="none">
              ✕ refresh failed · showing revision {snapshot()!.revision} · enter retry
            </text>
          </Show>
          <Switch>
            <Match when={(discovery.loading || (props.teamID && board.loading)) && !snapshot()}>
              <text fg={theme.textMuted}>◐ Loading team Board...</text>
            </Match>
            <Match when={(discovery()?.error || store.failure) && !snapshot()}>
              <text fg={theme.error} wrapMode="none">
                ✕ Team Board unavailable · enter retry
              </text>
              <text fg={theme.textMuted} wrapMode="none">
                {Locale.truncate(discovery()?.error ?? store.failure ?? "Request failed", cardWidth())}
              </text>
            </Match>
            <Match when={!props.teamID && (discovery()?.history.length ?? 0) === 0}>
              <text fg={theme.textMuted}>○ no team · this session runs a single agent</text>
            </Match>
            <Match when={!props.teamID}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Select a team
              </text>
              <text fg={theme.textMuted}>No active team was selected. Historical teams are never guessed.</text>
              <For each={discovery()?.history ?? []}>
                {(team, index) => {
                  const id = `team:${team.id}`
                  return (
                    <box
                      ref={(value) => itemRefs.set(id, value)}
                      focusable
                      border
                      borderColor={store.focus === index() ? theme.borderActive : theme.borderSubtle}
                      paddingLeft={1}
                      paddingRight={1}
                      on:focused={() => setStore("focus", index())}
                      onMouseUp={() => {
                        setStore("selectingTeam", false)
                        props.onTeamID(team.id)
                      }}
                    >
                      <text fg={theme.text} wrapMode="none">
                        {Locale.truncate(`${team.name} · ${team.status}`, cardWidth())}
                      </text>
                      <text fg={theme.textMuted} wrapMode="none">
                        {Locale.truncate(team.goal, cardWidth())}
                      </text>
                    </box>
                  )
                }}
              </For>
            </Match>
            <Match when={snapshot()}>
              {(data) => (
                <>
                  <box>
                    <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
                      {Locale.truncate(`Team · ${data().team.name}`, cardWidth())}
                    </text>
                    <text fg={theme.textMuted} wrapMode="none">
                      {Locale.truncate(data().team.goal, cardWidth())}
                    </text>
                    <text fg={theme.textMuted} wrapMode="none">
                      {Locale.truncate(
                        `${data().counts.workers} workers · ${data().counts.working} working · ${data().counts.blocked} blocked · ${data().counts.idle} idle · ${data().counts.done} done · ✉ ${data().counts.unread} unread · tasks ${data().counts.claimed}/${data().counts.total_tasks} claimed · ${data().team.status}`,
                        cardWidth(),
                      )}
                    </text>
                  </box>
                  <Show
                    when={props.view === "board"}
                    fallback={
                      <TasksView
                        board={data()}
                        focus={store.focus}
                        width={cardWidth()}
                        itemRefs={itemRefs}
                        dependencyName={dependencyName}
                        setFocus={(index) => setStore("focus", index)}
                        open={(task) =>
                          dialog.replace(() => (
                            <TaskDetail task={task} dependencies={task.dependency_ids.map(dependencyName)} />
                          ))
                        }
                      />
                    }
                  >
                    <Show
                      when={data().workers.length > 0}
                      fallback={<text fg={theme.textMuted}>○ no workers in this team</text>}
                    >
                      <For each={BOARD_STATE_ORDER}>
                        {(state) => (
                          <Show when={groups()[state].length > 0}>
                            <box gap={1}>
                              <Show
                                when={state === "completed"}
                                fallback={
                                  <box flexDirection="row" gap={1}>
                                    <Glyph name={stateMeta[state].glyph} />
                                    <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                                      {stateMeta[state].label} · {groups()[state].length}
                                    </text>
                                  </box>
                                }
                              >
                                <box
                                  ref={(value) => itemRefs.set("completed-toggle", value)}
                                  focusable
                                  flexDirection="row"
                                  gap={1}
                                  backgroundColor={
                                    focusIDs()[store.focus] === "completed-toggle" ? theme.backgroundMenu : undefined
                                  }
                                  on:focused={() => setStore("focus", focusIDs().indexOf("completed-toggle"))}
                                  onMouseUp={() => activate("completed-toggle")}
                                >
                                  <Glyph name="done" />
                                  <text fg={theme.success} attributes={TextAttributes.BOLD}>
                                    COMPLETED · {groups().completed.length} · {store.completedOpen ? "collapse" : "expand"}
                                  </text>
                                </box>
                              </Show>
                              <Show when={state !== "completed" || store.completedOpen}>
                                <For each={groups()[state]}>
                                  {(worker) => {
                                    const id = `worker:${worker.member_id}`
                                    const index = () => focusIDs().indexOf(id)
                                    return (
                                      <WorkerCard
                                        worker={worker}
                                        tier={tier()}
                                        width={cardWidth()}
                                        dependencies={worker.dependency_ids.map(dependencyName)}
                                        focused={focusIDs()[store.focus] === id}
                                        ref={(value) => itemRefs.set(id, value)}
                                        onFocus={() => setStore("focus", index())}
                                        onOpen={() => {
                                          focusItem(index())
                                          activate(id)
                                        }}
                                      />
                                    )
                                  }}
                                </For>
                              </Show>
                            </box>
                          </Show>
                        )}
                      </For>
                    </Show>
                  </Show>
                  <Show when={dependencies().length > 0}>
                    <box gap={1} paddingTop={1}>
                      <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                        DEPENDENCIES
                      </text>
                      <For each={dependencies().slice(0, tier() === "compact" ? 3 : 6)}>
                        {(row) => (
                          <text fg={row.satisfied ? theme.textMuted : theme.warning} wrapMode="none">
                            {row.satisfied ? "✓" : "○"} {Locale.truncate(row.label, cardWidth() - 2)}
                          </text>
                        )}
                      </For>
                      <box
                        ref={(value) => itemRefs.set("dependency-graph", value)}
                        focusable
                        backgroundColor={
                          focusIDs()[store.focus] === "dependency-graph" ? theme.backgroundMenu : undefined
                        }
                        on:focused={() => setStore("focus", focusIDs().indexOf("dependency-graph"))}
                        onMouseUp={() => {
                          focusItem(focusIDs().indexOf("dependency-graph"))
                          activate("dependency-graph")
                        }}
                      >
                        <text fg={theme.primary}>view graph ▸</text>
                      </box>
                    </box>
                  </Show>
                  <Show when={(discovery()?.history.length ?? 0) > 1}>
                    <box
                      ref={(value) => itemRefs.set("team-history", value)}
                      focusable
                      backgroundColor={focusIDs()[store.focus] === "team-history" ? theme.backgroundMenu : undefined}
                      on:focused={() => setStore("focus", focusIDs().indexOf("team-history"))}
                      onMouseUp={() => {
                        focusItem(focusIDs().indexOf("team-history"))
                        activate("team-history")
                      }}
                    >
                      <text fg={theme.primary}>select team history · {discovery()!.history.length} teams ▸</text>
                    </box>
                  </Show>
                  <text fg={theme.textFaint} wrapMode="none">
                    esc back · ←→ tabs · ↑↓ cards · enter details · revision {data().revision}
                    {selectedTeam() ? ` · ${selectedTeam()!.status}` : ""}
                  </text>
                </>
              )}
            </Match>
          </Switch>
        </box>
      </scrollbox>
    </box>
  )
}

function WorkerCard(props: {
  worker: TeamBoardWorker
  tier: "compact" | "standard" | "full"
  width: number
  dependencies: string[]
  focused: boolean
  ref: (value: BoxRenderable) => void
  onFocus: () => void
  onOpen: () => void
}) {
  const { theme } = useTheme()
  const meta = stateMeta[props.worker.state]
  const badges = createMemo(() =>
    [
      props.worker.elapsed_ms === null ? undefined : Locale.duration(props.worker.elapsed_ms),
      props.worker.mailbox.unread > 0 ? `✉ ${props.worker.mailbox.unread} unread` : undefined,
      props.worker.attention.plan ? `▲ plan ${props.worker.attention.plan.state}` : undefined,
      props.worker.attention.permissions > 0 ? `▲ ${props.worker.attention.permissions} permission` : undefined,
      props.worker.attention.questions > 0 ? `▲ ${props.worker.attention.questions} question` : undefined,
    ].filter((item): item is string => item !== undefined),
  )
  return (
    <box
      ref={props.ref}
      focusable
      border
      borderColor={props.focused ? theme.borderActive : props.worker.state === "working" ? theme.warning : theme.borderSubtle}
      backgroundColor={theme.backgroundElement}
      paddingLeft={1}
      paddingRight={1}
      on:focused={props.onFocus}
      onMouseUp={props.onOpen}
    >
      <box flexDirection="row" gap={1}>
        <Glyph name={meta.glyph} />
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {Locale.truncate(props.worker.name, Math.max(10, props.width - meta.label.length - 5))}
        </text>
        <text fg={theme.textMuted} flexGrow={1} wrapMode="none">
          {meta.label.toLowerCase()}
        </text>
      </box>
      <text fg={theme.secondary} wrapMode="none">
        {Locale.truncate(
          `@${props.worker.agent_type}${props.worker.role === null ? "" : ` · ${props.worker.role}`}`,
          props.width,
        )}
      </text>
      <text fg={theme.textMuted} wrapMode="none">
        {Locale.truncate(boardWorkerSummary(props.worker), props.width)}
      </text>
      <Show when={props.tier !== "compact"}>
        <text fg={theme.textFaint} wrapMode="none">
          {Locale.truncate(
            [
              props.worker.lifecycle,
              props.worker.work_mode,
              props.worker.mutability === "unknown" ? undefined : props.worker.mutability.replace("_", "-"),
            ]
              .filter(Boolean)
              .join(" · "),
            props.width,
          )}
        </text>
      </Show>
      <Show when={props.tier === "full" && props.worker.current_work}>
        {(work) => (
          <text fg={theme.textFaint} wrapMode="none">
            {Locale.truncate(`current ${work().source}${work().id === null ? "" : ` · ${work().id}`}`, props.width)}
          </text>
        )}
      </Show>
      <Show when={props.dependencies.length > 0}>
        <text fg={theme.textMuted} wrapMode="none">
          waits on {Locale.truncate(props.dependencies.join(" · "), Math.max(8, props.width - 9))}
        </text>
      </Show>
      <Show when={badges().length > 0}>
        <text fg={theme.accent} wrapMode="none">
          {Locale.truncate(badges().join(" · "), props.width)}
        </text>
      </Show>
      <Show when={props.worker.outcome}>
        {(outcome) => (
          <text fg={outcome().type === "failed" ? theme.error : outcome().type === "succeeded" ? theme.success : theme.textMuted}>
            {outcome().type === "failed" ? "✕" : outcome().type === "succeeded" ? "✓" : "○"} {outcome().label}
          </text>
        )}
      </Show>
      <Show when={props.worker.result_persisted}>
        <text fg={theme.textMuted}>✓ reports persisted</text>
      </Show>
    </box>
  )
}

function TasksView(props: {
  board: TeamBoardSnapshot
  focus: number
  width: number
  itemRefs: Map<string, BoxRenderable>
  dependencyName: (id: string) => string
  setFocus: (index: number) => void
  open: (task: TeamBoardTask) => void
}) {
  const { theme } = useTheme()
  return (
    <Show when={props.board.tasks.length > 0} fallback={<text fg={theme.textMuted}>○ no team tasks yet</text>}>
      <For each={props.board.tasks}>
        {(task, index) => {
          const id = `task:${task.id}`
          return (
            <box
              ref={(value) => props.itemRefs.set(id, value)}
              focusable
              border
              borderColor={props.focus === index() ? theme.borderActive : theme.borderSubtle}
              backgroundColor={theme.backgroundElement}
              paddingLeft={1}
              paddingRight={1}
              on:focused={() => props.setFocus(index())}
              onMouseUp={() => {
                const item = props.itemRefs.get(id)
                if (item && !item.isDestroyed) item.focus()
                props.setFocus(index())
                props.open(task)
              }}
            >
              <box flexDirection="row" gap={1}>
                <Glyph name={boardTaskGlyph(task, props.board)} />
                <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
                  {Locale.truncate(task.description, Math.max(12, props.width - 3))}
                </text>
              </box>
              <text fg={theme.textMuted} wrapMode="none">
                {Locale.truncate(
                  `${task.status} · ${task.assignee ?? "unassigned"}${
                    task.dependency_ids.length > 0
                      ? ` · waits on ${task.dependency_ids.map(props.dependencyName).join(" · ")}`
                      : ""
                  }`,
                  props.width,
                )}
              </text>
            </box>
          )
        }}
      </For>
    </Show>
  )
}

function WorkerDetail(props: { worker: TeamBoardWorker; dependencies: string[] }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {props.worker.name} · {props.worker.state}
      </text>
      <text fg={theme.secondary}>
        @{props.worker.agent_type}
        {props.worker.role === null ? "" : ` · ${props.worker.role}`}
      </text>
      <text fg={theme.textMuted}>{boardWorkerSummary(props.worker)}</text>
      <Show when={props.dependencies.length > 0}>
        <text fg={theme.textMuted} wrapMode="none">
          waits on {Locale.truncate(props.dependencies.join(" · "), Math.max(8, dimensions().width - 12))}
        </text>
      </Show>
      <Show when={props.worker.outcome}>{(outcome) => <text fg={theme.text}>{outcome().label}</text>}</Show>
      <text fg={theme.textFaint}>Projection-owned details only · esc close</text>
    </box>
  )
}

function TaskDetail(props: { task: TeamBoardTask; dependencies: string[] }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Task · {props.task.status}
      </text>
      <text fg={theme.textMuted}>{props.task.description}</text>
      <text fg={theme.secondary}>{props.task.assignee ?? "unassigned"}</text>
      <Show when={props.dependencies.length > 0}>
        <text fg={theme.textMuted} wrapMode="none">
          waits on {Locale.truncate(props.dependencies.join(" · "), Math.max(8, dimensions().width - 12))}
        </text>
      </Show>
      <text fg={theme.textFaint}>esc close</text>
    </box>
  )
}

function DependencyGraph(props: { rows: ReturnType<typeof boardDependencyRows> }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        Dependency graph
      </text>
      <For each={props.rows}>
        {(row) => (
          <text fg={row.satisfied ? theme.success : theme.warning} wrapMode="none">
            {row.satisfied ? "✓" : "○"} {Locale.truncate(row.label, Math.max(8, dimensions().width - 8))}
          </text>
        )}
      </For>
      <text fg={theme.textFaint}>esc close</text>
    </box>
  )
}
