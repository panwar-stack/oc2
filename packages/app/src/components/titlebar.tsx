import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  startTransition,
  Switch,
  untrack,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useMatch, useNavigate, useParams } from "@solidjs/router"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"

import { getProjectAvatarVariant, LayoutRoute, useLayout, type LocalProject } from "@/context/layout"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { useServerSync } from "@/context/server-sync"
import { base64Encode } from "@oc2-ai/core/util/encode"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { displayName, getProjectAvatarSource, projectForSession } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { makeEventListener } from "@solid-primitives/event-listener"
import { readSessionTabsRemovedDetail, SESSION_TABS_REMOVED_EVENT } from "@/components/titlebar-session-events"
import { useGlobal } from "@/context/global"
import { decode64 } from "@/utils/base64"
import { ServerConnection, useServer } from "@/context/server"
import { tabHref, useTabs, type Tab } from "@/context/tabs"

const legacyTitlebarHeight = 40
const v2TitlebarHeight = 36

export function Titlebar() {
  const layout = useLayout()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const server = useServer()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const useV2Titlebar = createMemo(() => settings.general.newLayoutDesigns())

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`
  const creating = createMemo(() => {
    if (!params.dir) return false
    if (params.id) return false
    const parts = location.pathname.replace(/\/+$/, "").split("/")
    return parts.at(-1) === "session"
  })

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const canBack = createMemo(() => history.index > 0)
  const canForward = createMemo(() => history.index < history.stack.length - 1)
  const hasProjects = createMemo(() => layout.projects.list().length > 0)
  const nav = createMemo(() => (useV2Titlebar() ? settings.general.showNavigation() : true))
  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  return (
    <header
      classList={{
        "shrink-0 relative flex flex-row": true,
        "h-9 bg-v2-background-bg-deep overflow-visible": useV2Titlebar(),
        "h-10 bg-background-base overflow-hidden": !useV2Titlebar(),
      }}
      style={{ "min-height": `${useV2Titlebar() ? v2TitlebarHeight : legacyTitlebarHeight}px` }}
    >
      <Switch>
        <Match when={useV2Titlebar()}>
          {(_) => {
            const serverSync = useServerSync()
            const navigate = useNavigate()
            const homeMatch = useMatch(() => "/")
            const layout = useLayout()

            const newSessionHref = () => {
              if (params.dir) return `/${params.dir}/session`

              const project = layout.projects.list()[0]
              if (!project) return "/"

              return `/${base64Encode(project.worktree)}/session`
            }

            const tabs = useTabs()
            const tabsStore = tabs.store
            const tabsStoreActions = tabs
            const navigateTab = (tab: Tab) => {
              const href = tabHref(tab)
              if (tab.server === server.key) {
                navigate(href)
                return
              }
              void startTransition(() => {
                server.setActive(tab.server)
                navigate(href)
              })
            }

            const matchRoute = (route: LayoutRoute) => {
              if (route.type === "home") return
              if (route.type === "dir-new-sesssion") {
              }
              if (route.type === "session") {
                const main = tabsStore.find(
                  (item) =>
                    item.type === "session" && item.server === route.server && item.sessionId === route.sessionId,
                )
                if (main) return main
                const sync = serverSync.createDirSyncContext(route.dir)
                const session = sync.session.get(route.sessionId)
                if (session?.parentID) {
                  const parentID = session.parentID
                  const parent = tabsStore.find(
                    (item) => item.type === "session" && item.server === route.server && item.sessionId === parentID,
                  )
                  if (parent) return parent
                }
              }
            }

            const currentTab = () => matchRoute(layout.route())

            createEffect(() => {
              const route = layout.route()
              if (!tabs.ready()) return
              const tab = currentTab()
              if (tab) return

              if (route.type === "session") {
                const sync = serverSync.createDirSyncContext(route.dir)
                const session = sync.session.get(route.sessionId)
                if (!session) return
                const sessionId = session.parentID ?? session.id
                const next = {
                  server: route.server ?? server.key,
                  dirBase64: route.dirBase64,
                  sessionId,
                }
                tabsStoreActions.addSessionTab(next)
              }
            })

            makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
              const detail = readSessionTabsRemovedDetail(event)
              if (!detail) return
              tabsStoreActions.removeSessions(detail)
            })

            const openNewTab = () => navigate(newSessionHref())

            command.register("tabs", () => {
              const current = currentTab()

              return [
                {
                  id: "tab.new",
                  category: "tab",
                  title: language.t("command.session.new"),
                  keybind: "mod+t",
                  hidden: true,
                  onSelect: openNewTab,
                },
                current && {
                  id: "tab.close",
                  category: "tab",
                  title: language.t("command.tab.close"),
                  keybind: "mod+w",
                  hidden: true,
                  onSelect: () => {
                    tabsStoreActions.removeTab(tabsStore.findIndex((tab) => current === tab))
                  },
                },
                {
                  id: `tab.prev`,
                  category: "tab",
                  title: "",
                  keybind: `mod+option+ArrowLeft`,
                  hidden: true,
                  onSelect: () => {
                    let index = tabsStore.findIndex((tab) => tab === currentTab())
                    if (index === -1) return

                    index -= 1
                    if (index === -1) index = tabsStore.length - 1

                    const next = tabsStore[index]
                    if (next) navigateTab(next)
                  },
                },
                {
                  id: `tab.next`,
                  category: "tab",
                  title: "",
                  keybind: `mod+option+ArrowRight`,
                  hidden: true,
                  onSelect: () => {
                    let index = tabsStore.findIndex((tab) => tab === currentTab())
                    if (index === -1) return

                    index += 1
                    if (index === tabsStore.length) index = 0

                    const next = tabsStore[index]
                    if (next) navigateTab(next)
                  },
                },
                ...Array.from({ length: 9 }, (_, i) => {
                  const index = i
                  const number = index + 1
                  return {
                    id: `tab.${number}`,
                    category: "tab",
                    title: "",
                    keybind: `mod+${number}`,
                    disabled: layout.projects.list().length <= index,
                    hidden: true,
                    onSelect: () => {
                      const tab = tabsStore[index]
                      if (tab) navigateTab(tab)
                    },
                  }
                }),
              ].filter((v) => v !== undefined)
            })

            const [tabsAreOverflowing, setTabsAreOverflowing] = createSignal(false)
            let tabScrollRef!: HTMLDivElement

            function refreshTabsAreOverflowing() {
              setTabsAreOverflowing(tabScrollRef.scrollWidth > tabScrollRef.clientWidth)
            }

            return (
              <div class="h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 pr-3 pt-2 pl-4">
                <ChannelIndicator />
                <IconButtonV2
                  variant="ghost-muted"
                  size="large"
                  as="a"
                  href="/"
                  class="!w-9 shrink-0"
                  icon={<IconV2 name="grid-plus" />}
                  state={!!homeMatch() ? "pressed" : undefined}
                />

                <div
                  class="flex min-w-0 flex-row items-center gap-1.5 overflow-x-auto no-scrollbar"
                  ref={tabScrollRef}
                >
                  <div class="flex min-w-0 flex-row items-center gap-1.5">
                    <For each={tabsStore}>
                      {(tab, i) => {
                        let ref!: HTMLDivElement

                        onMount(() => {
                          refreshTabsAreOverflowing()
                        })

                        return (
                          <>
                            {i() !== 0 && (
                              <div class="w-[1.5px] h-3 shrink-0 rounded-full bg-[var(--v2-background-bg-layer-02)]" />
                            )}
                            <TabNavItem
                              ref={ref}
                              href={tabHref(tab)}
                              server={tab.server}
                              directory={decode64(tab.dirBase64)!}
                              sessionId={tab.sessionId}
                              onNavigate={() => {
                                navigateTab(tab)

                                ref.scrollIntoView({ behavior: "instant" })
                              }}
                              onClose={() => tabsStoreActions.removeTab(i())}
                              active={currentTab() === tab}
                              activeServer={tab.server === server.key}
                              forceTruncate={tabsAreOverflowing()}
                            />
                          </>
                        )
                      }}
                    </For>
                    <Show when={creating() && params.dir}>
                      {(_) => {
                        let ref!: HTMLDivElement

                        onMount(() => {
                          ref.scrollIntoView({ behavior: "instant" })
                        })

                        return (
                          <>
                            <div class="w-[1.5px] h-3 shrink-0 rounded-full bg-[var(--v2-background-bg-layer-02)]" />
                            <NewSessionTabItem
                              ref={ref}
                              href={`/${params.dir}/session`}
                              title={language.t("command.session.new")}
                              onClose={() => {
                                const tab = tabsStore.at(-1)
                                if (tab) navigateTab(tab)
                                else navigate("/")
                              }}
                            />
                          </>
                        )
                      }}
                    </Show>
                  </div>
                </div>
                <Show when={!(creating() && params.dir)}>
                  <IconButtonV2
                    type="button"
                    variant="ghost-muted"
                    size="large"
                    class="shrink-0"
                    icon={<IconV2 name="plus" />}
                    as="a"
                    href={newSessionHref()}
                    aria-label={language.t("command.session.new")}
                  />
                </Show>
                <div class="flex-1" />
                <TitlebarV2Right />
              </div>
            )
          }}
        </Match>
        <Match when>
          <div class="grid h-full min-h-full w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center">
            <div
              classList={{
                "flex items-center min-w-0": true,
                "pl-2": true,
              }}
            >
              <div class="xl:hidden w-[48px] shrink-0 flex items-center justify-center">
                <IconButton
                  icon="menu"
                  variant="ghost"
                  class="titlebar-icon rounded-md"
                  onClick={layout.mobileSidebar.toggle}
                  aria-label={language.t("sidebar.menu.toggle")}
                  aria-expanded={layout.mobileSidebar.opened()}
                />
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <TooltipKeybind
                  class="hidden xl:flex shrink-0 ml-14"
                  placement="bottom"
                  title={language.t("command.sidebar.toggle")}
                  keybind={command.keybind("sidebar.toggle")}
                >
                  <Button
                    variant="ghost"
                    class="group/sidebar-toggle titlebar-icon w-8 h-6 p-0 box-border"
                    onClick={layout.sidebar.toggle}
                    aria-label={language.t("command.sidebar.toggle")}
                    aria-expanded={layout.sidebar.opened()}
                  >
                    <Icon size="small" name={layout.sidebar.opened() ? "sidebar-active" : "sidebar"} />
                  </Button>
                </TooltipKeybind>
                <div class="hidden xl:flex items-center shrink-0">
                  <Show when={params.dir}>
                    <div
                      class="flex items-center shrink-0 w-8 mr-1"
                      aria-hidden={layout.sidebar.opened() ? "true" : undefined}
                    >
                      <div
                        class="transition-opacity"
                        classList={{
                          "opacity-100 duration-120 ease-out": !layout.sidebar.opened(),
                          "opacity-0 duration-120 ease-in delay-0 pointer-events-none": layout.sidebar.opened(),
                        }}
                      >
                        <TooltipKeybind
                          placement="bottom"
                          title={language.t("command.session.new")}
                          keybind={command.keybind("session.new")}
                          openDelay={2000}
                        >
                          <Button
                            variant="ghost"
                            icon={creating() ? "new-session-active" : "new-session"}
                            class="titlebar-icon w-8 h-6 p-0 box-border"
                            disabled={layout.sidebar.opened()}
                            tabIndex={layout.sidebar.opened() ? -1 : undefined}
                            onClick={() => {
                              if (!params.dir) return
                              navigate(`/${params.dir}/session`)
                            }}
                            aria-label={language.t("command.session.new")}
                            aria-current={creating() ? "page" : undefined}
                          />
                        </TooltipKeybind>
                      </div>
                    </div>
                  </Show>
                  <div
                    class="flex items-center shrink-0"
                    classList={{
                      "-translate-x-[36px]": layout.sidebar.opened() && !!params.dir,
                      "duration-180 ease-out": !layout.sidebar.opened(),
                      "duration-180 ease-in": layout.sidebar.opened(),
                    }}
                  >
                    <Show when={hasProjects() && nav()}>
                      <div class="flex items-center gap-0 transition-transform">
                        <Tooltip placement="bottom" value={language.t("common.goBack")} openDelay={2000}>
                          <Button
                            variant="ghost"
                            icon="chevron-left"
                            class="titlebar-icon w-6 h-6 p-0 box-border"
                            disabled={!canBack()}
                            onClick={back}
                            aria-label={language.t("common.goBack")}
                          />
                        </Tooltip>
                        <Tooltip placement="bottom" value={language.t("common.goForward")} openDelay={2000}>
                          <Button
                            variant="ghost"
                            icon="chevron-right"
                            class="titlebar-icon w-6 h-6 p-0 box-border"
                            disabled={!canForward()}
                            onClick={forward}
                            aria-label={language.t("common.goForward")}
                          />
                        </Tooltip>
                      </div>
                    </Show>
                    <div id="opencode-titlebar-left" class="flex items-center gap-3 min-w-0 px-2" />
                    <ChannelIndicator />
                  </div>
                </div>
              </div>
            </div>

            <div class="min-w-0 flex items-center justify-center pointer-events-none">
              <div
                id="opencode-titlebar-center"
                class="pointer-events-auto min-w-0 flex justify-center w-fit max-w-full"
              />
            </div>

            <div
              classList={{
                "flex items-center min-w-0 justify-end": true,
                "pr-2": true,
              }}
            >
              <div id="opencode-titlebar-right" class="flex items-center gap-1 shrink-0 justify-end" />
            </div>
          </div>
        </Match>
      </Switch>
    </header>
  )
}

function TitlebarV2Right() {
  return (
    <div class="relative z-20 flex shrink-0 items-center justify-end gap-0 overflow-visible">
      <div id="opencode-titlebar-right" class="flex shrink-0 items-center justify-end gap-0" />
    </div>
  )
}

function TabNavItem(props: {
  ref?: HTMLDivElement
  href: string
  server: ServerConnection.Key
  directory: string
  sessionId?: string
  hideClose?: boolean
  onClose: () => void
  onNavigate: () => void
  active?: boolean
  activeServer: boolean
  forceTruncate?: boolean
}) {
  const closeTab = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }
  const global = useGlobal()
  const serverCtx = createMemo(() => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    if (conn) return global.createServerCtx(conn)
  })
  const dirSyncCtx = createMemo(() => serverCtx()?.sync.createDirSyncContext(props.directory))

  const [session] = createResource(
    () => {
      const ctx = dirSyncCtx()
      if (!ctx || !props.sessionId) return
      return [props.sessionId, ctx] as const
    },
    async ([sessionId, dirSyncCtx]) => {
      await dirSyncCtx.session.sync(sessionId).catch(() => {})
      return dirSyncCtx.session.get(sessionId)
    },
    { initialValue: props.sessionId ? dirSyncCtx()?.session.get(props.sessionId) : undefined },
  )

  return (
    <div
      ref={props.ref}
      class="group relative flex h-7 min-w-24 max-w-60 flex-row items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[6px] bg-[var(--tab-bg)] px-1.5 [--tab-bg:var(--v2-background-bg-deep)] hover:[--tab-bg:var(--v2-background-bg-layer-02)] data-[active='true']:[--tab-bg:var(--v2-background-bg-layer-02)]"
      data-active={props.active}
      onMouseDown={(event) => {
        if (event.button !== 1) return
        closeTab(event)
      }}
    >
      <Show when={session.latest}>
        {(session) => {
          console.log({ session: session() })
          const project = createMemo(() => projectForSession(session(), serverCtx()?.projects.list() ?? []))

          return (
            <a
              href={props.href}
              onClick={(event) => {
                event.preventDefault()
                props.onNavigate()
              }}
              class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 text-[13px] font-medium text-v2-text-text-faint group-data-[active='true']:text-v2-text-text-base"
            >
              <span data-slot="project-avatar-slot">
                <ProjectTabAvatar
                  project={project()}
                  directory={props.directory}
                  sessionId={session().id}
                  activeServer={props.activeServer}
                />
              </span>
              <span class="min-w-0 flex-1">{session().title}</span>
            </a>
          )
        }}
      </Show>

      <div
        class="absolute not-group-hover:not-group-data-[active=true]:not-data-[truncate=true]:left-52 group-hover:right-0 group-data-[active=true]:right-0 data-[truncate=true]:right-0 inset-y-0 flex flex-row items-center pr-1 py-1 w-8 pl-2"
        data-truncate={props.forceTruncate}
      >
        <div
          class="absolute inset-0 rounded-r-[6px] bg-(image:--inactive-bg) group-hover:bg-(image:--active-bg) group-data-[active=true]:bg-(image:--active-bg)"
          style={{
            "--inactive-bg": "linear-gradient(to right, transparent 0%, var(--tab-bg) 80%)",
            "--active-bg": "linear-gradient(90deg, transparent 0%, var(--tab-bg) 25%)",
          }}
        />
        <IconButtonV2
          size="small"
          variant="ghost-muted"
          class="opacity-0 group-hover:opacity-100 group-data-[active='true']:opacity-100 z-10"
          onClick={closeTab}
          icon={<IconV2 name="xmark-small" />}
        />
      </div>
    </div>
  )
}

function ProjectTabAvatar(props: {
  project?: LocalProject
  directory: string
  sessionId: string
  activeServer: boolean
}) {
  const directory = () => props.directory
  const sessionId = () => props.sessionId
  const state = useSessionTabAvatarState(directory, sessionId, () => props.activeServer)
  return (
    <ProjectAvatar
      fallback={displayName(props.project ?? { worktree: props.directory })}
      src={getProjectAvatarSource(props.project?.id, props.project?.icon)}
      variant={getProjectAvatarVariant(props.project?.icon?.color)}
      unread={state.unread()}
      loading={state.loading()}
    />
  )
}

function NewSessionTabItem(props: { ref?: HTMLDivElement; href: string; title: string; onClose: () => void }) {
  const closeTab = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }
  return (
    <div
      ref={props.ref}
      class="group relative shrink-0 flex h-7 max-w-60 flex-row items-center gap-1.5 overflow-hidden rounded-[6px] bg-[var(--v2-overlay-simple-overlay-pressed)] pl-1.5 pr-8 whitespace-nowrap focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--v2-border-border-focus)]"
      onMouseDown={(event) => {
        if (event.button !== 1) return
        closeTab(event)
      }}
    >
      <a
        href={props.href}
        aria-current="page"
        class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 overflow-hidden text-[13px] font-medium leading-5 text-[var(--v2-text-text-base)]"
      >
        <span class="flex size-4 shrink-0 rotate-90 items-center justify-center">
          <IconV2 name="edit" />
        </span>
        <span class="truncate leading-5">{props.title}</span>
      </a>
      <div class="absolute right-0 inset-y-0 flex w-7 items-center justify-center">
        <IconButtonV2
          size="small"
          variant="ghost-muted"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={closeTab}
          icon={<IconV2 name="xmark-small" />}
          aria-label="Close tab"
        />
      </div>
    </div>
  )
}

function ChannelIndicator() {
  return (
    <>
      {["beta", "dev"].includes(import.meta.env.VITE_OPENCODE_CHANNEL) && (
        <div class="bg-icon-interactive-base text-[#FFF] font-medium px-2 rounded-sm uppercase font-mono">
          {import.meta.env.VITE_OPENCODE_CHANNEL.toUpperCase()}
        </div>
      )}
    </>
  )
}
