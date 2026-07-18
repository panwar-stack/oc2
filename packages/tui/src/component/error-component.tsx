import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { getScrollAcceleration } from "../util/scroll"
import { useClipboard } from "../context/clipboard"
import { InstallationVersion } from "@oc2-ai/core/installation/version"
import { destroyRenderer } from "../util/renderer"
import { DEFAULT_THEMES, resolveTheme, selectedForeground } from "../theme"
import { StateBlock } from "./state-block"

export function ErrorComponent(props: { error: Error; reset: () => void; mode?: "dark" | "light" }) {
  const term = useTerminalDimensions()
  const renderer = useRenderer()
  const clipboard = useClipboard()
  const theme = resolveTheme(DEFAULT_THEMES.oc2, props.mode ?? "dark")
  const selectedText = selectedForeground(theme, theme.primary)

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      destroyRenderer(renderer)
    }
  })
  const [copied, setCopied] = createSignal(false)

  const issueURL = new URL("https://github.com/panwar-stack/oc2/issues/new?template=bug-report.yml")

  if (props.error.message) {
    issueURL.searchParams.set("title", `opentui: fatal: ${props.error.message}`)
  }

  if (props.error.stack) {
    issueURL.searchParams.set(
      "description",
      "```\n" + props.error.stack.substring(0, 6000 - issueURL.toString().length) + "...\n```",
    )
  }

  issueURL.searchParams.set("opencode-version", InstallationVersion)

  const copyIssueURL = () => {
    void clipboard.write?.(issueURL.toString()).then(() => {
      setCopied(true)
    })
  }

  return (
    <box
      width={term().width}
      height={term().height}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      gap={1}
      backgroundColor={theme.background}
    >
      <box width={Math.max(1, Math.min(60, term().width - 2))} flexDirection="column" gap={1}>
        <StateBlock
          theme={theme}
          variant="error"
          title="A fatal error occurred"
          description={props.error.message || "The TUI could not continue."}
          scale="full"
          action={
            <box onMouseUp={props.reset} backgroundColor={theme.primary} paddingLeft={1} paddingRight={1}>
              <text attributes={TextAttributes.BOLD} fg={selectedText}>
                Reset TUI
              </text>
            </box>
          }
          hint={
            <text fg={theme.textFaint} onMouseUp={() => destroyRenderer(renderer)}>
              ctrl+c exit
            </text>
          }
        />
        <Show when={term().height >= 12 && term().width >= 30}>
          <box flexDirection={term().width < 50 ? "column" : "row"} gap={1} alignItems="center" flexShrink={0}>
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              Please report this issue.
            </text>
            <box onMouseUp={copyIssueURL} backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
              <text fg={theme.text}>{term().width < 50 ? "Copy issue" : "Copy issue URL"}</text>
            </box>
            {copied() && <text fg={theme.success}>✓ Copied</text>}
          </box>
        </Show>
        <Show when={term().height >= 18}>
          <scrollbox flexGrow={1} minHeight={1} scrollAcceleration={getScrollAcceleration()}>
            <text fg={theme.textMuted}>{props.error.stack}</text>
          </scrollbox>
        </Show>
      </box>
    </box>
  )
}
