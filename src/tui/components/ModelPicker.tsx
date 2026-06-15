import { filterModelOptions, type TuiModelOption, type TuiState, type TuiVariantOption } from "../state"

export function ModelPicker({ state, width }: { readonly state: TuiState; readonly width?: number }): string {
  if (!state.modelPickerOpen) return ""

  const pickerWidth = Math.max(24, width ?? 100)
  const rows =
    state.modelPickerMode === "model" ? renderModelRows(state, pickerWidth) : renderVariantRows(state, pickerWidth)
  const body = state.modelPickerLoading
    ? ["Loading models..."]
    : rows.length
      ? rows
      : [state.modelPickerMode === "model" ? emptyModelMessage(state) : "No variants for current model"]
  const footer = [state.modelPickerError, "Up/Down move | Enter select | Esc close | Ctrl+V cycle variant"]
    .filter((line): line is string => Boolean(line))
    .join("\n")

  return [
    "--- model picker ---",
    state.modelPickerMode === "model"
      ? "Select model"
      : `Select variant for ${state.modelSelection.providerId}/${state.modelSelection.modelId}`,
    `Search: ${state.modelPickerQuery}`,
    ...body,
    footer,
  ]
    .filter((line) => line.length > 0)
    .join("\n")
}

function renderModelRows(state: TuiState, width: number): readonly string[] {
  const options = filterModelOptions(state.modelOptions, state.modelPickerQuery).slice(0, 10)
  return options.map((option, index) => renderModelRow(option, index === state.modelPickerSelectedIndex, width))
}

function renderVariantRows(state: TuiState, width: number): readonly string[] {
  return state.variantOptions
    .slice(0, 10)
    .map((option, index) => renderVariantRow(option, index === state.modelPickerSelectedIndex, width))
}

function renderModelRow(option: TuiModelOption, selected: boolean, width: number): string {
  const prefix = selected ? "> " : "  "
  const display = `${option.providerName}/${option.model.name ?? option.model.id}`
  const id = `${option.providerId}/${option.model.id}`
  const tags = [option.model.supportsTools ? "[tools]" : "", option.model.supportsReasoning ? "[reasoning]" : ""]
    .filter(Boolean)
    .join(" ")
  return truncateLine(`${prefix}${display}  ${id}${tags ? `  ${tags}` : ""}`, width)
}

function renderVariantRow(option: TuiVariantOption, selected: boolean, width: number): string {
  const prefix = selected ? "> " : "  "
  return truncateLine(`${prefix}${option.label}${option.description ? `  ${option.description}` : ""}`, width)
}

function emptyModelMessage(state: TuiState): string {
  if (state.modelProviderCount === 0) return "No providers configured"
  if (state.modelOptions.length === 0) return "No models available"
  return "No matching models"
}

function truncateLine(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 3) return ".".repeat(width)
  return `${value.slice(0, width - 3)}...`
}
