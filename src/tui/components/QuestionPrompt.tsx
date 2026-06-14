import type { TuiState } from "../state"

export function QuestionPrompt({ state }: { readonly state: TuiState }): string {
  const prompt = state.questionPrompt
  if (!prompt) return ""
  const options = prompt.options.length
    ? prompt.options.map((option) => `- ${option.label}${option.description ? `: ${option.description}` : ""}`)
    : ["- Type an answer in the prompt."]
  return [
    prompt.header ? `Question: ${prompt.header}` : "Question:",
    prompt.question,
    prompt.multiple ? "Select one or more:" : "Select one:",
    ...options,
  ].join("\n")
}
