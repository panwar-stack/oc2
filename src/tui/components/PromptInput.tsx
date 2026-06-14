export function PromptInput({ value, running }: { readonly value: string; readonly running: boolean }): string {
  return `${running ? "Running" : "Prompt"}> ${value}`
}
