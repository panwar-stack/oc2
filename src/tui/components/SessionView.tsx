import { ErrorBanner } from "./ErrorBanner"
import { Footer } from "./Footer"
import { MessageList } from "./MessageList"
import { PromptInput } from "./PromptInput"
import { SidePanel } from "./SidePanel"
import type { TuiState } from "../state"

export function SessionView({ state, input }: { readonly state: TuiState; readonly input: string }): string {
  return [
    "oc2 tui",
    ErrorBanner({ state }),
    MessageList({ state }),
    state.sidePanel ? "\n--- side panel ---\n" + SidePanel({ state }) : "",
    "",
    PromptInput({ value: input, running: state.running }),
    Footer(),
  ]
    .filter((line) => line.length > 0)
    .join("\n")
}
