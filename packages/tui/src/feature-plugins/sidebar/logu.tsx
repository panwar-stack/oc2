import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Spinner } from "../../component/spinner"
import { isLoguChildSession, loguChildLabel } from "../../util/logu"
import { isRecord } from "../../util/record"

const id = "internal:sidebar-logu"

function statusLabel(status: { type: string } | undefined) {
  if (status?.type === "busy") return "working"
  if (status?.type === "retry") return "retry"
  return status?.type ?? "idle"
}

function statusColor(status: { type: string } | undefined, theme: TuiPluginApi["theme"]["current"]) {
  if (status?.type === "busy") return theme.success
  if (status?.type === "retry") return theme.error
  return theme.textMuted
}

function loguIndex(session: Session) {
  const metadata = isRecord(session.metadata) ? session.metadata : undefined
  if (!isRecord(metadata?.logu) || typeof metadata.logu.index !== "number") return 0
  return metadata.logu.index
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const children = createMemo(() =>
    props.api.state.session
      .children(props.session_id)
      .flatMap((child) => {
        const session = props.api.state.session.get(child.id)
        return isLoguChildSession(session) ? [session] : []
      })
      .toSorted((a, b) => loguIndex(a) - loguIndex(b) || a.title.localeCompare(b.title)),
  )
  const pending = createMemo(() =>
    children().reduce(
      (count, child) => count + props.api.state.session.permission(child.id).length + props.api.state.session.question(child.id).length,
      0,
    ),
  )

  return (
    <Show when={children().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => children().length > 2 && setOpen((value) => !value)}>
          <Show when={children().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Logu</b>
            <span style={{ fg: theme().textMuted }}>
              {" "}
              ({children().length} session{children().length !== 1 ? "s" : ""})
            </span>
            <Show when={pending() > 0}>
              <span style={{ fg: theme().warning }}> [{pending()} pending]</span>
            </Show>
          </text>
        </box>
        <Show when={children().length <= 2 || open()}>
          <For each={children()}>
            {(child) => {
              const [hover, setHover] = createSignal(false)
              const status = createMemo(() => props.api.state.session.status(child.id))
              const childPending = createMemo(
                () => props.api.state.session.permission(child.id).length + props.api.state.session.question(child.id).length,
              )

              return (
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseOver={() => setHover(true)}
                  onMouseOut={() => setHover(false)}
                  onMouseDown={() => props.api.route.navigate("session", { sessionID: child.id })}
                  backgroundColor={hover() ? theme().backgroundElement : undefined}
                >
                  <Show
                    when={status()?.type === "busy"}
                    fallback={
                      <text flexShrink={0} fg={statusColor(status(), theme())}>
                        •
                      </text>
                    }
                  >
                    <box flexShrink={0}>
                      <Spinner color={statusColor(status(), theme())} />
                    </box>
                  </Show>
                  <text fg={theme().textMuted}>{loguChildLabel(child) ?? child.title}</text>
                  <text fg={theme().textMuted}>({statusLabel(status())})</text>
                  <Show when={childPending() > 0}>
                    <text fg={theme().warning}>[{childPending()} pending]</text>
                  </Show>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 340,
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
