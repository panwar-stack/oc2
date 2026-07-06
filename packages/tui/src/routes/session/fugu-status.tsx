import { createMemo, For, Show } from "solid-js"
import type { EventSessionNextFuguStatus } from "@oc2-ai/sdk/v2"
import { useTheme } from "../../context/theme"

export function FuguStatusBlock(props: { status: EventSessionNextFuguStatus["properties"] }) {
  const { theme } = useTheme()
  const complete = createMemo(() => props.status.branches.filter((branch) => branch.status === "complete").length)
  const phase = createMemo(() => {
    const workingBranch = props.status.branches.find((branch) => branch.status === "working")
    if (workingBranch) return `branch ${workingBranch.index + 1} working`
    if (props.status.judge?.status === "working") return "judge working"
    if (props.status.synthesizer.status === "working") return "synthesizer working"
    return fuguLabel(props.status.phase)
  })

  return (
    <box paddingLeft={3} marginTop={1} flexDirection="column">
      <text fg={theme.textMuted} wrapMode="none">
        Fugu · {complete()}/{props.status.branches.length} branches complete · {phase()}
      </text>
      <For each={props.status.branches}>
        {(branch) => (
          <text fg={theme.textMuted} wrapMode="none">
            Branch {branch.index + 1} · {fuguLabel(branch.status)}
          </text>
        )}
      </For>
      <Show when={props.status.judge}>
        {(judge) => (
          <text fg={theme.textMuted} wrapMode="none">
            Judge · {fuguLabel(judge().status)}
          </text>
        )}
      </Show>
      <text fg={theme.textMuted} wrapMode="none">
        Synthesizer · {fuguLabel(props.status.synthesizer.status)}
      </text>
    </box>
  )
}

function fuguLabel(value: string) {
  if (value === "pending") return "idle"
  return value.replaceAll("_", " ")
}
