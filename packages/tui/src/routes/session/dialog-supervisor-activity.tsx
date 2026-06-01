import { createMemo, createResource, onMount } from "solid-js"
import type { SupervisorActivity, SupervisorState } from "@opencode-ai/sdk/v2"
import { errorMessage } from "../../util/error"
import { Locale } from "../../util/locale"
import { useSDK } from "../../context/sdk"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"

export function DialogSupervisorActivity(props: { sessionID: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [state] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      try {
        const result = await sdk.client.session.supervisor.get({ sessionID }, { throwOnError: true })
        return result.data
      } catch (error) {
        toast.show({ message: errorMessage(error), variant: "error" })
        return undefined
      }
    },
  )
  const [activity] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      try {
        const result = await sdk.client.session.supervisor.activity({ sessionID }, { throwOnError: true })
        return result.data ?? []
      } catch (error) {
        toast.show({ message: errorMessage(error), variant: "error" })
        return []
      }
    },
  )

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => [contextOption(state()), ...activityOptions(state(), activity())])

  return <DialogSelect title="Supervisor Activity" options={options()} onSelect={() => {}} />
}

function contextOption(state: SupervisorState | undefined): DialogSelectOption<string> {
  return {
    title: `Mode: ${state?.mode ?? "loading"}`,
    value: "context",
    category: "Context",
    description: `Status: ${state?.status ?? "loading"}`,
    details: state ? [`updated: ${Locale.time(state.updatedAt)}`] : undefined,
  }
}

function activityOptions(state: SupervisorState | undefined, activity: SupervisorActivity[] | undefined) {
  if (!activity) {
    return [
      {
        title: "Loading supervisor activity...",
        value: "loading",
        category: "Timeline",
      },
    ]
  }
  if (activity.length === 0) {
    return [
      {
        title:
          state?.mode === "off"
            ? "Supervisor is off. No new activity is being recorded."
            : "No supervisor activity yet.",
        value: "empty",
        category: "Timeline",
      },
    ]
  }
  return activity.toSorted((a, b) => b.time - a.time).map((item) => ({
    title: `${item.type}: ${item.title}`,
    value: item.id,
    category: "Timeline",
    description: summary(item),
    details: details(item),
    footer: Locale.time(item.time),
  }))
}

function summary(activity: SupervisorActivity) {
  return [activity.severity, activity.metadata?.action, activity.metadata?.trigger].filter(Boolean).join(" | ")
}

function details(activity: SupervisorActivity) {
  return [
    activity.message ? `message: ${bound(activity.message)}` : undefined,
    ...activity.evidence.slice(0, 3).map((item) => `evidence: ${bound(item)}`),
    ...metadataDetails(activity),
  ].filter((item): item is string => item !== undefined)
}

function metadataDetails(activity: SupervisorActivity) {
  const metadata = activity.metadata
  if (!metadata) return []
  return [
    metadata.file ? `file: ${bound(metadata.file)}` : undefined,
    metadata.command ? `command: ${bound(metadata.command)}` : undefined,
    metadata.exitCode !== undefined ? `exit: ${metadata.exitCode}` : undefined,
    metadata.validation !== undefined ? `validation: ${metadata.validation ? "yes" : "no"}` : undefined,
    metadata.repeatedFailureCount !== undefined ? `repeated failures: ${metadata.repeatedFailureCount}` : undefined,
    metadata.inserted !== undefined ? `inserted: ${metadata.inserted ? "yes" : "no"}` : undefined,
  ].filter((item): item is string => item !== undefined)
}

function bound(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= 180) return normalized
  return `${normalized.slice(0, 177)}...`
}
