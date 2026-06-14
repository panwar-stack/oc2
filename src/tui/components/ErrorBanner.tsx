import type { TuiState } from "../state"

export function ErrorBanner({ state }: { readonly state: TuiState }): string {
  return state.errors.length ? `Error: ${state.errors.at(-1)}` : ""
}
