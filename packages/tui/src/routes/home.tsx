import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, For, Show, onMount } from "solid-js"
import { useSync } from "../context/sync"
import { useArgs } from "../context/args"
import { useRoute, useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { usePluginRuntime } from "../plugin/runtime"
import { useEditorContext } from "../context/editor"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import {
  HOME_ALL_SESSIONS_KEY,
  HomeSessionDestinationProvider,
  homeSessionMeta,
  nextHomeSessionCursor,
  recentHomeRootSessions,
} from "./home/session-destination"
import { useTheme, selectedForeground } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { StateBlock } from "../component/state-block"
import { InstallationVersion } from "@oc2-ai/core/installation/version"
import { TextAttributes } from "@opentui/core"
import type { Session } from "@oc2-ai/sdk/v2"
import { Locale } from "../util/locale"
import { useOpencodeKeymap } from "../keymap"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const pluginRuntime = usePluginRuntime()
  const sync = useSync()
  const route = useRouteData("home")
  const router = useRoute()
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const dialog = useDialog()
  const keymap = useOpencodeKeymap()
  const { theme } = useTheme()
  const recent = createMemo(() => recentHomeRootSessions(sync.data.session))
  const [cursor, setCursor] = createSignal(0)
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? 75
  })
  let sent = false

  const resume = (session: Session | undefined) => {
    if (!session) return
    router.navigate({ type: "session", sessionID: session.id })
  }

  const showAll = () => {
    keymap.dispatchCommand("session.list")
  }

  useKeyboard((event) => {
    if (dialog.stack.length > 0) return
    if (event.ctrl && !event.meta && !event.shift && !event.option && event.name === "o") {
      event.preventDefault()
      event.stopPropagation()
      showAll()
      return
    }
    if (ref()?.current.input.trim()) return
    if (event.name === "up" || event.name === "down") {
      if (recent().length === 0) return
      event.preventDefault()
      event.stopPropagation()
      setCursor((current) => nextHomeSessionCursor(current, event.name === "down" ? 1 : -1, recent().length))
      return
    }
    if (event.name !== "return") return
    const session = recent()[cursor()]
    if (!session) return
    event.preventDefault()
    event.stopPropagation()
    resume(session)
  })

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  createEffect(() => {
    const count = recent().length
    if (count === 0 || cursor() < count) return
    setCursor(count - 1)
  })

  return (
    <HomeSessionDestinationProvider>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <pluginRuntime.Slot name="home_logo" mode="replace">
            <HomeIdentity theme={theme} ready={sync.status === "complete"} updatePolicy={sync.data.config.autoupdate} />
          </pluginRuntime.Slot>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt ref={bind} right={<pluginRuntime.Slot name="home_prompt_right" />} placeholders={placeholder} />
          </pluginRuntime.Slot>
        </box>
        <box width="100%" maxWidth={promptMaxWidth()} paddingTop={2} flexShrink={0}>
          <HomeRecentSessions
            theme={theme}
            loading={sync.status === "loading" || (sync.status !== "complete" && recent().length === 0)}
            sessions={recent()}
            total={sync.data.session.filter((session) => session.parentID === undefined).length}
            cursor={cursor()}
            metaWidth={Math.max(
              12,
              Math.min(32, Math.floor(Math.min(promptMaxWidth(), dimensions().width - 4) * 0.42)),
            )}
            status={(sessionID) => sync.data.session_status[sessionID]?.type}
            onCursor={setCursor}
            onResume={resume}
            onShowAll={showAll}
          />
        </box>
        <pluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}

function HomeIdentity(props: {
  theme: ReturnType<typeof useTheme>["theme"]
  ready: boolean
  updatePolicy?: boolean | "notify"
}) {
  const status = () => {
    if (!props.ready) return { glyph: "◐", label: "syncing", color: props.theme.warning }
    if (props.updatePolicy === false) return { glyph: "○", label: "updates off", color: props.theme.textFaint }
    if (props.updatePolicy === true) return { glyph: "●", label: "auto-update on", color: props.theme.success }
    return { glyph: "●", label: "update checks on", color: props.theme.success }
  }
  return (
    <box flexDirection="row" alignItems="center" gap={1}>
      <box backgroundColor={props.theme.primary} paddingLeft={1} paddingRight={1}>
        <text fg={selectedForeground(props.theme, props.theme.primary)} attributes={TextAttributes.BOLD}>
          {">_"}
        </text>
      </box>
      <text fg={props.theme.text} attributes={TextAttributes.BOLD}>
        OC2
      </text>
      <text fg={props.theme.textFaint} wrapMode="none">
        v{InstallationVersion} ·{" "}
        <span style={{ fg: status().color }}>
          {status().glyph} {status().label}
        </span>
      </text>
    </box>
  )
}

function HomeRecentSessions(props: {
  theme: ReturnType<typeof useTheme>["theme"]
  loading: boolean
  sessions: Session[]
  total: number
  cursor: number
  metaWidth: number
  status: (sessionID: string) => "idle" | "busy" | "retry" | undefined
  onCursor: (cursor: number) => void
  onResume: (session: Session) => void
  onShowAll: () => void
}) {
  return (
    <box width="100%" flexDirection="column">
      <box flexDirection="row" paddingBottom={1}>
        <text flexGrow={1} fg={props.theme.textFaint} attributes={TextAttributes.BOLD} wrapMode="none">
          RECENT SESSIONS {props.sessions.length}
        </text>
        <text flexShrink={0} fg={props.theme.textMuted} wrapMode="none">
          ↑↓ select · enter resume
        </text>
      </box>
      <Show
        when={!props.loading}
        fallback={<StateBlock theme={props.theme} variant="loading" title="Loading sessions…" scale="inline" />}
      >
        <Show
          when={props.sessions.length > 0}
          fallback={
            <StateBlock
              theme={props.theme}
              variant="empty"
              title="No sessions yet"
              description="Start typing above to create one"
              scale="inline"
            />
          }
        >
          <box border={true} borderColor={props.theme.borderSubtle} flexDirection="column">
            <For each={props.sessions}>
              {(session, index) => {
                const selected = () => index() === props.cursor
                const busy = () => props.status(session.id) === "busy"
                const retry = () => props.status(session.id) === "retry"
                return (
                  <box
                    height={1}
                    flexDirection="row"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={selected() ? props.theme.backgroundElement : undefined}
                    onMouseOver={() => props.onCursor(index())}
                    onMouseUp={() => props.onResume(session)}
                  >
                    <text
                      width={2}
                      flexShrink={0}
                      fg={
                        selected()
                          ? props.theme.primary
                          : retry()
                            ? props.theme.warning
                            : busy()
                              ? props.theme.success
                              : props.theme.textFaint
                      }
                      attributes={selected() ? TextAttributes.BOLD : undefined}
                    >
                      {selected() ? "▸" : retry() ? "▲" : busy() ? "●" : "·"}
                    </text>
                    <text
                      flexGrow={1}
                      overflow="hidden"
                      wrapMode="none"
                      fg={selected() ? props.theme.text : props.theme.textMuted}
                      attributes={selected() ? TextAttributes.BOLD : undefined}
                    >
                      {session.title || session.id}
                    </text>
                    <Show when={busy() || retry()}>
                      <text
                        flexShrink={0}
                        marginRight={1}
                        wrapMode="none"
                        fg={retry() ? props.theme.warning : props.theme.success}
                      >
                        {retry() ? "retrying" : "live"}
                      </text>
                    </Show>
                    <text
                      width={props.metaWidth}
                      flexShrink={0}
                      overflow="hidden"
                      wrapMode="none"
                      fg={props.theme.textFaint}
                    >
                      {Locale.truncate(homeSessionMeta(session), props.metaWidth)}
                    </text>
                  </box>
                )
              }}
            </For>
            <box height={1} flexDirection="row" paddingLeft={1} paddingRight={1} onMouseUp={props.onShowAll}>
              <text width={2} flexShrink={0} fg={props.theme.textFaint}>
                ·
              </text>
              <text flexGrow={1} overflow="hidden" wrapMode="none" fg={props.theme.textMuted}>
                Show all {props.total} sessions…
              </text>
              <text flexShrink={0} wrapMode="none" fg={props.theme.textFaint}>
                [{HOME_ALL_SESSIONS_KEY}]
              </text>
            </box>
          </box>
        </Show>
      </Show>
    </box>
  )
}
