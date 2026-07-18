import type { Session } from "@oc2-ai/sdk/v2/client"
import { batch, createEffect, createMemo, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import { Button } from "@oc2-ai/ui/button"
import { Logo, Mark } from "@oc2-ai/ui/logo"
import { ScrollView } from "@oc2-ai/ui/scroll-view"
import { ProjectAvatar } from "@oc2-ai/ui/v2/project-avatar-v2"
import { ButtonV2 } from "@oc2-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@oc2-ai/ui/v2/icon"
import { IconButtonV2 } from "@oc2-ai/ui/v2/icon-button-v2"
import { KeyHintV2 } from "@oc2-ai/ui/v2/key-hint-v2"
import { MenuV2 } from "@oc2-ai/ui/v2/menu-v2"
import { StateBlockV2 } from "@oc2-ai/ui/v2/state-block-v2"
import { getProjectAvatarVariant, useLayout, type LocalProject } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@oc2-ai/core/util/encode"
import { Icon } from "@oc2-ai/ui/icon"
import { usePlatform } from "@/context/platform"
import { DateTime } from "luxon"
import { useDialog } from "@oc2-ai/ui/context/dialog"
import { useDirectoryPicker } from "@/components/directory-picker"
import { DialogSelectServer, useServerManagementController } from "@/components/dialog-select-server"
import { DialogServerV2 } from "@/components/settings-v2/dialog-server-v2"
import { ServerConnection, useServer } from "@/context/server"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import {
  closeHomeProject,
  displayName,
  getProjectAvatarSource,
  homeProjectDirectories,
  homeProjectNavigation,
  type HomeProjectSelection,
  projectForSession,
  sortedRootSessions,
  toggleHomeProjectSelection,
} from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { sessionTitle } from "@/utils/session-title"
import { pathKey } from "@/utils/path-key"
import { useGlobal } from "@/context/global"
import { useCommand } from "@/context/command"
import { useSettings } from "@/context/settings"
import { ServerRowMenu } from "@/components/server/server-row-menu"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { type ServerHealth } from "@/utils/server-health"
import {
  HOME_ALL_SESSIONS_KEYBIND,
  homeSessionTokenCount,
  nextHomeSessionCursor,
  recentHomeSessions,
} from "./home-model"

const HOME_SESSION_LIMIT = 64
const HOME_ROW_LAYOUT =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-[6px] bg-transparent text-left transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out focus-visible:outline-none"
const HOME_ROW_BASE = `${HOME_ROW_LAYOUT} border-0`
const HOME_ROW = `${HOME_ROW_BASE} [font-weight:530] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover`
const HOME_PROJECT_NAV_LABEL = "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
const HOME_PROJECT_NAV_ROW = `${HOME_ROW_LAYOUT} h-7 gap-2 px-1.5 [font-weight:440] text-v2-text-text-muted hover:bg-v2-background-bg-layer-01 hover:text-v2-text-text-base hover:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] data-[selected]:bg-v2-background-bg-layer-02 data-[selected]:text-v2-text-text-base data-[selected]:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)] data-[selected]:hover:bg-v2-background-bg-layer-02 focus-visible:bg-v2-background-bg-layer-01 focus-visible:text-v2-text-text-base focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]`
const HOME_SECTION_LABEL = "text-v2-text-text-muted [font-weight:440]"

type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
  status?: "idle" | "busy" | "retry"
}

type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

const HOME_SESSION_SEARCH_RESULTS_ID = "home-session-search-results"
const HOME_SEARCH_RESULT_ROW =
  "flex h-10 w-full shrink-0 cursor-default items-center gap-2 border-0 py-3 pl-4 pr-6 text-left transition-[background-color] duration-[120ms] ease-in-out hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none"
const HOME_SEARCH_RESULT_TITLE =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-base [font-weight:530]"
const HOME_SEARCH_RESULT_META =
  "min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]"

let pendingHomeNavigation: { server: ServerConnection.Key; href: string } | undefined

function buildHomeSessionRecords(input: {
  sync: Pick<ReturnType<typeof useServerSync>, "child">
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
}) {
  return [
    ...new Map(
      input
        .projectDirectories()
        .flatMap((directory) => {
          const store = input.sync.child(directory, { bootstrap: false })[0]
          return sortedRootSessions(store, Date.now()).map((session) => ({
            session,
            status: store.session_status[session.id]?.type,
          }))
        })
        .map((record) => [`${pathKey(record.session.directory)}:${record.session.id}`, record] as const),
    ).values(),
  ]
    .sort(
      (a, b) => (b.session.time.updated ?? b.session.time.created) - (a.session.time.updated ?? a.session.time.created),
    )
    .flatMap((record) => {
      const project = projectForSession(record.session, input.projects(), input.projectByID())
      if (!project) return []
      return {
        session: record.session,
        project,
        projectName: displayName(project),
        status: record.status,
      }
    })
}

function matchesHomeSessionSearch(record: HomeSessionRecord, query: string) {
  return `${record.session.title} ${record.projectName}`.toLowerCase().includes(query)
}

function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${encodeURIComponent(pathKey(record.session.directory))}:${record.session.id}`
}

export default function Home() {
  const settings = useSettings()
  return (
    <Show when={settings.general.newLayoutDesigns()} fallback={<LegacyHome />}>
      <HomeDesign />
    </Show>
  )
}

function HomeDesign() {
  const sync = useServerSync()
  const layout = useLayout()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const language = useLanguage()
  const global = useGlobal()
  const command = useCommand()
  const notification = useNotification()
  let focusSessionSearch: (() => void) | undefined
  const [state, setState] = createStore({
    search: "",
    selection: { server: server.key } as HomeProjectSelection,
    searchFocused: false,
    allSessions: false,
    allSessionsLoading: false,
    recentCursor: 0,
    prompt: "",
  })

  const focusedServer = createMemo(
    () => global.servers.list().find((conn) => ServerConnection.key(conn) === state.selection.server) ?? server.current,
  )
  const focusedServerCtx = createMemo(() => {
    const conn = focusedServer()
    if (!conn) return
    return global.createServerCtx(conn)
  })
  const focusedSync = () => focusedServerCtx()?.sync ?? sync
  const projects = createMemo(() => focusedServerCtx()?.projects.list() ?? layout.projects.list())
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === state.selection.directory))
  const newSessionProject = createMemo(
    () =>
      selectedProject() ??
      projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
      projects()[0],
  )
  const directories = (project: LocalProject) => [project.worktree, ...(project.sandboxes ?? [])]
  const projectDirectories = createMemo(() => {
    const project = selectedProject()
    if (!project) return projects().flatMap(directories)
    return directories(project)
  })
  const search = createMemo(() => state.search.trim())
  const sessionLoad = useQuery(() => ({
    queryKey: ["home", "sessions", state.selection.server, ...projectDirectories()] as const,
    queryFn: async () => {
      await Promise.all(
        projectDirectories().map(async (directory) => {
          const loaded = await focusedSync().project.loadSessions(directory, { limit: HOME_SESSION_LIMIT })
          if (!loaded) throw new Error(`Failed to load sessions for ${directory}`)
        }),
      )
      return null
    },
  }))

  const projectByID = createMemo(
    () => new Map(projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const allRecords = createMemo(() =>
    buildHomeSessionRecords({
      sync: focusedSync(),
      projectDirectories,
      projects,
      projectByID,
    }),
  )
  const records = createMemo(() => allRecords().slice(0, HOME_SESSION_LIMIT))
  const recent = createMemo(() => recentHomeSessions(records()))
  const searchResults = createMemo(() => {
    const query = search().toLowerCase()
    if (!query) return []
    return allRecords().filter((record) => matchesHomeSessionSearch(record, query))
  })
  const searchOpen = createMemo(() => state.searchFocused && search().length > 0)
  const groups = createMemo(() => groupSessions(allRecords(), language))
  const composerProject = createMemo(() => newSessionProject())
  const composerStore = createMemo(() => {
    const project = composerProject()
    if (!project) return
    return focusedSync().child(project.worktree)[0]
  })
  const composerBranch = createMemo(() => composerStore()?.vcs?.branch)
  const composerAgent = createMemo(() => composerStore()?.config.default_agent ?? "build")
  const composerModel = createMemo(() => composerStore()?.config.model)
  const serverHealth = createMemo(() => global.servers.health[state.selection.server]?.healthy)
  const sessionLoadError = createMemo(() => sessionLoad.isError)
  const sessionTotal = createMemo(() =>
    projectDirectories().reduce((total, directory) => {
      const store = focusedSync().child(directory, { bootstrap: false })[0]
      return total + Math.max(store.sessionTotal, sortedRootSessions(store, Date.now()).length)
    }, 0),
  )
  const sessionTotalExact = createMemo(() =>
    projectDirectories().every((directory) => {
      const store = focusedSync().child(directory, { bootstrap: false })[0]
      return store.sessionTotal <= sortedRootSessions(store, Date.now()).length
    }),
  )

  createEffect(() => {
    for (const directory of new Set(recent().map((record) => record.session.directory))) {
      focusedSync().child(directory)
    }
  })

  function setSelection(next: HomeProjectSelection) {
    batch(() => {
      if (state.selection.server !== next.server) setState("selection", "server", next.server)
      if (state.selection.directory !== next.directory) setState("selection", "directory", next.directory)
    })
  }

  function closeSearch() {
    setState("search", "")
    setState("searchFocused", false)
  }

  function showAllSessions() {
    setState("allSessions", true)
    queueMicrotask(() => focusSessionSearch?.())
    void loadAllSessions()
  }

  async function loadAllSessions() {
    setState("allSessionsLoading", true)
    await sessionLoad.refetch()
    await Promise.all(
      projectDirectories().map(async (directory) => {
        for (;;) {
          const store = focusedSync().child(directory, { bootstrap: false })[0]
          const count = sortedRootSessions(store, Date.now()).length
          if (store.sessionTotal <= count) return
          const loaded = await focusedSync().project.loadSessions(directory, {
            limit: Math.max(store.sessionTotal, count + HOME_SESSION_LIMIT),
          })
          if (!loaded) return
          if (sortedRootSessions(store, Date.now()).length <= count) return
        }
      }),
    )
    setState("allSessionsLoading", false)
  }

  function selectSearchSession(session: Session) {
    openSession(session)
    closeSearch()
  }

  command.register("home", () => [
    {
      id: "home.sessions.search.focus",
      title: language.t("home.sessions.search.placeholder"),
      keybind: "mod+f",
      hidden: true,
      onSelect: showAllSessions,
    },
    {
      id: "home.sessions.all",
      title: "Show all sessions",
      keybind: HOME_ALL_SESSIONS_KEYBIND,
      hidden: true,
      onSelect: showAllSessions,
    },
  ])

  createEffect(() => {
    const count = recent().length
    if (count === 0 || state.recentCursor < count) return
    setState("recentCursor", count - 1)
  })

  createEffect(() => {
    const list = global.servers.list()
    if (list.some((conn) => ServerConnection.key(conn) === state.selection.server)) return
    const conn = list.find((conn) => ServerConnection.key(conn) === server.key) ?? list[0]
    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })

  createEffect(() => {
    const pending = pendingHomeNavigation
    if (!pending || pending.server !== server.key) return
    pendingHomeNavigation = undefined
    navigate(pending.href)
  })

  function focusServer(conn: ServerConnection.Any) {
    setSelection({ server: ServerConnection.key(conn) })
  }

  function selectProject(conn: ServerConnection.Any, directory: string) {
    const key = ServerConnection.key(conn)
    if (
      !global
        .createServerCtx(conn)
        .projects.list()
        .some((project) => project.worktree === directory)
    )
      return
    setSelection(toggleHomeProjectSelection(state.selection, key, directory))
  }

  function addProjects(conn: ServerConnection.Any, directories: string[]) {
    const directory = directories[0]
    if (!directory) return
    const ctx = global.createServerCtx(conn)
    directories.forEach(ctx.projects.open)
    ctx.projects.touch(directory)
    setSelection({ server: ServerConnection.key(conn), directory })
  }

  function openNewSession() {
    const conn = focusedServer()
    const project = newSessionProject()
    if (!conn || !project) return
    openProjectNewSession(conn, project.worktree)
  }

  function submitHomePrompt() {
    const conn = focusedServer()
    const project = composerProject()
    const prompt = state.prompt.trim()
    if (!conn || !project || !prompt) return
    openProjectNewSession(conn, project.worktree, prompt)
  }

  function resumeRecent() {
    const record = recent()[state.recentCursor]
    if (!record) return
    openSession(record.session)
  }

  function navigateOnServer(conn: ServerConnection.Any, href: string) {
    const next = homeProjectNavigation(server.key, ServerConnection.key(conn), href)
    if (!next.server) {
      navigate(next.href)
      return
    }
    pendingHomeNavigation = next
    server.setActive(next.server)
  }

  function openProjectNewSession(conn: ServerConnection.Any, directory: string, prompt?: string) {
    const ctx = global.createServerCtx(conn)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    const href = `/${base64Encode(directory)}/session`
    navigateOnServer(conn, prompt ? `${href}?prompt=${encodeURIComponent(prompt)}` : href)
  }

  function editProject(conn: ServerConnection.Any, project: LocalProject) {
    void import("@/components/dialog-edit-project").then((x) => {
      dialog.show(() => <x.DialogEditProject server={conn} project={project} />)
    })
  }

  function unseenCount(conn: ServerConnection.Any, project: LocalProject) {
    if (ServerConnection.key(conn) !== server.key) return 0
    return directories(project).reduce((total, directory) => total + notification.project.unseenCount(directory), 0)
  }

  function clearNotifications(conn: ServerConnection.Any, project: LocalProject) {
    if (ServerConnection.key(conn) !== server.key) return
    directories(project)
      .filter((directory) => notification.project.unseenCount(directory) > 0)
      .forEach((directory) => notification.project.markViewed(directory))
  }

  function openSession(session: Session) {
    const project = projectForSession(session, projects(), projectByID())
    const conn = focusedServer()
    if (!conn) return
    const directory = project?.worktree ?? session.directory
    const ctx = global.createServerCtx(conn)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    navigateOnServer(conn, `/${base64Encode(session.directory)}/session/${session.id}`)
  }

  function chooseProject(conn: ServerConnection.Any) {
    function resolve(result: string | string[] | null) {
      addProjects(conn, homeProjectDirectories(result))
    }

    const server = global.createServerCtx(conn)

    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  function openSettings() {
    void import("@/components/settings-v2").then((x) => {
      dialog.show(() => <x.DialogSettings />)
    })
  }

  return (
    <div class="m-2 flex min-h-0 flex-1 self-stretch flex-col overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <div class="mx-auto grid min-h-0 w-full max-w-[1080px] flex-1 gap-8 overflow-y-auto px-4 pb-8 sm:px-6 lg:grid-cols-[280px_minmax(0,720px)] lg:overflow-hidden">
        <HomeProjectColumn
          projects={projects()}
          selected={state.selection}
          focusServer={focusServer}
          selectProject={selectProject}
          openNewSession={openProjectNewSession}
          chooseProject={(conn) => void chooseProject(conn)}
          editProject={editProject}
          closeProject={(conn, directory) => {
            const next = closeHomeProject(
              state.selection,
              ServerConnection.key(conn),
              global.createServerCtx(conn).projects,
              directory,
            )
            if (next) setSelection(next)
          }}
          clearNotifications={clearNotifications}
          unseenCount={unseenCount}
          openSettings={openSettings}
          openHelp={() => platform.openLink("https://github.com/panwar-stack/oc2#readme")}
          language={language}
        />

        <section
          class="order-first flex min-h-0 min-w-0 flex-1 flex-col pt-8 lg:order-none lg:pt-12"
          aria-label={language.t("sidebar.project.recentSessions")}
        >
          <HomeIdentity
            version={platform.version}
            updatePolicy={composerStore()?.config.autoupdate}
            ready={composerProject() ? composerStore()?.status === "complete" : focusedSync().data.ready}
          />
          <HomeComposer
            value={state.prompt}
            agent={composerAgent()}
            model={composerModel()}
            project={composerProject() ? displayName(composerProject()!) : undefined}
            enabled={!!composerProject()}
            recent={recent().length > 0}
            onInput={(value) => setState("prompt", value)}
            onMove={(delta) =>
              setState("recentCursor", nextHomeSessionCursor(state.recentCursor, delta, recent().length))
            }
            onSubmit={submitHomePrompt}
            onResume={resumeRecent}
          />
          <Show
            when={state.allSessions}
            fallback={
              <HomeRecentSessions
                loading={sessionLoad.isLoading}
                error={sessionLoadError()}
                records={recent()}
                total={sessionTotalExact() ? sessionTotal() : undefined}
                cursor={state.recentCursor}
                onCursor={(cursor) => setState("recentCursor", cursor)}
                onMove={(delta) =>
                  setState("recentCursor", nextHomeSessionCursor(state.recentCursor, delta, recent().length))
                }
                onResume={openSession}
                onShowAll={showAllSessions}
                onRetry={() => void sessionLoad.refetch()}
                onOpenProject={
                  !composerProject() && focusedServer() ? () => void chooseProject(focusedServer()!) : undefined
                }
              />
            }
          >
            <div class="mt-6 flex min-h-0 flex-1 flex-col">
              <div class="mb-3 flex min-w-0 items-center justify-between px-1">
                <span class="text-[var(--v2-font-size-label)] font-bold tracking-[0.12em] text-v2-text-text-faint">
                  ALL SESSIONS
                </span>
                <button
                  type="button"
                  class="text-[var(--v2-font-size-meta)] text-v2-text-text-muted hover:text-v2-text-text-base focus-visible:outline-none focus-visible:shadow-[var(--v2-shadow-focus)]"
                  onClick={() => setState("allSessions", false)}
                >
                  Recent sessions
                </button>
              </div>
              <HomeSessionSearch
                value={state.search}
                placeholder={language.t("home.sessions.search.placeholder")}
                open={searchOpen()}
                loading={sessionLoad.isLoading || state.allSessionsLoading}
                results={searchResults()}
                server={state.selection.server}
                activeServer={state.selection.server === server.key}
                noResultsLabel={language.t("home.sessions.search.noResults", { query: search() })}
                bindFocus={(focus) => {
                  focusSessionSearch = focus
                }}
                onInput={(value) => setState("search", value)}
                onFocus={() => setState("searchFocused", true)}
                onClose={closeSearch}
                onEscape={() => setState("allSessions", false)}
                onSelect={selectSearchSession}
              />
              <ScrollView class="mt-3 min-h-0 flex-1">
                <div class="flex flex-col gap-6 pt-3">
                  <Show
                    when={!sessionLoad.isLoading && !state.allSessionsLoading}
                    fallback={<StateBlockV2 variant="loading" title="Loading sessions…" />}
                  >
                    <Show
                      when={!sessionLoadError()}
                      fallback={
                        <StateBlockV2
                          variant="error"
                          title="Couldn't load sessions"
                          description="Check the server connection and retry."
                          action={
                            <ButtonV2 variant="contrast" size="normal" onClick={() => void sessionLoad.refetch()}>
                              Retry
                            </ButtonV2>
                          }
                        />
                      }
                    >
                      <Show
                        when={groups().length > 0}
                        fallback={
                          <StateBlockV2
                            variant="empty"
                            title="No sessions yet"
                            description={
                              composerProject()
                                ? "Start typing above to create one — your sessions will appear here."
                                : "Open a project to create your first session."
                            }
                            action={
                              !composerProject() && focusedServer() ? (
                                <ButtonV2
                                  variant="contrast"
                                  size="normal"
                                  onClick={() => void chooseProject(focusedServer()!)}
                                >
                                  Open project
                                </ButtonV2>
                              ) : undefined
                            }
                          />
                        }
                      >
                        <For each={groups()}>
                          {(group, index) => (
                            <div class="flex min-w-0 flex-col gap-4">
                              <HomeSessionGroupHeader
                                title={group.title}
                                onNewSession={index() === 0 && newSessionProject() ? openNewSession : undefined}
                              />
                              <div class="flex min-w-0 flex-col gap-px">
                                <For each={group.sessions}>
                                  {(record) => (
                                    <HomeSessionRow
                                      record={record}
                                      server={state.selection.server}
                                      activeServer={state.selection.server === server.key}
                                      openSession={openSession}
                                    />
                                  )}
                                </For>
                              </div>
                            </div>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </Show>
                </div>
              </ScrollView>
            </div>
          </Show>
        </section>
      </div>
      <HomeStatusLine
        project={composerProject() ? displayName(composerProject()!) : undefined}
        directory={composerProject()?.worktree}
        branch={composerBranch()}
        health={serverHealth()}
      />
    </div>
  )
}

function HomeIdentity(props: { version?: string; updatePolicy?: boolean | "notify"; ready: boolean }) {
  const update = () => {
    if (!props.ready) return { glyph: "◐", label: "syncing", class: "text-v2-state-fg-thinking" }
    if (props.updatePolicy === false) return { glyph: "○", label: "updates off", class: "text-v2-text-text-faint" }
    if (props.updatePolicy === true) return { glyph: "●", label: "auto-update on", class: "text-v2-state-fg-success" }
    return { glyph: "●", label: "update checks on", class: "text-v2-state-fg-success" }
  }
  return (
    <div data-component="home-identity" class="mb-5 flex min-w-0 items-center gap-2.5">
      <span class="flex size-7 shrink-0 items-center justify-center rounded-[var(--v2-radius-chip)] bg-v2-background-bg-accent p-1.5 text-v2-text-text-contrast">
        <Mark class="w-full" />
      </span>
      <strong class="text-[var(--v2-font-size-title)] text-v2-text-text-base">OC2</strong>
      <span class="min-w-0 truncate text-[var(--v2-font-size-meta)] text-v2-text-text-faint">
        {props.version ? `v${props.version}` : "version unavailable"} · {update().glyph}{" "}
        <span class={update().class}>{update().label}</span>
      </span>
    </div>
  )
}

function HomeComposer(props: {
  value: string
  agent: string
  model?: string
  project?: string
  enabled: boolean
  recent: boolean
  onInput: (value: string) => void
  onMove: (delta: number) => void
  onSubmit: () => void
  onResume: () => void
}) {
  const send = () => {
    if (props.value.trim()) {
      props.onSubmit()
      return
    }
    if (props.recent) props.onResume()
  }
  return (
    <div
      data-component="home-composer"
      class="overflow-hidden rounded-[var(--v2-radius-composer)] border border-v2-border-border-strong bg-v2-background-bg-layer-02 focus-within:border-v2-border-border-focus focus-within:shadow-[var(--v2-shadow-focus)]"
    >
      <textarea
        autofocus
        rows={3}
        value={props.value}
        disabled={!props.enabled}
        aria-label="Message"
        placeholder={props.enabled ? 'Ask anything… e.g. "Fix a TODO in the codebase"' : "Open a project to start"}
        class="block min-h-20 w-full resize-none border-0 bg-transparent px-4 py-3 text-[var(--v2-font-size-title)] text-v2-text-text-base outline-none placeholder:text-v2-text-text-faint disabled:cursor-not-allowed"
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.isComposing || event.altKey || event.metaKey || event.ctrlKey) return
          if (!props.value.trim() && props.recent && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault()
            props.onMove(event.key === "ArrowDown" ? 1 : -1)
            return
          }
          if (event.key !== "Enter" || event.shiftKey) return
          event.preventDefault()
          send()
        }}
      />
      <div class="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-v2-border-border-muted bg-v2-background-bg-layer-01 px-2 py-1.5">
        <span class="max-w-32 truncate rounded-[var(--v2-radius-chip)] bg-v2-background-bg-layer-03 px-2 py-1 text-[var(--v2-font-size-meta)] font-semibold text-v2-text-text-base">
          ▸ {props.agent}
        </span>
        <Show when={props.model}>
          {(model) => (
            <span class="max-w-48 truncate rounded-[var(--v2-radius-chip)] bg-v2-background-bg-layer-03 px-2 py-1 text-[var(--v2-font-size-meta)] text-v2-text-text-muted">
              {model()}
            </span>
          )}
        </Show>
        <Show when={props.project}>
          {(project) => (
            <span class="max-w-40 truncate rounded-[var(--v2-radius-chip)] bg-v2-background-bg-layer-03 px-2 py-1 text-[var(--v2-font-size-meta)] text-v2-text-text-muted sm:max-w-56">
              {project()}
            </span>
          )}
        </Show>
        <span class="ml-auto hidden text-[var(--v2-font-size-meta)] text-v2-text-text-faint sm:inline">
          Enter continue · Shift+Enter newline
        </span>
        <ButtonV2 variant="contrast" size="normal" disabled={!props.enabled || !props.value.trim()} onClick={send}>
          Continue ⏎
        </ButtonV2>
      </div>
    </div>
  )
}

function HomeRecentSessions(props: {
  loading: boolean
  error: boolean
  records: HomeSessionRecord[]
  total?: number
  cursor: number
  onCursor: (cursor: number) => void
  onMove: (delta: number) => void
  onResume: (session: Session) => void
  onShowAll: () => void
  onRetry: () => void
  onOpenProject?: () => void
}) {
  const language = useLanguage()
  const active = () => props.records[props.cursor]
  return (
    <div data-component="home-recent-sessions" class="mt-7 min-w-0">
      <div class="mb-2 flex min-w-0 items-center justify-between gap-3">
        <span class="text-[var(--v2-font-size-label)] font-bold tracking-[0.12em] text-v2-text-text-faint">
          RECENT SESSIONS <span class="font-normal tracking-normal">{props.records.length}</span>
        </span>
        <div class="flex shrink-0 items-center gap-2">
          <KeyHintV2 shortcut="↑↓" label="select" decorative />
          <KeyHintV2 shortcut="Enter" label="resume" decorative />
        </div>
      </div>
      <Show when={!props.loading} fallback={<StateBlockV2 variant="loading" title="Loading sessions…" />}>
        <Show
          when={!props.error}
          fallback={
            <StateBlockV2
              variant="error"
              title="Couldn't load sessions"
              description="Check the server connection and retry."
              action={
                <ButtonV2 variant="contrast" size="normal" onClick={props.onRetry}>
                  Retry
                </ButtonV2>
              }
            />
          }
        >
          <Show
            when={props.records.length > 0}
            fallback={
              <StateBlockV2
                variant="empty"
                title="No sessions yet"
                description={
                  props.onOpenProject
                    ? "Open a project to create your first session."
                    : "Start typing above to create one — your sessions will appear here."
                }
                action={
                  props.onOpenProject ? (
                    <ButtonV2 variant="contrast" size="normal" onClick={props.onOpenProject}>
                      Open project
                    </ButtonV2>
                  ) : undefined
                }
              />
            }
          >
            <div class="overflow-hidden rounded-[var(--v2-radius-group)] border border-v2-border-border-base">
              <div
                role="listbox"
                tabIndex={0}
                aria-label="Recent sessions"
                aria-activedescendant={active() ? `home-recent-session-${homeSessionSearchKey(active()!)}` : undefined}
                class="focus-visible:outline-none focus-visible:shadow-[var(--v2-shadow-focus)]"
                onKeyDown={(event) => {
                  if (event.altKey || event.ctrlKey || event.metaKey) return
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault()
                    props.onMove(event.key === "ArrowDown" ? 1 : -1)
                    return
                  }
                  if (/^[1-3]$/.test(event.key)) {
                    const record = props.records[Number(event.key) - 1]
                    if (!record) return
                    event.preventDefault()
                    props.onCursor(Number(event.key) - 1)
                    return
                  }
                  if (event.key !== "Enter" || event.isComposing) return
                  event.preventDefault()
                  const record = active()
                  if (record) props.onResume(record.session)
                }}
              >
                <For each={props.records}>
                  {(record, index) => {
                    const selected = () => index() === props.cursor
                    const tokens = () => homeSessionTokenCount(record.session)
                    const live = () => record.status === "busy" || record.status === "retry"
                    const meta = () =>
                      [
                        record.session.agent,
                        tokens() === undefined
                          ? undefined
                          : `${Intl.NumberFormat(language.intl(), { notation: "compact", maximumFractionDigits: 1 }).format(tokens()!)} tok`,
                        DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
                          .setLocale(language.intl())
                          .toRelative(),
                      ]
                        .filter((value): value is string => !!value)
                        .join(" · ")
                    return (
                      <button
                        type="button"
                        role="option"
                        tabIndex={-1}
                        id={`home-recent-session-${homeSessionSearchKey(record)}`}
                        aria-selected={selected()}
                        class="flex h-8 w-full min-w-0 items-center gap-2 border-0 border-b border-v2-border-border-muted px-3 text-left last:border-b-0 hover:bg-v2-background-bg-layer-02 data-[selected]:bg-v2-background-bg-layer-02 focus-visible:outline-none"
                        data-selected={selected() ? "" : undefined}
                        onMouseEnter={() => props.onCursor(index())}
                        onFocus={() => props.onCursor(index())}
                        onClick={() => props.onResume(record.session)}
                      >
                        <span
                          aria-hidden="true"
                          class={
                            selected()
                              ? "w-2 shrink-0 text-v2-text-text-accent"
                              : live()
                                ? "w-2 shrink-0 text-v2-state-fg-success"
                                : "w-2 shrink-0 text-v2-text-text-faint"
                          }
                        >
                          {selected() ? "▸" : live() ? "●" : "·"}
                        </span>
                        <span
                          class={`min-w-0 flex-1 truncate text-[var(--v2-font-size-small)] ${selected() ? "font-semibold text-v2-text-text-base" : "text-v2-text-text-muted"}`}
                        >
                          {sessionTitle(record.session.title) || record.session.id}
                        </span>
                        <Show when={live()}>
                          <span class="shrink-0 text-[var(--v2-font-size-meta)] text-v2-state-fg-success">live</span>
                        </Show>
                        <span class="max-w-[52%] shrink-0 truncate whitespace-nowrap text-right text-[var(--v2-font-size-meta)] text-v2-text-text-faint sm:max-w-none">
                          {meta()}
                        </span>
                      </button>
                    )
                  }}
                </For>
              </div>
              <button
                type="button"
                class="flex h-8 w-full min-w-0 items-center gap-2 border-t border-v2-border-border-muted px-3 text-left text-[var(--v2-font-size-small)] text-v2-text-text-faint hover:bg-v2-background-bg-layer-02 focus-visible:outline-none focus-visible:shadow-[var(--v2-shadow-focus)]"
                onClick={props.onShowAll}
              >
                <span aria-hidden="true" class="w-2 shrink-0">
                  ·
                </span>
                <span class="min-w-0 flex-1 truncate">
                  {props.total === undefined ? "Show all sessions…" : `Show all ${props.total} sessions…`}
                </span>
                <KeyHintV2 shortcut="Ctrl+O" decorative />
              </button>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}

function HomeStatusLine(props: { project?: string; directory?: string; branch?: string; health?: boolean }) {
  return (
    <div
      data-component="home-status-line"
      role="status"
      aria-label={`${props.project ?? "No project"}${props.branch ? `, branch ${props.branch}` : ""}, ${props.health === undefined ? "checking server" : props.health ? "server connected" : "server unavailable"}`}
      class="flex h-8 min-w-0 shrink-0 items-center gap-2 border-t border-v2-border-border-muted bg-v2-background-bg-layer-01 px-3 text-[var(--v2-font-size-meta)] text-v2-text-text-muted"
    >
      <span class={props.health === false ? "text-v2-state-fg-danger" : "text-v2-state-fg-success"} aria-hidden="true">
        {props.health === undefined ? "○" : props.health ? "●" : "✕"}
      </span>
      <span class="max-w-[25%] shrink-0 truncate">{props.project ?? "No project"}</span>
      <Show when={props.directory}>{(directory) => <span class="min-w-0 flex-1 truncate">{directory()}</span>}</Show>
      <Show when={props.branch}>{(branch) => <span class="max-w-[25%] shrink truncate">: {branch()}</span>}</Show>
      <span class="ml-auto hidden shrink-0 text-v2-text-text-faint sm:inline">
        {props.health === undefined ? "checking server" : props.health ? "server connected" : "server unavailable"}
      </span>
    </div>
  )
}

function HomeProjectColumn(props: {
  projects: LocalProject[]
  selected: HomeProjectSelection
  focusServer: (server: ServerConnection.Any) => void
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  chooseProject: (server: ServerConnection.Any) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  clearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  unseenCount: (server: ServerConnection.Any, project: LocalProject) => number
  openSettings: () => void
  openHelp: () => void
  language: ReturnType<typeof useLanguage>
}) {
  const global = useGlobal()
  const dialog = useDialog()
  const controller = useServerManagementController({ navigateOnAdd: false })
  return (
    <aside class="flex min-w-0 flex-col lg:pt-[52px] mt-14 gap-4" aria-label={props.language.t("home.projects")}>
      <div class="flex h-7 min-w-0 items-center justify-between pl-1.5">
        <div class={HOME_SECTION_LABEL}>{props.language.t("home.projects")}</div>
        <Show when={global.servers.list().length === 1}>
          <IconButtonV2
            data-action="home-add-project"
            variant="ghost-muted"
            size="large"
            class="titlebar-icon [&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
            icon={<IconV2 name="folder-add-left" />}
            onClick={() => props.chooseProject(global.servers.list()[0]!)}
            aria-label={props.language.t("home.project.add")}
          />
        </Show>
      </div>
      <Show
        when={global.servers.list().length > 1}
        fallback={<HomeProjectList {...props} server={global.servers.list()[0]!} />}
      >
        <For each={global.servers.list()}>
          {(item) => {
            const key = ServerConnection.key(item)
            const healthy = () => !!global.servers.health[key]?.healthy
            const serverCtx = global.createServerCtx(item)
            return (
              <div class="flex max-h-[min(572px,calc(100vh_-_300px))] min-w-0 flex-col gap-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <HomeServerRow
                  server={item}
                  selected={props.selected.server === key && !props.selected.directory}
                  healthy={healthy()}
                  health={global.servers.health[key]}
                  controller={controller}
                  focusServer={props.focusServer}
                  chooseProject={props.chooseProject}
                  openEdit={(server) => dialog.show(() => <DialogServerV2 mode="edit" server={server} />)}
                  language={props.language}
                />
                <Show when={healthy()}>
                  <div class="mx-3 h-px bg-v2-border-border-base" />
                  <HomeProjectList {...props} server={item} projects={serverCtx.projects.list()} />
                </Show>
              </div>
            )
          }}
        </For>
      </Show>
      <div class="mt-4 flex min-w-0 flex-col gap-1">
        <button
          type="button"
          class={`${HOME_PROJECT_NAV_ROW} text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted`}
          onClick={props.openSettings}
        >
          <IconV2 name="settings-gear" size="small" />
          <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("sidebar.settings")}</span>
        </button>
        <button
          type="button"
          class={`${HOME_PROJECT_NAV_ROW} text-v2-text-text-faint [&>[data-slot=icon-svg]]:text-v2-icon-icon-muted`}
          onClick={props.openHelp}
        >
          <IconV2 name="help" size="small" />
          <span class={HOME_PROJECT_NAV_LABEL}>{props.language.t("sidebar.help")}</span>
        </button>
      </div>
    </aside>
  )
}

function HomeServerRow(props: {
  server: ServerConnection.Any
  selected: boolean
  healthy: boolean
  health: ServerHealth | undefined
  controller: ReturnType<typeof useServerManagementController>
  focusServer: (server: ServerConnection.Any) => void
  chooseProject: (server: ServerConnection.Any) => void
  openEdit: (server: ServerConnection.Http) => void
  language: ReturnType<typeof useLanguage>
}) {
  const [state, setState] = createStore({ menuOpen: false })
  return (
    <div class="group/server relative flex h-7 min-w-0 items-center rounded-[6px]">
      <button
        type="button"
        class={`${HOME_PROJECT_NAV_ROW} pr-16 disabled:opacity-60`}
        data-selected={props.selected ? "" : undefined}
        disabled={!props.healthy}
        onClick={() => props.focusServer(props.server)}
      >
        <div class="flex size-4 shrink-0 items-center justify-center">
          <ServerHealthIndicator health={props.health} />
        </div>
        <span class="flex min-w-0 items-center gap-1">
          <span class={HOME_PROJECT_NAV_LABEL}>{props.server.displayName ?? new URL(props.server.http.url).host}</span>
          <Show when={props.server.label}>
            {(label) => (
              <span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1 py-0.5 text-[9px] leading-none text-v2-text-text-muted">
                {label()}
              </span>
            )}
          </Show>
        </span>
      </button>
      <div
        class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/server:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
        data-menu={state.menuOpen}
      >
        <ServerRowMenu
          server={props.server}
          controller={props.controller}
          onEdit={props.openEdit}
          open={state.menuOpen}
          onOpenChange={(open) => setState("menuOpen", open)}
        />
        <IconButtonV2
          data-action="home-add-project"
          variant="ghost-muted"
          size="small"
          icon={<IconV2 name="folder-add-left" />}
          aria-label={props.language.t("home.project.add")}
          onClick={() => props.chooseProject(props.server)}
        />
      </div>
    </div>
  )
}

function HomeProjectList(props: {
  server: ServerConnection.Any
  projects: LocalProject[]
  selected: HomeProjectSelection
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  clearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  unseenCount: (server: ServerConnection.Any, project: LocalProject) => number
  language: ReturnType<typeof useLanguage>
}) {
  return (
    <div class="flex min-w-0 flex-col gap-1">
      <For each={props.projects}>
        {(project) => (
          <HomeProjectRow
            project={project}
            server={props.server}
            selected={
              props.selected.server === ServerConnection.key(props.server) &&
              props.selected.directory === project.worktree
            }
            unseenCount={props.unseenCount(props.server, project)}
            selectProject={props.selectProject}
            openNewSession={props.openNewSession}
            editProject={props.editProject}
            closeProject={props.closeProject}
            clearNotifications={props.clearNotifications}
            language={props.language}
          />
        )}
      </For>
    </div>
  )
}

function HomeProjectRow(props: {
  project: LocalProject
  server: ServerConnection.Any
  selected: boolean
  unseenCount: number
  selectProject: (server: ServerConnection.Any, directory: string) => void
  openNewSession: (server: ServerConnection.Any, directory: string) => void
  editProject: (server: ServerConnection.Any, project: LocalProject) => void
  closeProject: (server: ServerConnection.Any, directory: string) => void
  clearNotifications: (server: ServerConnection.Any, project: LocalProject) => void
  language: ReturnType<typeof useLanguage>
}) {
  const [state, setState] = createStore({ menuOpen: false })
  return (
    <div class="group/project relative flex h-7 min-w-0 items-center rounded-[6px]">
      <button
        type="button"
        data-component="home-project-row"
        class={`${HOME_PROJECT_NAV_ROW} pr-16`}
        data-selected={props.selected ? "" : undefined}
        aria-current={props.selected ? "page" : undefined}
        onClick={() => props.selectProject(props.server, props.project.worktree)}
      >
        <HomeProjectAvatar project={props.project} />
        <span class={HOME_PROJECT_NAV_LABEL}>{displayName(props.project)}</span>
      </button>
      <div
        class="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/project:opacity-100 focus-within:opacity-100 data-[menu=true]:opacity-100"
        data-menu={state.menuOpen}
      >
        <IconButtonV2
          data-action="home-project-new-session"
          variant="ghost-muted"
          size="small"
          icon={<IconV2 name="edit" />}
          aria-label={props.language.t("command.session.new")}
          onClick={() => props.openNewSession(props.server, props.project.worktree)}
        />
        <MenuV2
          gutter={4}
          modal={false}
          placement="bottom-end"
          open={state.menuOpen}
          onOpenChange={(open) => setState("menuOpen", open)}
        >
          <MenuV2.Trigger
            as={IconButtonV2}
            data-action="home-project-menu"
            variant="ghost-muted"
            size="small"
            icon={<IconV2 name="outline-dots" />}
            aria-label={props.language.t("common.moreOptions")}
          />
          <MenuV2.Portal>
            <MenuV2.Content>
              <MenuV2.Item onSelect={() => props.openNewSession(props.server, props.project.worktree)}>
                {props.language.t("command.session.new")}
              </MenuV2.Item>
              <MenuV2.Item onSelect={() => props.editProject(props.server, props.project)}>
                {props.language.t("common.edit")}
              </MenuV2.Item>
              <MenuV2.Item
                disabled={props.unseenCount === 0}
                onSelect={() => props.clearNotifications(props.server, props.project)}
              >
                {props.language.t("sidebar.project.clearNotifications")}
              </MenuV2.Item>
              <MenuV2.Separator />
              <MenuV2.Item onSelect={() => props.closeProject(props.server, props.project.worktree)}>
                {props.language.t("common.close")}
              </MenuV2.Item>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </div>
    </div>
  )
}

function HomeProjectAvatar(props: { project: LocalProject }) {
  const name = createMemo(() => displayName(props.project))
  return (
    <ProjectAvatar
      fallback={name()}
      src={getProjectAvatarSource(props.project.id, props.project.icon)}
      variant={getProjectAvatarVariant(props.project.icon?.color)}
    />
  )
}

function HomeSessionAvatar(props: { project: LocalProject; session: Session; activeServer: boolean }) {
  const directory = () => props.session.directory
  const sessionId = () => props.session.id
  const state = useSessionTabAvatarState(directory, sessionId, () => props.activeServer)
  return (
    <ProjectAvatar
      fallback={displayName(props.project)}
      src={getProjectAvatarSource(props.project.id, props.project.icon)}
      variant={getProjectAvatarVariant(props.project.icon?.color)}
      unread={state.unread()}
      loading={state.loading()}
    />
  )
}

function HomeSessionLeading(props: {
  project: LocalProject
  session: Session
  server: ServerConnection.Key
  activeServer: boolean
}) {
  const tabs = useTabs()
  const hasOpenTab = createMemo(() => sessionHasOpenTab(tabs.store, props.server, props.session))
  return (
    <div class="relative shrink-0">
      <Show when={hasOpenTab()}>
        <span
          aria-hidden="true"
          class="pointer-events-none absolute top-1/2 h-[7px] w-[3px] -translate-y-1/2 rounded-[2px] bg-v2-background-bg-layer-04"
          style={{ right: "calc(100% + 12px)" }}
        />
      </Show>
      <HomeSessionAvatar project={props.project} session={props.session} activeServer={props.activeServer} />
    </div>
  )
}

function HomeSessionSearch(props: {
  value: string
  placeholder: string
  open: boolean
  loading: boolean
  results: HomeSessionRecord[]
  server: ServerConnection.Key
  activeServer: boolean
  noResultsLabel: string
  bindFocus: (focus: () => void) => void
  onInput: (value: string) => void
  onFocus: () => void
  onClose: () => void
  onEscape?: () => void
  onSelect: (session: Session) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({ active: "" })
  let root: HTMLDivElement | undefined
  let input: HTMLInputElement | undefined
  let listRef: HTMLDivElement | undefined

  const focusInput = () => {
    input?.focus()
    props.onFocus()
  }

  onMount(() => {
    props.bindFocus(focusInput)
  })

  const syncActive = (results: HomeSessionRecord[]) => {
    if (results.length === 0) {
      setStore("active", "")
      return
    }
    if (!results.some((record) => homeSessionSearchKey(record) === store.active)) {
      setStore("active", homeSessionSearchKey(results[0]))
    }
  }

  createEffect(() => syncActive(props.results))

  createEffect(
    on(
      () => props.value,
      () => syncActive(props.results),
    ),
  )

  const scrollActiveIntoView = () => {
    const key = store.active
    if (!key || !listRef) return
    const element = listRef.querySelector<HTMLElement>(`[data-key="${key}"]`)
    element?.scrollIntoView({ block: "nearest" })
  }

  const moveActive = (delta: number) => {
    const results = props.results
    if (results.length === 0) return
    const index = results.findIndex((record) => homeSessionSearchKey(record) === store.active)
    const start = index === -1 ? 0 : index
    const next = (start + delta + results.length) % results.length
    setStore("active", homeSessionSearchKey(results[next]))
    scrollActiveIntoView()
  }

  const selectActive = () => {
    const record = props.results.find((item) => homeSessionSearchKey(item) === store.active)
    if (!record) return
    props.onSelect(record.session)
  }

  onCleanup(
    makeEventListener(document, "pointerdown", (event) => {
      if (!props.open) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (root?.contains(target)) return
      props.onClose()
    }),
  )

  return (
    <div class="ml-4 mr-2 w-[calc(100%_-_24px)]">
      <div ref={root} data-component="home-session-search" class="relative z-10 w-full">
        <Show when={props.open}>
          <div
            data-component="home-session-search-panel"
            class="absolute flex flex-col rounded-[12px] bg-v2-background-bg-base shadow-[var(--v2-elevation-floating)]"
            style={{
              top: "-6px",
              left: "-6px",
              width: "calc(100% + 14px)",
            }}
          >
            <div class="flex flex-col pt-9">
              <div id={HOME_SESSION_SEARCH_RESULTS_ID} role="listbox" class="flex flex-col gap-4 pt-4 pb-2">
                <Show
                  when={!props.loading}
                  fallback={
                    <div class="px-4 py-3">
                      <StateBlockV2 variant="loading" title="Loading sessions…" />
                    </div>
                  }
                >
                  <Show
                    when={props.results.length > 0}
                    fallback={
                      <div class="px-4 py-3">
                        <StateBlockV2 variant="empty" title={props.noResultsLabel} />
                      </div>
                    }
                  >
                    <div class="flex flex-col">
                      <p class="my-1.5 px-4 text-[13px] leading-4 tracking-[-0.04px] text-v2-text-text-muted [font-weight:440]">
                        {language.t("home.sessions.search.sessions")}
                      </p>
                      <div ref={listRef} class="flex max-h-80 flex-col gap-px overflow-y-auto">
                        <For each={props.results}>
                          {(record) => (
                            <HomeSessionSearchResultRow
                              record={record}
                              server={props.server}
                              activeServer={props.activeServer}
                              selected={store.active === homeSessionSearchKey(record)}
                              onHighlight={() => setStore("active", homeSessionSearchKey(record))}
                              onSelect={(session) => props.onSelect(session)}
                            />
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                </Show>
              </div>
            </div>
          </div>
        </Show>
        <label
          class="relative z-20 flex h-9 w-full items-center gap-2 rounded-[6px] py-1 pl-3 pr-2 text-v2-icon-icon-muted transition-[background-color,box-shadow] duration-[120ms] ease-in-out"
          classList={{
            "bg-v2-background-bg-deep focus-within:bg-v2-background-bg-base focus-within:shadow-[0_0_0_0.5px_var(--v2-border-border-focus),var(--v2-elevation-raised)]":
              !props.open,
            "bg-transparent shadow-[0_0_0_0.5px_var(--v2-border-border-focus)]": props.open,
          }}
        >
          <IconV2 name="magnifying-glass" />
          <input
            ref={input}
            class="relative z-20 min-w-0 flex-1 border-0 bg-transparent text-v2-text-text-base outline-0 [font-weight:440] placeholder:text-v2-text-text-faint"
            value={props.value}
            placeholder={props.placeholder}
            aria-label={props.placeholder}
            aria-expanded={props.open}
            aria-controls={HOME_SESSION_SEARCH_RESULTS_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              store.active && props.open ? `home-session-search-option-${store.active}` : undefined
            }
            onFocus={() => props.onFocus()}
            onInput={(event) => props.onInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                props.onClose()
                props.onEscape?.()
                input?.blur()
                return
              }
              if (!props.open || props.results.length === 0) return
              if (event.altKey || event.metaKey) return
              if (event.key === "ArrowDown") {
                event.preventDefault()
                moveActive(1)
                return
              }
              if (event.key === "ArrowUp") {
                event.preventDefault()
                moveActive(-1)
                return
              }
              if (event.key === "Enter" && !event.isComposing) {
                event.preventDefault()
                selectActive()
              }
            }}
          />
          <Show when={props.value}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="relative z-20 shrink-0"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              aria-label={props.placeholder}
              onClick={() => {
                props.onClose()
                input?.focus()
              }}
            />
          </Show>
        </label>
      </div>
    </div>
  )
}

function HomeSessionSearchResultRow(props: {
  record: HomeSessionRecord
  server: ServerConnection.Key
  activeServer: boolean
  selected: boolean
  onHighlight: () => void
  onSelect: (session: Session) => void
}) {
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)

  const key = () => homeSessionSearchKey(props.record)

  return (
    <button
      type="button"
      id={`home-session-search-option-${key()}`}
      data-key={key()}
      data-component="home-session-search-row"
      role="option"
      aria-selected={props.selected}
      classList={{
        [HOME_SEARCH_RESULT_ROW]: true,
        "bg-v2-overlay-simple-overlay-hover": props.selected,
      }}
      onMouseEnter={() => props.onHighlight()}
      onClick={() => props.onSelect(props.record.session)}
    >
      <HomeSessionLeading
        project={props.record.project}
        session={props.record.session}
        server={props.server}
        activeServer={props.activeServer}
      />
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          class={`${HOME_SEARCH_RESULT_TITLE} ${props.record.projectName ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
        >
          {title()}
        </span>
        <Show when={props.record.projectName}>
          <span class={HOME_SEARCH_RESULT_META}>{props.record.projectName}</span>
        </Show>
      </div>
    </button>
  )
}

function HomeSessionGroupHeader(props: { title: string; onNewSession?: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex h-7 min-w-0 items-center justify-between pl-4 pr-2">
      <div class={HOME_SECTION_LABEL}>{props.title}</div>
      <Show when={props.onNewSession}>
        {(onNewSession) => (
          <ButtonV2
            data-action="home-new-session"
            variant="ghost-muted"
            size="normal"
            icon="edit"
            class="h-7 px-2 [font-weight:530]"
            onClick={onNewSession()}
          >
            {language.t("command.session.new")}
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

function HomeSessionRow(props: {
  record: HomeSessionRecord
  server: ServerConnection.Key
  activeServer: boolean
  openSession: (session: Session) => void
}) {
  const title = createMemo(() => sessionTitle(props.record.session.title) || props.record.session.id)

  return (
    <button
      type="button"
      data-component="home-session-row"
      class={`${HOME_ROW} h-10 gap-2 px-6 py-3 pl-4`}
      onClick={() => props.openSession(props.record.session)}
    >
      <HomeSessionLeading
        project={props.record.project}
        session={props.record.session}
        server={props.server}
        activeServer={props.activeServer}
      />
      <span
        class={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-base [font-weight:530] ${props.record.projectName ? "max-w-[min(70%,480px)] flex-[0_1_auto]" : "flex-[1_1_auto]"}`}
      >
        {title()}
      </span>
      <Show when={props.record.projectName}>
        <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap text-v2-text-text-muted [font-weight:440]">
          {props.record.projectName}
        </span>
      </Show>
    </button>
  )
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  const todaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = records.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")

  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}

function LegacyHome() {
  const sync = useServerSync()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const navigate = useNavigate()
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const homedir = createMemo(() => sync.data.path.home)
  const recent = createMemo(() => {
    return sync.data.project
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
      .slice(0, 5)
  })

  const serverDotClass = createMemo(() => {
    const healthy = global.servers.health[server.key]?.healthy
    if (healthy === true) return "bg-icon-success-base"
    if (healthy === false) return "bg-icon-critical-base"
    return "bg-border-weak-base"
  })

  function openProject(server: ServerConnection.Any, directory: string) {
    const serverCtx = global.createServerCtx(server)
    serverCtx.projects.open(directory)
    serverCtx.projects.touch(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  function chooseProject() {
    const s = server.current
    if (!s) return

    const resolve = (result: string | string[] | null) => {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(s, directory)
        }
      } else if (result) {
        openProject(s, result)
      }
    }

    pickDirectory({
      server: s,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: resolve,
    })
  }

  return (
    <div class="mx-auto mt-55 w-full md:w-auto px-4">
      <Logo class="md:w-xl opacity-12" />
      <Button
        size="large"
        variant="ghost"
        class="mt-4 mx-auto text-14-regular text-text-weak"
        onClick={() => dialog.show(() => <DialogSelectServer />)}
      >
        <div
          classList={{
            "size-2 rounded-full": true,
            [serverDotClass()]: true,
          }}
        />
        {server.name}
      </Button>
      <Switch>
        <Match when={sync.data.project.length > 0}>
          <div class="mt-20 w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">{language.t("home.recentProjects")}</div>
              <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={chooseProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
            <ul class="flex flex-col gap-2">
              <For each={recent()}>
                {(project) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="text-14-mono text-left justify-between px-3"
                    onClick={() => openProject(server.current!, project.worktree)}
                  >
                    {project.worktree.replace(homedir(), "~")}
                    <div class="text-14-regular text-text-weak">
                      {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
                    </div>
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={!sync.ready}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <div class="text-12-regular text-text-weak">{language.t("common.loading")}</div>
            <Button class="px-3" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">{language.t("home.empty.title")}</div>
              <div class="text-12-regular text-text-weak">{language.t("home.empty.description")}</div>
            </div>
            <Button class="px-3 mt-1" onClick={chooseProject}>
              {language.t("command.project.open")}
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
