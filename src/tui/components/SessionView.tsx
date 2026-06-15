import { ErrorBanner } from "./ErrorBanner"
import { Footer } from "./Footer"
import { MessageList } from "./MessageList"
import { ModelPicker } from "./ModelPicker"
import { PromptInput } from "./PromptInput"
import { QuestionPrompt } from "./QuestionPrompt"
import { SidePanel } from "./SidePanel"
import { SlashSuggestions } from "./SlashSuggestions"
import type { TuiState } from "../state"

export interface SessionViewOptions {
  readonly width?: number
}

export function SessionView({
  state,
  input,
  options,
}: {
  readonly state: TuiState
  readonly input: string
  readonly options?: SessionViewOptions
}): string {
  const showSidePanel =
    !state.modelPickerOpen &&
    !state.slashActive &&
    state.sidePanel &&
    (options?.width === undefined || options.width >= 80)
  return [
    "oc2 tui",
    ErrorBanner({ state }),
    MessageList({ state }),
    ModelPicker({ state, width: options?.width }),
    !showSidePanel && state.questionPrompt ? QuestionPrompt({ state }) : "",
    showSidePanel ? "\n--- side panel ---\n" + SidePanel({ state }) : "",
    "",
    PromptInput({ value: input, running: state.running }),
    SlashSuggestions({
      matches: state.slashMatches,
      width: options?.width,
      active: !state.modelPickerOpen && state.slashActive,
    }),
    Footer({ state }),
  ]
    .filter((line) => line.length > 0)
    .join("\n")
}
