import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@oc2-ai/plugin/tui"
import { useSync } from "../../context/sync"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Spinner } from "../../component/spinner"
import { SidebarSectionHeader } from "../../routes/session/sidebar-sections"
import { Locale } from "../../util/locale"

const id = "internal:sidebar-team"

function memberStatusDot(
  status: { type: string } | undefined,
  teamStatus: { status: string; lifecycle?: string; daemonState?: string | null } | undefined,
  theme: TuiPluginApi["theme"]["current"],
) {
  const t = status?.type
  if (t === "retry") return theme.error
  if (t === "busy") return theme.success
  if (teamStatus?.status === "completed") return theme.success
  if (teamStatus?.status === "cancelled") return theme.error
  if (["starting", "blocked", "active", "idle"].includes(teamStatus?.status ?? "")) return theme.info
  return theme.textMuted
}

export function statusLabel(
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

export function isMemberWorking(
  status: { type: string } | undefined,
  teamStatus: { status: string; lifecycle?: string; daemonState?: string | null } | undefined,
) {
  if (status?.type === "busy" || status?.type === "retry") return true
  return teamStatus?.status === "starting"
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const sync = useSync()
  const theme = () => props.api.theme.current
  const teamsEnabled = createMemo(() => props.api.state.config.experimental?.agent_teams === true)
  const members = createMemo(() =>
    teamsEnabled()
      ? props.api.state.session
          .children(props.session_id)
          .filter((member) => sync.data.team_member_status[member.id] !== undefined)
      : [],
  )
  type Member = ReturnType<typeof members>[number]
  const memberPending = (member: Member) =>
    props.api.state.session.permission(member.id).length + props.api.state.session.question(member.id).length
  const grouped = createMemo(() =>
    members().reduce(
      (result, member) => {
        const status = props.api.state.session.status(member.id)
        const teamStatus = sync.data.team_member_status[member.id]
        const label = statusLabel(status, teamStatus)
        if (memberPending(member) > 0) result.attention.push(member)
        else if (isMemberWorking(status, teamStatus)) result.working.push(member)
        else if (label === "completed") result.completed.push(member)
        else if (label === "cancelled") result.failed.push(member)
        else result.idle.push(member)
        return result
      },
      {
        working: [] as Member[],
        idle: [] as Member[],
        completed: [] as Member[],
        attention: [] as Member[],
        failed: [] as Member[],
      },
    ),
  )

  const pendingPermissions = createMemo(() => {
    if (!teamsEnabled()) return 0
    return members().reduce(
      (count, member) =>
        count +
        props.api.state.session.permission(member.id).length +
        props.api.state.session.question(member.id).length,
      0,
    )
  })

  return (
    <Show when={teamsEnabled()}>
      <box>
        <box onMouseDown={() => members().length > 2 && setOpen((x) => !x)}>
          <SidebarSectionHeader
            title="Team"
            detail={`${members().length}${pendingPermissions() ? ` · ▲ ${pendingPermissions()}` : ""}`}
            detailColor={pendingPermissions() ? theme().accent : undefined}
          />
        </box>
        <Show when={!props.api.state.ready}>
          <Spinner color={theme().textMuted}>Loading team members...</Spinner>
        </Show>
        <Show when={props.api.state.ready && members().length === 0}>
          <text fg={theme().textMuted}>No team members. Use team_create then team_spawn to add members.</text>
        </Show>
        <Show when={members().length > 0 && (members().length <= 2 || open())}>
          <box flexDirection="row" gap={1}>
            <text fg={theme().warning}>◐</text>
            <text fg={theme().warning}>Working · {grouped().working.length}</text>
          </box>
          <For each={grouped().working}>
            {(member) => {
              const [hover, setHover] = createSignal(false)
              const status = createMemo(() => props.api.state.session.status(member.id))
              const teamStatus = createMemo(() => sync.data.team_member_status[member.id])
              const statusColor = createMemo(() => memberStatusDot(status(), teamStatus(), theme()))

              const memberPerms = createMemo(() => {
                const permCount = props.api.state.session.permission(member.id).length
                const questionCount = props.api.state.session.question(member.id).length
                return permCount + questionCount
              })

              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={2}
                  onMouseOver={() => setHover(true)}
                  onMouseOut={() => setHover(false)}
                  onMouseDown={() => {
                    if (member.id !== props.session_id) {
                      props.api.route.navigate("session", { sessionID: member.id })
                    }
                  }}
                  backgroundColor={hover() ? theme().backgroundElement : undefined}
                >
                  <Show
                    when={isMemberWorking(status(), teamStatus())}
                    fallback={
                      <text
                        flexShrink={0}
                        style={{
                          fg: statusColor(),
                        }}
                      >
                        •
                      </text>
                    }
                  >
                    <box flexShrink={0}>
                      <Spinner color={statusColor()} />
                    </box>
                  </Show>
                  <text fg={theme().textMuted} wrapMode="none">
                    {Locale.truncate(member.title, memberPerms() ? 14 : 22)}
                  </text>
                  <Show when={memberPerms() > 0}>
                    <text style={{ fg: theme().warning }}>[{memberPerms()} pending]</text>
                  </Show>
                </box>
              )
            }}
          </For>
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>○</text>
            <text fg={theme().textMuted}>Idle · {grouped().idle.length}</text>
          </box>
          <Show when={grouped().attention.length > 0}>
            <box flexDirection="row" gap={1}>
              <text fg={theme().accent}>▲</text>
              <text fg={theme().accent}>Needs you · {grouped().attention.length}</text>
            </box>
          </Show>
          <Show when={grouped().failed.length > 0}>
            <box flexDirection="row" gap={1}>
              <text fg={theme().error}>✕</text>
              <text fg={theme().error}>Failed · {grouped().failed.length}</text>
            </box>
          </Show>
          <box flexDirection="row" gap={1}>
            <text fg={theme().success}>✓</text>
            <text fg={theme().success}>Completed · {grouped().completed.length}</text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
