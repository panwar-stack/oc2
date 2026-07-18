import { For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { SplitBorder } from "../ui/border"

export function TranscriptUserMessage(props: {
  id: string
  text: string
  marginTop?: number
  attachments?: ReadonlyArray<{ kind: string; name: string }>
  meta?: string
  queued?: boolean
  onMouseUp?: () => void
}) {
  const { theme } = useTheme()
  return (
    <box
      id={props.id}
      border={["left"]}
      borderColor={theme.primary}
      customBorderChars={SplitBorder.customBorderChars}
      marginTop={props.marginTop ?? 0}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      backgroundColor={theme.backgroundElement}
      flexShrink={0}
      onMouseUp={props.onMouseUp}
    >
      <text fg={theme.text}>{props.text}</text>
      <Show when={props.attachments?.length}>
        <box flexDirection="row" paddingTop={1} gap={1} flexWrap="wrap">
          <For each={props.attachments}>
            {(attachment) => (
              <text>
                <span style={{ fg: theme.primary }}>▤ {attachment.kind}</span>
                <span style={{ fg: theme.textMuted }}> {attachment.name}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
      <text fg={props.queued ? theme.warning : theme.textMuted} wrapMode="none">
        you
        <Show when={props.meta}>{(value) => <span> · {value()}</span>}</Show>
        <Show when={props.attachments?.length}>
          <span> · ▤ {props.attachments!.length} attached</span>
        </Show>
        <Show when={props.queued}>
          <span> · ○ queued</span>
        </Show>
      </text>
    </box>
  )
}
