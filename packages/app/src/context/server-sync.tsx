import type { Config, OpencodeClient, Path, Project, ProviderAuthResponse, Todo } from "@oc2-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@oc2-ai/core/util/path"
import { batch, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { ServerSDK, useServerSDK } from "./server-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadAgentsQuery,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import {
  aggregateRefreshSessionID,
  applyDirectoryEvent,
  applyGlobalEvent,
  cleanupDroppedSessionCaches,
} from "./global-sync/event-reducer"
import { clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext, NormalizedProviderListResponse } from "@oc2-ai/ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { retry } from "@oc2-ai/core/util/retry"
import type { ServerScope } from "@/utils/server-scope"
import { persisted } from "@/utils/persist"
import { toggleMcp } from "./global-sync/mcp"
import { createSessionAuthority, mergeSessionAggregates } from "./global-sync/session-authority"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  session_todo: {
    [sessionID: string]: Todo[]
  }
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

export const loadMcpQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directory, "mcp"] as const,
    queryFn: () => sdk.mcp.status().then((r) => r.data ?? {}),
  })

export const loadLspQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directory, "lsp"] as const,
    queryFn: () => sdk.lsp.status().then((r) => r.data ?? []),
  })

function makeQueryOptionsApi(
  scope: ServerScope,
  serverSDK: () => OpencodeClient,
  sdkFor: (dir: PathKey) => OpencodeClient,
) {
  return {
    globalConfig: () => loadGlobalConfigQuery(scope, serverSDK()),
    projects: () => loadProjectsQuery(scope, serverSDK()),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    path: (directory: PathKey | null) =>
      loadPathQuery(scope, directory, directory === null ? serverSDK() : sdkFor(directory)),
    agents: (directory: PathKey) => loadAgentsQuery(scope, directory, sdkFor(directory)),
    mcp: (directory: PathKey) => loadMcpQuery(scope, directory, sdkFor(directory)),
    lsp: (directory: PathKey) => loadLspQuery(scope, directory, sdkFor(directory)),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export function createServerSyncContextInner(_serverSDK?: ServerSDK) {
  const serverSDK: ServerSDK = _serverSDK ?? useServerSDK()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()
  const sessionAuthority = createSessionAuthority()

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const queryOptionsApi = makeQueryOptionsApi(serverSDK.scope, () => serverSDK.client, sdkFor)

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [queryOptionsApi.globalConfig(), queryOptionsApi.providers(null), queryOptionsApi.path(null)],
  }))

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    session_todo: {},
    provider_auth: {},
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })

  const queryClient = useQueryClient()

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        serverSDK: serverSDK.client,
        scope: serverSDK.scope,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const setSessionTodo = (sessionID: string, todos: Todo[] | undefined) => {
    if (!sessionID) return
    if (!todos) {
      setGlobalStore(
        "session_todo",
        produce((draft) => {
          delete draft[sessionID]
        }),
      )
      return
    }
    setGlobalStore("session_todo", sessionID, reconcile(todos, { key: "id" }))
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: [serverSDK.scope, "bootstrap"] }),
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onMcp: (directory, setStore) => {
      void retry(() =>
        sdkFor(directory)
          .command.list()
          .then((x) => setStore("command", x.data ?? [])),
      ).catch((err) => {
        showToast({
          variant: "error",
          title: language.t("toast.project.reloadFailed.title", { project: getFilename(directory) }),
          description: formatServerError(err, language.t),
        })
      })
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      sdkCache.delete(key)
      sessionAuthority.reset(key)
      clearProviderRev(serverSDK.scope, key)
      clearSessionPrefetchDirectory(serverSDK.scope, key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: globalStore.provider,
    },
  })

  async function refreshSession(directory: string, sessionID: string, options?: { aggregatesOnly?: boolean }) {
    const key = directoryKey(directory)
    const generation = sessionAuthority.beginSession(key, sessionID)
    const response = await retry(() => sdkFor(key).session.get({ sessionID }))
    if (!sessionAuthority.accepts(key, sessionID, generation)) return
    const session = response.data
    if (session?.id !== sessionID) return
    const [, setStore] = children.child(key, { bootstrap: false })
    setStore(
      "session",
      produce((draft) => {
        const match = draft.findIndex((item) => item.id >= sessionID)
        if (match === -1) {
          if (options?.aggregatesOnly) return
          draft.push(session)
          return
        }
        const current = draft[match]
        if (current?.id === sessionID) {
          draft[match] = options?.aggregatesOnly ? mergeSessionAggregates(current, session) : session
          return
        }
        if (options?.aggregatesOnly) return
        draft.splice(match, 0, session)
      }),
    )
  }

  async function loadSessions(directory: string, options?: { limit?: number }) {
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) {
      await pending
      return loadSessions(directory, options)
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(key)
    const retainedLimit = Math.max(store.limit, options?.limit ?? 0, meta?.limit ?? 0)
    if (meta && meta.limit >= retainedLimit) {
      const next = trimSessions(store.session, {
        limit: retainedLimit,
        permission: store.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
        cleanupDroppedSessionCaches(store, setStore, next, setSessionTodo)
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(retainedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const generation = sessionAuthority.beginList(key)
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        queryFn: () =>
          loadRootSessionsWithFallback({
            directory,
            limit,
            list: (query) => serverSDK.client.session.list(query),
          })
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .filter((s) => !sessionAuthority.deleted(key, s.id))
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = Math.max(store.limit, options?.limit ?? 0, sessionMeta.get(key)?.limit ?? 0)
              const childSessions = store.session.filter((s) => !!s.parentID)
              const reconciled = sessionAuthority.reconcileList(key, generation, store.session, [
                ...nonArchived,
                ...childSessions,
              ])
              const sessions = trimSessions(reconciled, {
                limit,
                permission: store.permission,
              })
              batch(() => {
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
                    limit: x.limit,
                    limited: x.limited,
                  }),
                )
                setStore("session", reconcile(sessions, { key: "id" }))
                cleanupDroppedSessionCaches(store, setStore, sessions, setSessionTodo)
              })
              sessionMeta.set(key, { limit })
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        scope: serverSDK.scope,
        mcp: children.mcp(key),
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        loadSession: (sessionID) => refreshSession(key, sessionID),
        translate: language.t,
        queryClient,
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  const unsub = serverSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (event.type === "server.connected" || event.type === "global.disposed") {
        if (recent) return
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      return
    }

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    const [store, setStore] = existing
    if (event.type === "session.created") {
      const sessionID = (event.properties as { info?: { id?: string } }).info?.id
      if (sessionID) sessionAuthority.create(key, sessionID)
    }
    if (event.type === "session.deleted") {
      const sessionID = (event.properties as { info?: { id?: string } }).info?.id
      if (sessionID) sessionAuthority.remove(key, sessionID)
    }
    const updatedID =
      event.type === "session.updated" ? (event.properties as { info?: { id?: string } }).info?.id : undefined
    if (updatedID) sessionAuthority.update(key, updatedID)
    const refreshID =
      updatedID && !sessionAuthority.deleted(key, updatedID) ? updatedID : aggregateRefreshSessionID(event)
    if (refreshID) {
      void refreshSession(key, refreshID, { aggregatesOnly: refreshID === updatedID }).catch((error) => {
        if (sessionAuthority.deleted(key, refreshID)) return
        console.error("Failed to refresh session aggregates", error)
      })
    }
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: queue.push,
      setSessionTodo,
      retainedLimit: sessionMeta.get(key)?.limit,
      sessionDeleted: (sessionID) => sessionAuthority.deleted(key, sessionID),
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        void queryClient.fetchQuery(queryOptionsApi.lsp(key))
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void serverSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void serverSDK.event.start()
      }, 0)
    }
  })

  const projectApi = {
    loadSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => serverSDK.client.global.config.update({ config }),
    onSuccess: () => {
      bootstrap.refetch()
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, null, "providers"] })
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
      })
    },
  }))

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    disableMcp: children.disableMcp,
    queryOptions: queryOptionsApi,
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    project: projectApi,
    todo: {
      set: setSessionTodo,
    },
    session: {
      refresh: refreshSession,
      beginList: (directory: string) => sessionAuthority.beginList(directoryKey(directory)),
      reconcileList: sessionAuthority.reconcileList,
    },
    mcp: {
      toggle: async (directory: string, name: string) => {
        const key = directoryKey(directory)
        const sdk = sdkFor(key)
        const status = children.child(key, { bootstrap: false })[0].mcp[name].status
        await toggleMcp({
          status,
          connect: async () => {
            await sdk.mcp.connect({ name })
          },
          disconnect: async () => {
            await sdk.mcp.disconnect({ name })
          },
          authenticate: async () => {
            await sdk.mcp.auth.authenticate({ name })
          },
          refresh: async () => {
            await queryClient.refetchQueries(queryOptionsApi.mcp(key))
          },
        })
      },
    },
  }
}

export function createServerSyncContext(_serverSDK?: ServerSDK) {
  const inner = createServerSyncContextInner(_serverSDK)
  return Object.assign(inner, {
    createDirSyncContext: createRefCountMap(
      (dir) => createDirSyncContext(dir, inner, _serverSDK),
      (dir) => inner.disableMcp(dir),
      directoryKey,
    ),
  })
}

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  gate: false,
  init: (props: { server?: ServerConnection.Any }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    const conn = props.server ?? server.current
    if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
    const ctx = global.createServerCtx(conn)

    return ctx.sync
  },
})

export function useQueryOptions() {
  return useServerSync().queryOptions
}
