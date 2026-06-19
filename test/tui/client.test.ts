import { expect, test } from "bun:test"

import { createCommandRegistry } from "../../src/commands/registry"
import { createRuntimeEventBus, defaultConfig, openOc2Database } from "../../src"
import { createSessionRunService } from "../../src/session/run"
import { createLocalTuiClient } from "../../src/tui/client.local"
import { createInitialTuiState, projectTuiEvent } from "../../src/tui/state"
import { createScriptedModelProvider, simpleAssistantEvents } from "../agent/helpers"

test("prompt submission preserves model variant, options, roots, and signal", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([simpleAssistantEvents])
  const fixture = createClientFixture({ db, provider })
  const controller = new AbortController()

  const result = await fixture.client.sessions.prompt({
    prompt: "hello",
    model: "fake/test",
    modelVariant: "fast",
    modelVariantOptions: { effort: "low" },
    roots: ["../other"],
    signal: controller.signal,
  })

  expect(result.sessionId).toBeString()
  expect(provider.requests[0]?.providerOptions).toMatchObject({ effort: "low", variant: "fast" })
  expect(provider.requests[0]?.signal).toBeInstanceOf(AbortSignal)
  expect(fixture.service.sessions.resumeSession(result.sessionId)?.workspaceRoots.map((root) => root.path)).toEqual([
    "/other",
  ])
  db.close()
})

test("command dispatch preserves args, session, model variant, roots, and cancellation context", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([simpleAssistantEvents, simpleAssistantEvents])
  const registry = createCommandRegistry([
    { name: "check", description: "check args", source: "user", template: "Check this: $ARGUMENTS" },
  ])
  const fixture = createClientFixture({ db, provider, registry })
  const first = await fixture.client.sessions.prompt({ prompt: "first", model: "fake/test", roots: ["/repo"] })

  const result = await fixture.client.commands.execute({
    sessionId: first.sessionId,
    name: "check",
    args: ["diff", "--stat"],
    raw: "/check diff --stat",
    model: "fake/test",
    modelVariant: "fast",
    modelVariantOptions: { effort: "low" },
    roots: ["/repo"],
  })

  expect(result).toMatchObject({ ok: true, sessionId: first.sessionId })
  expect(provider.requests[1]?.providerOptions).toMatchObject({ effort: "low", variant: "fast" })
  expect(provider.requests[1]?.messages.filter((message) => message.role === "user").at(-1)?.content).toContain(
    "Check this: diff --stat",
  )
  db.close()
})

test("abort cancels an active run for a known session", async () => {
  const events = createRuntimeEventBus({ initialState: createInitialTuiState(true), projector: projectTuiEvent })
  const service = {
    sessions: {
      listSessions: () => [],
      resumeSession: () => undefined,
      messages: { listBySession: () => [] },
      toolCalls: { listBySession: () => [] },
    },
    async run(input: { readonly signal?: AbortSignal }) {
      await new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true })
      })
      return { sessionId: "s1" }
    },
    async command() {
      return { sessionId: "s1", status: "completed", errors: [] }
    },
  }
  const client = createLocalTuiClient({
    service: service as never,
    events,
    commands: createCommandRegistry(),
    initialState: createInitialTuiState(true),
  })

  const running = client.sessions.prompt({ sessionId: "s1", prompt: "second", model: "fake/test", roots: ["/repo"] })
  await client.sessions.abort("s1")

  await expect(running).rejects.toThrow("Cancelled from TUI")
})

test("abort cancels a new-session run after session creation is published", async () => {
  const events = createRuntimeEventBus({ initialState: createInitialTuiState(true), projector: projectTuiEvent })
  const service = {
    sessions: {
      listSessions: () => [],
      resumeSession: () => undefined,
      messages: { listBySession: () => [] },
      toolCalls: { listBySession: () => [] },
    },
    async run(input: { readonly signal?: AbortSignal }) {
      events.publish({ type: "session.created", payload: { sessionId: "created-session" } })
      await new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true })
      })
      return { sessionId: "created-session" }
    },
    async command() {
      return { sessionId: "created-session", status: "completed", errors: [] }
    },
  }
  const client = createLocalTuiClient({
    service: service as never,
    events,
    commands: createCommandRegistry(),
    initialState: createInitialTuiState(true),
  })

  const running = client.sessions.prompt({ prompt: "new", model: "fake/test", roots: ["/repo"] })
  await Bun.sleep(0)
  await client.sessions.abort("created-session")

  await expect(running).rejects.toThrow("Cancelled from TUI")
})

test("hydrate returns persisted transcript and restores persisted model variant", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const fixture = createClientFixture({ db })
  const run = await fixture.client.sessions.prompt({
    prompt: "hello",
    model: "fake/test",
    modelVariant: "fast",
    roots: ["/repo"],
  })

  const hydrated = await fixture.client.sessions.hydrate(run.sessionId)

  expect(hydrated.session).toMatchObject({ id: run.sessionId, roots: ["/repo"] })
  expect(hydrated.state.sessionId).toBe(run.sessionId)
  expect(hydrated.state.messages.map((message) => message.role)).toEqual(["user", "assistant"])
  expect(hydrated.state.modelSelection).toMatchObject({ providerId: "fake", modelId: "test", variantId: "fast" })
  db.close()
})

test("hydrate failure returns an empty session state with a diagnostic", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const fixture = createClientFixture({ db })

  const hydrated = await fixture.client.sessions.hydrate("missing-session")

  expect(hydrated.session).toEqual({ id: "", roots: ["/repo"] })
  expect(hydrated.state.sessionId).toBeUndefined()
  expect(hydrated.state.diagnostics[0]?.message).toContain("Failed to hydrate session missing-session")
  expect((await fixture.client.status.snapshot()).diagnostics[0]).toContain("missing-session")
  db.close()
})

test("session listing maps summaries and filters by roots", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const fixture = createClientFixture({ db })
  fixture.service.sessions.createSession({
    id: "older",
    title: "Older",
    workspaceRoots: [{ path: "/repo", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    now: "2024-01-01T00:00:00.000Z",
  })
  fixture.service.sessions.createSession({
    id: "newer",
    title: "Newer",
    workspaceRoots: [{ path: "/other", readonly: false }],
    providerId: "fake",
    modelId: "test",
    agentId: "main",
    now: "2024-01-02T00:00:00.000Z",
  })

  expect((await fixture.client.sessions.list()).map((session) => session.id)).toEqual(["newer", "older"])
  expect(await fixture.client.sessions.list({ roots: ["/repo"] })).toEqual([
    { id: "older", title: "Older", roots: ["/repo"], updatedAt: "2024-01-01T00:00:00.000Z" },
  ])
  db.close()
})

test("events subscribe proxies runtime events and unsubscribe", () => {
  const db = openOc2Database({ path: ":memory:" })
  const fixture = createClientFixture({ db })
  const received: string[] = []
  const unsubscribe = fixture.client.events.subscribe((event) => received.push(event.type))

  fixture.events.publish({ type: "diagnostic.warning", payload: { message: "first" } })
  unsubscribe()
  fixture.events.publish({ type: "diagnostic.warning", payload: { message: "second" } })

  expect(received).toEqual(["diagnostic.warning"])
  db.close()
})

test("command list exposes enabled slash command metadata and unknown commands are not submitted", async () => {
  const db = openOc2Database({ path: ":memory:" })
  const provider = createScriptedModelProvider([simpleAssistantEvents])
  const registry = createCommandRegistry([
    { name: "check", description: "check args", aliases: ["c"], source: "user", template: "Check this: $ARGUMENTS" },
  ])
  const fixture = createClientFixture({ db, provider, registry })

  expect(await fixture.client.commands.list()).toEqual([
    {
      id: "check",
      title: "check",
      category: "session",
      description: "check args",
      slashName: "check",
      slashAliases: ["c"],
      source: "user",
      enabled: true,
    },
  ])
  expect(
    await fixture.client.commands.execute({ name: "missing", args: [], raw: "/missing", roots: ["/repo"] }),
  ).toEqual({
    ok: false,
    message: "Slash command not found: missing",
  })
  expect(provider.requests).toHaveLength(0)
  db.close()
})

function createClientFixture(input: {
  readonly db: ReturnType<typeof openOc2Database>
  readonly provider?: ReturnType<typeof createScriptedModelProvider>
  readonly registry?: ReturnType<typeof createCommandRegistry>
}) {
  const events = createRuntimeEventBus({
    initialState: createInitialTuiState(true),
    projector: projectTuiEvent,
  })
  const service = createSessionRunService({
    config: defaultConfig,
    cwd: "/repo",
    database: input.db,
    events,
    providers: [input.provider ?? createScriptedModelProvider([simpleAssistantEvents])],
    commands: input.registry,
  })
  const client = createLocalTuiClient({
    service,
    events,
    commands: input.registry ?? createCommandRegistry(),
    initialState: createInitialTuiState(true),
    roots: ["/repo"],
    model: "fake/test",
  })
  return { client, events, service }
}
