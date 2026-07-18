import { Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useSpring } from "@oc2-ai/ui/motion-spring"
import { useLayout } from "@/context/layout"
import { PromptInput } from "@/components/prompt-input"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSync } from "@/context/sync"
import { useSettings } from "@/context/settings"
import { getSessionHandoff, setSessionHandoff } from "@/pages/session/handoff"
import { useSessionKey } from "@/pages/session/session-layout"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import type { SessionComposerState } from "@/pages/session/composer/session-composer-state"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import { StatusGlyph } from "@oc2-ai/ui/v2/status-glyph"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import { usePendingDecisionTitle } from "@/pages/session/composer/session-decision"
import { SessionWorkingBar } from "@/pages/session/session-working-bar"

export function SessionComposerRegion(props: {
  state: SessionComposerState
  ready: boolean
  centered: boolean
  placement?: "dock" | "inline"
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onResponseSubmit: () => void
  followup?: {
    queue: () => boolean
    sendsNext: () => boolean
    items: { id: string; text: string }[]
    sending?: string
    edit?: { id: string; prompt: FollowupDraft["prompt"]; context: FollowupDraft["context"] }
    onQueue: (draft: FollowupDraft) => void
    onAbort: () => void
    onSend: (id: string) => void
    onEdit: (id: string) => void
    onEditLoaded: () => void
  }
  revert?: {
    items: { id: string; text: string }[]
    restoring?: string
    disabled?: boolean
    onRestore: (id: string) => void
  }
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  const navigate = useNavigate()
  const layout = useLayout()
  const prompt = usePrompt()
  const language = useLanguage()
  const route = useSessionKey()
  const sync = useSync()
  const settings = useSettings()
  const view = layout.view(route.sessionKey)

  const handoffPrompt = createMemo(() => getSessionHandoff(route.sessionKey())?.prompt)
  const info = createMemo(() => (route.params.id ? sync.session.get(route.params.id) : undefined))
  const parentID = createMemo(() => info()?.parentID)
  const child = createMemo(() => !!parentID())
  const workingMembers = createMemo(() =>
    route.params.id
      ? sync.data.session.filter((item) => item.parentID === route.params.id && sync.data.session_working(item.id))
          .length
      : 0,
  )
  const activeTask = createMemo(() => props.state.todos().find((item) => item.status === "in_progress")?.content)
  const showComposer = createMemo(() => !props.state.blocked() || child())
  usePendingDecisionTitle(() => !!props.state.questionRequest() || !!props.state.permissionRequest())

  const previewPrompt = () =>
    prompt
      .current()
      .map((part) => {
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        if (part.type === "image") return `[image:${part.filename}]`
        return part.content
      })
      .join("")
      .trim()

  createEffect(() => {
    if (!prompt.ready()) return
    setSessionHandoff(route.sessionKey(), { prompt: previewPrompt() })
  })

  const [store, setStore] = createStore({
    ready: false,
    height: 320,
    body: undefined as HTMLDivElement | undefined,
    decision: undefined as { variant: "resolved" | "cancelled"; text: string } | undefined,
  })
  let timer: number | undefined
  let frame: number | undefined
  let decisionTimer: number | undefined
  let currentSessionKey = route.sessionKey()
  let abortActive: (() => Promise<unknown>) | undefined

  const clear = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
      frame = undefined
    }
  }

  const showDecisionSummary = (summary: { variant: "resolved" | "cancelled"; text: string }) => {
    if (decisionTimer !== undefined) window.clearTimeout(decisionTimer)
    decisionTimer = undefined
    setStore("decision", summary)
  }

  createEffect(() => {
    const summary = store.decision
    const pending = !!props.state.questionRequest() || !!props.state.permissionRequest()
    if (!summary || pending) {
      if (decisionTimer !== undefined) window.clearTimeout(decisionTimer)
      decisionTimer = undefined
      return
    }
    if (decisionTimer !== undefined) return
    decisionTimer = window.setTimeout(() => {
      setStore("decision", undefined)
      decisionTimer = undefined
    }, 2400)
  })

  createEffect(() => {
    const nextSessionKey = route.sessionKey()
    const ready = props.ready
    const delay = 140

    clear()
    setStore("ready", false)
    if (nextSessionKey !== currentSessionKey) {
      currentSessionKey = nextSessionKey
      setStore("decision", undefined)
    }
    if (!ready) return

    frame = requestAnimationFrame(() => {
      frame = undefined
      timer = window.setTimeout(() => {
        setStore("ready", true)
        timer = undefined
      }, delay)
    })
  })

  onCleanup(() => {
    clear()
    if (decisionTimer !== undefined) window.clearTimeout(decisionTimer)
  })

  const open = createMemo(() => store.ready && props.state.dock() && !props.state.closing())
  const progress = useSpring(() => (open() ? 1 : 0), { visualDuration: 0.3, bounce: 0 })
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const dock = createMemo(() => (store.ready && props.state.dock()) || value() > 0.001)
  const rolled = createMemo(() => (props.revert?.items.length ? props.revert : undefined))
  const lift = createMemo(() => (rolled() ? 18 : 36 * value()))
  const full = createMemo(() => Math.max(78, store.height))

  const openParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${route.params.dir}/session/${id}`)
  }

  createEffect(() => {
    const el = store.body
    if (!el) return
    const update = () => setStore("height", el.getBoundingClientRect().height)
    createResizeObserver(store.body, update)
    update()
  })

  return (
    <div
      ref={props.setPromptDockRef}
      data-component="session-prompt-dock"
      classList={{
        "w-full flex flex-col justify-center items-center pointer-events-none": true,
        "shrink-0 pb-3 bg-background-stronger": props.placement !== "inline",
      }}
    >
      <div
        classList={{
          "w-full pointer-events-auto": true,
          "px-3": props.placement !== "inline",
          [NEW_SESSION_CONTENT_WIDTH]: props.placement === "inline",
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
        }}
      >
        <Show when={settings.general.newLayoutDesigns() && route.params.id}>
          <SessionWorkingBar
            sessionID={route.params.id}
            working={props.state.working()}
            blocked={props.state.blocked()}
            team={workingMembers() > 0}
            task={activeTask()}
            elapsed={props.state.elapsed()}
            queued={props.followup?.items.length}
            onInterrupt={
              child()
                ? undefined
                : () => {
                    void abortActive?.()
                  }
            }
          />
        </Show>

        <Show when={props.state.questionRequest()} keyed>
          {(request) => (
            <div>
              <SessionQuestionDock
                request={request}
                onSubmit={props.onResponseSubmit}
                onResolved={showDecisionSummary}
              />
            </div>
          )}
        </Show>

        <Show when={props.state.permissionRequest()} keyed>
          {(request) => (
            <div>
              <SessionPermissionDock
                request={request}
                responding={props.state.permissionResponding()}
                onDecide={(response) => {
                  props.onResponseSubmit()
                  return props.state.decide(response)
                }}
                onResolved={showDecisionSummary}
              />
            </div>
          )}
        </Show>

        <Show when={!props.state.questionRequest() && !props.state.permissionRequest() && store.decision} keyed>
          {(summary) => (
            <div data-component="decision-resolved" data-variant={summary.variant} role="status">
              <StatusGlyph name={summary.variant === "cancelled" ? "failed" : "done"} size="normal" />
              <span>{summary.text}</span>
            </div>
          )}
        </Show>

        <Show when={showComposer()}>
          <Show
            when={prompt.ready()}
            fallback={
              <>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <div class="pb-2">
                      <SessionRevertDock
                        items={revert.items}
                        restoring={revert.restoring}
                        disabled={revert.disabled}
                        onRestore={revert.onRestore}
                      />
                    </div>
                  )}
                </Show>
                <div class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none">
                  {handoffPrompt() || language.t("prompt.loading")}
                </div>
              </>
            }
          >
            <Show when={dock()}>
              <div
                classList={{
                  "overflow-hidden": true,
                  "pointer-events-none": value() < 0.98,
                }}
                style={{
                  "max-height": `${full() * value()}px`,
                }}
              >
                <div ref={(el) => setStore("body", el)}>
                  <SessionTodoDock
                    sessionID={route.params.id}
                    todos={props.state.todos()}
                    collapsed={view.todoCollapsed.get()}
                    onToggle={() => view.todoCollapsed.set(!view.todoCollapsed.get())}
                    collapseLabel={language.t("session.todo.collapse")}
                    expandLabel={language.t("session.todo.expand")}
                    dockProgress={value()}
                    redesigned={settings.general.newLayoutDesigns()}
                  />
                </div>
              </div>
            </Show>
            <Show when={rolled()} keyed>
              {(revert) => (
                <div
                  style={{
                    "margin-top": `${-36 * value()}px`,
                  }}
                >
                  <SessionRevertDock
                    items={revert.items}
                    restoring={revert.restoring}
                    disabled={revert.disabled}
                    onRestore={revert.onRestore}
                  />
                </div>
              )}
            </Show>
            <div
              classList={{
                "relative z-10": true,
              }}
              style={{
                "margin-top": `${-lift()}px`,
              }}
            >
              <Show when={props.followup?.items.length}>
                <SessionFollowupDock
                  items={props.followup!.items}
                  sending={props.followup!.sending}
                  redesigned={settings.general.newLayoutDesigns()}
                  onSend={props.followup!.onSend}
                  onEdit={props.followup!.onEdit}
                />
              </Show>
              <Show
                when={child()}
                fallback={
                  <Show when={!props.state.blocked()}>
                    <PromptInput
                      variant={props.placement === "inline" ? "new-session" : undefined}
                      ref={props.inputRef}
                      newSessionWorktree={props.newSessionWorktree}
                      onNewSessionWorktreeReset={props.onNewSessionWorktreeReset}
                      edit={props.followup?.edit}
                      onEditLoaded={props.followup?.onEditLoaded}
                      shouldQueue={props.followup?.queue}
                      queuedCount={() => props.followup?.items.length ?? 0}
                      queuedSendsNext={props.followup?.sendsNext}
                      workingElapsed={props.state.elapsed}
                      onQueue={props.followup?.onQueue}
                      onAbort={props.followup?.onAbort}
                      setAbort={(abort) => {
                        abortActive = abort
                      }}
                      onSubmit={props.onSubmit}
                    />
                  </Show>
                }
              >
                <div
                  ref={props.inputRef}
                  class="w-full rounded-[12px] border border-border-weak-base bg-background-base p-3 text-16-regular text-text-weak"
                >
                  <span>{language.t("session.child.promptDisabled")} </span>
                  <Show when={parentID()}>
                    <button
                      type="button"
                      class="text-text-base transition-colors hover:text-text-strong"
                      onClick={openParent}
                    >
                      {language.t("session.child.backToParent")}
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
