import type { Session, TeamTask } from "@oc2-ai/sdk/v2"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useRouteData } from "../context/route"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { SplitBorder } from "../ui/border"
import { TextAttributes } from "@opentui/core"
import { Locale } from "../util/locale"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useBindings } from "../keymap"
import { errorMessage } from "../util/error"

type Tab = "overview" | "tasks" | "messages"

function memberStatusColor(
  status: { type: string } | undefined,
  teamStatus: { status: string; lifecycle?: string; daemonState?: string | null } | undefined,
  theme: ReturnType<typeof useTheme>["theme"],
) {
  const t = status?.type
  if (t === "retry") return theme.error
  if (t === "busy") return theme.success
  if (teamStatus?.status === "completed") return theme.success
  if (teamStatus?.status === "cancelled") return theme.error
  if (["starting", "blocked", "active", "idle"].includes(teamStatus?.status ?? "")) return theme.info
  return theme.textMuted
}

function memberStatusLabel(
  status: { type: string } | undefined,
  teamStatus: { status: string; lifecycle?: string; daemonState?: string | null } | undefined,
) {
  const t = status?.type
  if (teamStatus?.lifecycle === "daemon") return `daemon:${teamStatus.daemonState ?? teamStatus.status}`
  if (t === "retry") return "retry"
  if (t === "busy") return "working"
  if (teamStatus?.status === "completed") return "completed"
  if (teamStatus?.status === "cancelled") return "cancelled"
  if (teamStatus?.status === "active") return "active"
  if (teamStatus?.status === "starting") return "starting"
  if (teamStatus?.status === "blocked") return "blocked"
  if (teamStatus?.status === "idle") return "idle"
  return "idle"
}

function taskStatusColor(status: string, theme: ReturnType<typeof useTheme>["theme"]) {
  if (status === "completed") return theme.success
  if (status === "in_progress") return theme.warning
  if (status === "cancelled") return theme.error
  return theme.textMuted
}

function deliveryStatusColor(status: string, theme: ReturnType<typeof useTheme>["theme"]) {
  if (status === "read") return theme.success
  if (status === "delivered") return theme.text
  return theme.warning
}

export function groupDialogTeamTasks(tasks: readonly TeamTask[]) {
  const group = (status: string) =>
    status === "in_progress" || status === "working"
      ? "working"
      : status === "blocked"
        ? "blocked"
        : status === "needs-you" || status === "needs_you"
          ? "needs-you"
          : status === "completed" || status === "done"
            ? "completed"
            : status === "cancelled" || status === "failed" || status === "error"
              ? "errored"
              : "idle"
  return tasks.reduce<Record<"working" | "blocked" | "needs-you" | "idle" | "completed" | "errored", TeamTask[]>>(
    (result, task) => {
      result[group(task.status)].push(task)
      return result
    },
    { working: [], blocked: [], "needs-you": [], idle: [], completed: [], errored: [] },
  )
}

export function DialogTeam(props: { focusTab?: Tab; actionError?: string }) {
  const route = useRouteData("session")
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()

  const session = createMemo(() => sync.session.get(route.sessionID) as Session | undefined)
  const sessionID = createMemo(() => {
    const s = session()
    return s ? (s.parentID ?? s.id) : route.sessionID
  })

  const [team, { refetch: refetchTeam }] = createResource(
    () => sessionID(),
    (sid) =>
      sdk.client.team.get({ sessionID: sid }, { throwOnError: false }).then((response) => {
        if (response.error && response.response.status === 400) return
        if (response.error) throw response.error
        return response.data
      }),
  )

  const teamID = createMemo(() => team()?.id)
  const teamsEnabled = createMemo(() => sync.data.config.experimental?.agent_teams === true)
  const teamAccess = createMemo(() => {
    const id = teamID()
    if (!id) return undefined
    return { teamID: id, sessionID: sessionID() }
  })

  const [tasks, { refetch: refetchTasks }] = createResource(
    () => teamAccess(),
    (access) => sdk.client.team.tasks(access, { throwOnError: true }).then((res) => res.data),
  )

  const [messages, { refetch: refetchMessages }] = createResource(
    () => teamAccess(),
    (access) => sdk.client.team.messages(access, { throwOnError: true }).then((res) => res.data),
  )

  const childSessions = createMemo(() => {
    const sid = sessionID()
    return sync.data.session
      .filter((item) => item.parentID === sid && sync.data.team_member_status[item.id] !== undefined)
      .toSorted((a, b) => a.id.localeCompare(b.id))
  })

  const children = createMemo(() => {
    const sid = sessionID()
    const root = sync.data.session.find((item) => item.id === sid)
    return [root, ...childSessions()].filter((item) => item !== undefined)
  })

  const permissions = createMemo(() => children().flatMap((x) => sync.data.permission[x.id] ?? []))
  const questions = createMemo(() => children().flatMap((x) => sync.data.question[x.id] ?? []))
  const memberFor = (assignee?: string) =>
    assignee ? childSessions().find((member) => member.id === assignee || member.title === assignee) : undefined
  const taskPending = (assignee?: string) => {
    const member = memberFor(assignee)
    if (!member) return 0
    return (sync.data.permission[member.id]?.length ?? 0) + (sync.data.question[member.id]?.length ?? 0)
  }
  const taskGroups = createMemo(() => groupDialogTeamTasks(tasks() ?? []))

  const [tab, setTab] = createSignal<Tab>(props.focusTab ?? "overview")
  const tabs = ["overview", "tasks", "messages"] as const

  const moveTab = (step: number) => {
    const index = tabs.indexOf(tab())
    setTab(tabs[(index + step + tabs.length) % tabs.length])
  }

  const retry = () => {
    if (team.error) {
      void refetchTeam()
      return
    }
    if (tab() === "tasks") void refetchTasks()
    if (tab() === "messages") void refetchMessages()
  }

  const shutdown = async () => {
    const info = team()
    if (!info) return
    const selected = tab()
    const confirmed = await DialogConfirm.show(
      dialog,
      "Shutdown Team",
      "Stop all active team members and close this team?",
      undefined,
      { destructive: true, defaultOption: "cancel" },
    )
    if (confirmed === false) {
      dialog.replace(() => <DialogTeam focusTab={selected} />)
      return
    }
    if (!confirmed) return
    const result = await sdk.client.team.shutdown({ teamID: info.id, sessionID: sessionID() }, { throwOnError: false })
    if (!result.error) {
      dialog.clear()
      return
    }
    dialog.replace(() => <DialogTeam focusTab={selected} actionError={errorMessage(result.error)} />)
  }

  useBindings(() => ({
    bindings: [
      { key: "tab", desc: "Next team tab", group: "Team", cmd: () => moveTab(1) },
      { key: "shift+tab", desc: "Previous team tab", group: "Team", cmd: () => moveTab(-1) },
      { key: "r", desc: "Retry team data", group: "Team", cmd: retry },
      { key: "s", desc: "Shutdown team", group: "Team", cmd: () => void shutdown() },
    ],
  }))

  const tabStyle = (t: Tab) => ({
    fg: tab() === t ? theme.text : theme.textMuted,
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Team Panel
          <Show when={team()}>{(t) => <span style={{ fg: theme.textMuted }}> · {t().name}</span>}</Show>
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          tab switch · r retry · s shutdown · esc close
        </text>
      </box>

      <Show
        when={teamsEnabled()}
        fallback={
          <text fg={theme.warning}>
            Agent teams are disabled. Enable <span style={{ fg: theme.text }}>experimental.agent_teams</span> in config.
          </text>
        }
      >
        <Show when={props.actionError}>
          {(message) => (
            <text fg={theme.error} onMouseUp={() => void shutdown()}>
              ✕ {message()} · s retry shutdown
            </text>
          )}
        </Show>
        <Show
          when={team()}
          fallback={
            <>
              <Show when={team.loading}>
                <text fg={theme.textMuted}>Loading team data...</text>
              </Show>
              <Show when={team.error}>
                <text fg={theme.error} onMouseUp={() => void refetchTeam()}>
                  ✕ Team data unavailable · r retry
                </text>
              </Show>
              <Show when={!team.loading && !team.error}>
                <text fg={theme.textMuted}>○ No team for this session.</text>
              </Show>
            </>
          }
        >
          {(t) => {
            const info = t()
            return (
              <>
                <box flexDirection="row" gap={2} paddingBottom={1}>
                  <box onMouseUp={() => setTab("overview")}>
                    <text style={tabStyle("overview")} attributes={TextAttributes.BOLD}>
                      Overview
                    </text>
                  </box>
                  <box onMouseUp={() => setTab("tasks")}>
                    <text style={tabStyle("tasks")} attributes={TextAttributes.BOLD}>
                      Tasks ({tasks()?.length ?? 0})
                    </text>
                  </box>
                  <box onMouseUp={() => setTab("messages")}>
                    <text style={tabStyle("messages")} attributes={TextAttributes.BOLD}>
                      Messages ({messages()?.length ?? 0})
                    </text>
                  </box>
                </box>

                <Show when={tab() === "overview"}>
                  <box gap={1}>
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.textMuted}>Status:</text>
                      <text
                        fg={
                          info.status === "active"
                            ? theme.success
                            : info.status === "closed"
                              ? theme.error
                              : theme.textMuted
                        }
                      >
                        {info.status}
                      </text>
                    </box>
                    <Show when={info.goal}>
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted}>Goal:</text>
                        <text fg={theme.text}>{info.goal}</text>
                      </box>
                    </Show>

                    <box {...SplitBorder} border={["top"]} borderColor={theme.border} paddingTop={1}>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        Members ({childSessions().length})
                      </text>
                    </box>
                    <Show when={childSessions().length === 0}>
                      <text fg={theme.textMuted}>No team members. Use team_spawn to add members.</text>
                    </Show>
                    <For each={childSessions()}>
                      {(member) => {
                        const status = createMemo(() => sync.data.session_status[member.id])
                        const teamStatus = createMemo(() => sync.data.team_member_status[member.id])
                        const pending = createMemo(
                          () =>
                            (sync.data.permission[member.id]?.length ?? 0) +
                            (sync.data.question[member.id]?.length ?? 0),
                        )
                        return (
                          <box flexDirection="row" gap={1}>
                            <text flexShrink={0} style={{ fg: memberStatusColor(status(), teamStatus(), theme) }}>
                              •
                            </text>
                            <text fg={theme.text} wrapMode="none">
                              {Locale.truncate(member.title, 34)}
                            </text>
                            <text fg={theme.textMuted}>({memberStatusLabel(status(), teamStatus())})</text>
                            <Show when={pending() > 0}>
                              <text fg={theme.accent}>▲ {pending()} pending</text>
                            </Show>
                          </box>
                        )
                      }}
                    </For>

                    <Show when={permissions().length > 0 || questions().length > 0}>
                      <box {...SplitBorder} border={["top"]} borderColor={theme.border} paddingTop={1}>
                        <text fg={theme.text} attributes={TextAttributes.BOLD}>
                          Pending ({permissions().length + questions().length})
                        </text>
                      </box>
                      <For each={permissions()}>
                        {(item) => (
                          <box flexDirection="row" gap={1}>
                            <text flexShrink={0} style={{ fg: theme.warning }}>
                              !
                            </text>
                            <text fg={theme.text} wrapMode="none">
                              {Locale.truncate(
                                `Permission: ${item.permission} - ${item.patterns?.join(", ") ?? ""}`,
                                72,
                              )}
                            </text>
                          </box>
                        )}
                      </For>
                      <For each={questions()}>
                        {(item) => (
                          <box flexDirection="row" gap={1}>
                            <text flexShrink={0} style={{ fg: theme.warning }}>
                              ?
                            </text>
                            <text fg={theme.text} wrapMode="none">
                              {Locale.truncate(
                                `Questions: ${item.questions?.map((q) => q.question).join(", ") ?? ""}`,
                                72,
                              )}
                            </text>
                          </box>
                        )}
                      </For>
                    </Show>

                    <box {...SplitBorder} border={["top"]} borderColor={theme.border} paddingTop={1}>
                      <box onMouseUp={() => void shutdown()}>
                        <text fg={theme.error}>Shutdown Team</text>
                      </box>
                    </box>
                  </box>
                </Show>

                <Show when={tab() === "tasks"}>
                  <Show when={!tasks.loading} fallback={<text fg={theme.textMuted}>◐ Loading team tasks...</text>}>
                    <Show
                      when={!tasks.error}
                      fallback={
                        <text fg={theme.error} onMouseUp={() => void refetchTasks()}>
                          ✕ Team tasks unavailable · r retry
                        </text>
                      }
                    >
                      <Show
                        when={(tasks()?.length ?? 0) > 0}
                        fallback={<text fg={theme.textMuted}>○ No tasks created yet.</text>}
                      >
                        <For
                          each={
                            [
                              ["working", "◐ WORKING", theme.warning],
                              ["blocked", "○ DEPENDENCY BLOCKED", theme.info],
                              ["needs-you", "▲ WAITING ON YOU", theme.accent],
                              ["idle", "○ IDLE", theme.textMuted],
                              ["errored", "✕ ERRORED", theme.error],
                              ["completed", "✓ COMPLETED", theme.success],
                            ] as const
                          }
                        >
                          {([group, label, color]) => (
                            <Show when={taskGroups()[group].length > 0}>
                              <box gap={1} paddingBottom={1}>
                                <text fg={color} attributes={TextAttributes.BOLD}>
                                  {label} · {taskGroups()[group].length}
                                </text>
                                <For each={taskGroups()[group]}>
                                  {(task) => (
                                    <box
                                      border
                                      borderColor={group === "working" ? theme.warning : theme.borderSubtle}
                                      paddingLeft={1}
                                      paddingRight={1}
                                    >
                                      <box flexDirection="row" gap={1} minWidth={0}>
                                        <text flexShrink={0} fg={taskStatusColor(task.status, theme)}>
                                          {group === "working"
                                            ? "◐"
                                            : group === "needs-you"
                                              ? "▲"
                                              : group === "completed"
                                                ? "✓"
                                                : group === "errored"
                                                  ? "✕"
                                                  : "○"}
                                        </text>
                                        <text fg={theme.text} wrapMode="none">
                                          <b>{Locale.truncate(task.assignee ?? "unassigned", 28)}</b>
                                        </text>
                                        <text flexGrow={1} />
                                        <Show
                                          when={
                                            taskPending(task.assignee) > 0 &&
                                            (task.status === "in_progress" || task.status === "working")
                                          }
                                        >
                                          <text fg={theme.accent}>▲ {taskPending(task.assignee)} pending</text>
                                        </Show>
                                      </box>
                                      <text fg={theme.textMuted} wrapMode="none">
                                        {Locale.truncate(task.description, 72)}
                                      </text>
                                      <Show when={task.dependency_ids?.length}>
                                        <text fg={theme.textFaint} wrapMode="none">
                                          waits on {Locale.truncate(task.dependency_ids!.join(" · "), 62)}
                                        </text>
                                      </Show>
                                      <box flexDirection="row" gap={2}>
                                        <text fg={theme.textFaint}>{task.status}</text>
                                      </box>
                                    </box>
                                  )}
                                </For>
                              </box>
                            </Show>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </Show>
                </Show>

                <Show when={tab() === "messages"}>
                  <Show
                    when={!messages.loading}
                    fallback={<text fg={theme.textMuted}>◐ Loading team messages...</text>}
                  >
                    <Show
                      when={!messages.error}
                      fallback={
                        <text fg={theme.error} onMouseUp={() => void refetchMessages()}>
                          ✕ Team messages unavailable · r retry
                        </text>
                      }
                    >
                      <Show
                        when={(messages()?.length ?? 0) > 0}
                        fallback={<text fg={theme.textMuted}>○ No messages exchanged yet.</text>}
                      >
                        <For each={messages()!}>
                          {(msg) => (
                            <box gap={0} paddingBottom={1}>
                              <box flexDirection="row" gap={1}>
                                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                                  {msg.sender}
                                </text>
                                <text fg={theme.textMuted}>→ [{msg.recipients.join(", ")}]</text>
                                <text flexShrink={0} style={{ fg: deliveryStatusColor(msg.delivery_status, theme) }}>
                                  {msg.delivery_status}
                                </text>
                              </box>
                              <text fg={theme.text} wrapMode="none">
                                {Locale.truncate(msg.body, 72)}
                              </text>
                            </box>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </Show>
                </Show>
              </>
            )
          }}
        </Show>
      </Show>
    </box>
  )
}
