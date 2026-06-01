import { createMemo, createResource } from "solid-js"
import type { SupervisorMode, SupervisorReviewCadence, SupervisorSettingsPatch, SupervisorState } from "@opencode-ai/sdk/v2"
import { errorMessage } from "../../util/error"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useToast } from "../../ui/toast"

type SupervisorAction =
  | { type: "mode" }
  | { type: "insert" }
  | { type: "model" }
  | { type: "variant" }
  | { type: "cadence" }
  | { type: "number"; key: NumberKey; title: string }
  | { type: "reset" }

type NumberKey =
  | "recommendation_timeout_ms"
  | "min_review_interval_ms"
  | "max_recommendation_chars"
  | "max_repeated_command_failures"
  | "broad_diff_file_limit"
  | "max_recommendations_per_session"

const numberFields: { key: NumberKey; title: string; description: string }[] = [
  { key: "recommendation_timeout_ms", title: "Set recommendation timeout", description: "Model wait time in ms" },
  { key: "min_review_interval_ms", title: "Set minimum review interval", description: "Smallest gap between reviews in ms" },
  { key: "max_recommendation_chars", title: "Set recommendation length", description: "Maximum inserted recommendation chars" },
  { key: "max_repeated_command_failures", title: "Set repeated failure limit", description: "Failures before the supervisor reacts" },
  { key: "broad_diff_file_limit", title: "Set broad diff file limit", description: "Touched files considered broad" },
  { key: "max_recommendations_per_session", title: "Set session recommendation limit", description: "Maximum recommendations per session" },
]

export function DialogSupervisor(props: { sessionID: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const [state, { refetch }] = createResource(
    () => props.sessionID,
    async (sessionID) => {
      const result = await sdk.client.session.supervisor.get({ sessionID }, { throwOnError: true })
      return result.data
    },
  )
  const effective = createMemo(() => state()?.config.effective)
  const fallback = createMemo(() => session()?.supervisor)
  const options = createMemo<DialogSelectOption<SupervisorAction>[]>(() => [
    {
      title: `Mode: ${effective()?.mode ?? fallback()?.mode ?? "loading"}`,
      value: { type: "mode" },
      category: "Actions",
      description: `Supervisor behavior (${source(state(), "mode", fallback()?.mode)})`,
    },
    {
      title: `Insert recommendations: ${formatBool(effective()?.insert_recommendations ?? fallback()?.insert_recommendations)}`,
      value: { type: "insert" },
      category: "Actions",
      description: `Toggle inserting supervisor advice into the session (${source(state(), "insert_recommendations", fallback()?.insert_recommendations)})`,
    },
    {
      title: `Recommendation model: ${effective()?.recommendation_model ?? fallback()?.recommendation_model ?? "default"}`,
      value: { type: "model" },
      category: "Runtime",
      description: `Provider/model used for recommendations (${source(state(), "recommendation_model", fallback()?.recommendation_model)})`,
    },
    {
      title: `Recommendation variant: ${effective()?.recommendation_variant ?? fallback()?.recommendation_variant ?? "default"}`,
      value: { type: "variant" },
      category: "Runtime",
      description: `Model variant used for recommendations (${source(state(), "recommendation_variant", fallback()?.recommendation_variant)})`,
    },
    {
      title: `Review cadence: ${effective()?.review_cadence ?? fallback()?.review_cadence ?? "loading"}`,
      value: { type: "cadence" },
      category: "Runtime",
      description: `When supervisor reviews run (${source(state(), "review_cadence", fallback()?.review_cadence)})`,
    },
    ...numberFields.map((field) => ({
      title: `${field.title}: ${effective()?.[field.key] ?? fallback()?.[field.key] ?? "loading"}`,
      value: { type: "number" as const, key: field.key, title: field.title },
      category: "Limits",
      description: `${field.description} (${source(state(), field.key, fallback()?.[field.key])})`,
    })),
    {
      title: "Reset session overrides",
      value: { type: "reset" },
      category: "Reset",
      description: "Return this session to global supervisor settings",
      disabled: state.loading,
    },
  ])

  async function update(patch: SupervisorSettingsPatch, message: string) {
    try {
      await sdk.client.session.supervisor.update(
        { sessionID: props.sessionID, supervisorSettingsPatch: patch },
        { throwOnError: true },
      )
      await refetch()
      toast.show({ message, variant: "success" })
    } catch (error) {
      toast.show({ message: errorMessage(error), variant: "error" })
    }
    dialog.replace(() => <DialogSupervisor sessionID={props.sessionID} />)
  }

  function selectMode() {
    dialog.replace(() => (
      <DialogSelect
        title="Supervisor Mode"
        options={(["off", "observe", "advise"] as const).map((mode) => ({
          title: mode,
          value: mode,
          description: modeDescription(mode),
        }))}
        current={effective()?.mode}
        onSelect={(option) => void update({ mode: option.value }, "Supervisor mode updated")}
      />
    ))
  }

  async function editModel() {
    const value = await DialogPrompt.show(dialog, "Recommendation Model", {
      value: effective()?.recommendation_model ?? fallback()?.recommendation_model ?? "",
      placeholder: "provider/model",
    })
    if (value === null) return
    await update({ recommendation_model: value.trim() || null }, "Recommendation model updated")
  }

  async function editVariant() {
    const value = await DialogPrompt.show(dialog, "Recommendation Variant", {
      value: effective()?.recommendation_variant ?? fallback()?.recommendation_variant ?? "",
      placeholder: "variant",
    })
    if (value === null) return
    await update({ recommendation_variant: value.trim() || null }, "Recommendation variant updated")
  }

  function selectCadence() {
    dialog.replace(() => (
      <DialogSelect
        title="Review Cadence"
        options={(["step", "event", "idle"] as const).map((cadence) => ({
          title: cadence,
          value: cadence,
          description: cadenceDescription(cadence),
        }))}
        current={effective()?.review_cadence}
        onSelect={(option) => void update({ review_cadence: option.value }, "Review cadence updated")}
      />
    ))
  }

  async function editNumber(field: Extract<SupervisorAction, { type: "number" }>) {
    const value = await DialogPrompt.show(dialog, field.title, {
      value: String(effective()?.[field.key] ?? fallback()?.[field.key] ?? ""),
      placeholder: "Positive integer",
    })
    if (value === null) return
    const parsed = Number(value.trim())
    if (!Number.isInteger(parsed) || parsed <= 0) {
      toast.show({ message: "Enter a positive integer", variant: "error" })
      dialog.replace(() => <DialogSupervisor sessionID={props.sessionID} />)
      return
    }
    await update({ [field.key]: parsed }, "Supervisor setting updated")
  }

  async function reset() {
    const ok = await DialogConfirm.show(dialog, "Reset Supervisor", "Reset all supervisor overrides for this session?")
    if (ok !== true) return
    await update({ reset: true }, "Supervisor overrides reset")
  }

  return (
    <DialogSelect
      title="Supervisor"
      options={options()}
      onSelect={(option) => {
        if (option.value.type === "mode") selectMode()
        if (option.value.type === "insert")
          void update(
            { insert_recommendations: !(effective()?.insert_recommendations ?? fallback()?.insert_recommendations ?? true) },
            "Recommendation insertion updated",
          )
        if (option.value.type === "model") void editModel()
        if (option.value.type === "variant") void editVariant()
        if (option.value.type === "cadence") selectCadence()
        if (option.value.type === "number") void editNumber(option.value)
        if (option.value.type === "reset") void reset()
      }}
    />
  )
}

function source(state: SupervisorState | undefined, key: keyof SupervisorSettingsPatch, fallback: unknown) {
  if (state?.config.session && key in state.config.session) return "session"
  if (state) return "global"
  if (fallback !== undefined) return "session override"
  return "loading"
}

function formatBool(value: boolean | undefined) {
  if (value === undefined) return "loading"
  return value ? "on" : "off"
}

function modeDescription(mode: SupervisorMode) {
  if (mode === "off") return "Disable supervisor checks"
  if (mode === "observe") return "Track risk without advice insertion"
  return "Recommend course corrections"
}

function cadenceDescription(cadence: SupervisorReviewCadence) {
  if (cadence === "step") return "Review after each assistant step"
  if (cadence === "event") return "Review around notable session events"
  return "Review while the session is idle"
}
