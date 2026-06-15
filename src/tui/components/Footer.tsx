import { TUI_KEYMAP } from "../keymap"
import type { TuiState } from "../state"

export function Footer({ state }: { readonly state: TuiState }): string {
  const model = `${state.modelSelection.providerId}/${state.modelSelection.modelId}${state.modelSelection.variantId ? `:${state.modelSelection.variantId}` : ""}`
  return `${TUI_KEYMAP.submit} submit | Ctrl+P model | Ctrl+V variant | ${TUI_KEYMAP.toggleSidePanel} side panel | ${TUI_KEYMAP.toggleTeamPanel} team | ${TUI_KEYMAP.toggleMcpPanel}/empty Enter mcp | ${TUI_KEYMAP.escape} close | ${TUI_KEYMAP.cancel} cancel/exit | model ${model}`
}
