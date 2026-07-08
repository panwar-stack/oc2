import { describe, expect } from "bun:test"
import { SessionV1 } from "@oc2-ai/core/v1/session"
import { Database } from "@oc2-ai/core/database/database"
import { EventV2 } from "@oc2-ai/core/event"
import { ProjectV2 } from "@oc2-ai/core/project"
import { ProjectTable } from "@oc2-ai/core/project/sql"
import { AbsolutePath } from "@oc2-ai/core/schema"
import { SessionProjector } from "@oc2-ai/core/session/projector"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { Project } from "@/project/project"
import path from "path"
import * as Log from "@oc2-ai/core/util/log"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID, type SessionRootID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@oc2-ai/core/cross-spawn-spawner"
import { provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { InstanceRef } from "@/effect/instance-ref"

void Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
      Layer.provide(Project.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

const sessionRestartLayer = (dbPath: string, project: Project.Info) =>
  Layer.mergeAll(
    Database.layerFromPath(dbPath),
    EventV2.defaultLayer,
    EventV2Bridge.layer,
    SessionProjector.layer,
    RuntimeFlags.layer({ experimentalWorkspaces: false }),
    BackgroundJob.defaultLayer,
    Layer.mock(Project.Service, {
      fromDirectory: (directory) => Effect.succeed({ project, sandbox: directory }),
    }),
    SessionNs.layer,
  )

const insertProject = (project: Project.Info) =>
  Database.Service.use(({ db }) =>
    db
      .insert(ProjectTable)
      .values({
        id: project.id,
        worktree: AbsolutePath.make(project.worktree),
        vcs: project.vcs,
        time_created: project.time.created,
        time_updated: project.time.updated,
        sandboxes: project.sandboxes.map((sandbox) => AbsolutePath.make(sandbox)),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )

const expectPrimaryRoot = (roots: SessionNs.RootInfo[], rootID: SessionRootID) => {
  const primary = roots.filter((root) => root.primary)
  expect(primary).toHaveLength(1)
  expect(primary[0]?.id).toBe(rootID)
}

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens and duration propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})
        expect((yield* session.get(info.id)).time.processing).toBe(0)

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          duration: 1234,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(finish.duration).toBe(1234)
        expect(receivedPart).not.toBe(partInput)
        expect((yield* session.get(info.id)).time.processing).toBe(1234)

        yield* session.updatePart({ ...partInput, duration: 2000 })
        expect((yield* session.get(info.id)).time.processing).toBe(2000)

        yield* session.updatePart({
          id: partInput.id,
          messageID,
          sessionID: info.id,
          type: "step-finish",
          reason: "stop",
          cost: 0.005,
          tokens,
        })
        expect((yield* session.get(info.id)).time.processing).toBe(0)

        yield* session.updatePart({ ...partInput, duration: 500 })
        expect((yield* session.get(info.id)).time.processing).toBe(500)

        yield* session.removePart({ sessionID: info.id, messageID, partID: partInput.id })
        expect((yield* session.get(info.id)).time.processing).toBe(0)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.instance("manages session roots and keeps primary root synced", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* session.create({ title: "roots" })

      const initialRoots = yield* session.listRoots(info.id)
      expect(initialRoots).toHaveLength(1)
      expect(initialRoots[0]).toMatchObject({
        sessionID: info.id,
        directory: info.directory,
        projectID: info.projectID,
        primary: true,
      })

      const other = yield* tmpdirScoped({ git: true })
      const added = yield* session.addRoot({ sessionID: info.id, directory: other, name: "other" })
      expect(added).toMatchObject({ directory: other, name: "other", primary: false })
      expectPrimaryRoot(yield* session.listRoots(info.id), initialRoots[0]!.id)

      const duplicate = yield* session.addRoot({ sessionID: info.id, directory: other }).pipe(Effect.exit)
      expect(Exit.isFailure(duplicate)).toBe(true)

      const primary = yield* session.updateRoot({
        sessionID: info.id,
        rootID: added.id,
        name: "renamed",
        primary: true,
      })
      expect(primary).toMatchObject({ id: added.id, name: "renamed", primary: true })
      expect((yield* session.get(info.id)).directory).toBe(other)
      expect((yield* session.getPrimaryRoot(info.id)).id).toBe(added.id)
      expectPrimaryRoot(yield* session.listRoots(info.id), added.id)

      yield* session.removeRoot({ sessionID: info.id, rootID: added.id })
      const remaining = yield* session.listRoots(info.id)
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toMatchObject({ id: initialRoots[0]?.id, primary: true })
      expectPrimaryRoot(remaining, initialRoots[0]!.id)
      expect((yield* session.get(info.id)).directory).toBe(info.directory)

      const lastDelete = yield* session.removeRoot({ sessionID: info.id, rootID: remaining[0]!.id }).pipe(Effect.exit)
      expect(Exit.isFailure(lastDelete)).toBe(true)

      yield* session.remove(info.id)
    }),
  )

  it.live("persists session roots across service restarts", () =>
    Effect.gen(function* () {
      const dbDir = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const secondary = yield* tmpdirScoped({ git: true })
      const dbPath = path.join(dbDir, "restart.db")
      const now = Date.now()
      const project = {
        id: ProjectV2.ID.make("restart-persistence"),
        worktree: primary,
        vcs: "git" as const,
        time: { created: now, updated: now },
        sandboxes: [primary, secondary],
      } satisfies Project.Info

      const created = yield* Effect.gen(function* () {
        yield* insertProject(project)
        const session = yield* SessionNs.Service
        const info = yield* session.create({ title: "restart roots" }).pipe(
          Effect.provideService(InstanceRef, {
            directory: primary,
            worktree: primary,
            project,
          }),
        )
        const initialRoots = yield* session.listRoots(info.id)
        expect(initialRoots).toHaveLength(1)

        const primaryRoot = yield* session.getPrimaryRoot(info.id)
        const secondaryRoot = yield* session.addRoot({ sessionID: info.id, directory: secondary, name: "secondary" })
        const roots = yield* session.listRoots(info.id)
        expect(roots).toHaveLength(2)
        expect(roots.filter((root) => root.primary)).toHaveLength(1)

        return { sessionID: info.id, primaryRoot, secondaryRoot }
      }).pipe(Effect.provide(sessionRestartLayer(dbPath, project)), Effect.scoped)

      const restarted = yield* Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const roots = yield* session.listRoots(created.sessionID)
        const listed = yield* session.list({ directory: secondary }).pipe(
          Effect.provideService(InstanceRef, {
            directory: secondary,
            worktree: created.secondaryRoot.worktree,
            project: { ...project, id: created.secondaryRoot.projectID, worktree: created.secondaryRoot.worktree },
          }),
        )
        return { roots, listed }
      }).pipe(Effect.provide(sessionRestartLayer(dbPath, project)), Effect.scoped)

      expect(restarted.roots).toHaveLength(2)
      expect(new Set(restarted.roots.map((root) => root.id)).size).toBe(2)
      expectPrimaryRoot(restarted.roots, created.primaryRoot.id)
      expect(restarted.roots.find((root) => root.id === created.primaryRoot.id)).toEqual(created.primaryRoot)
      expect(restarted.roots.find((root) => root.id === created.secondaryRoot.id)).toEqual(created.secondaryRoot)
      expect(restarted.listed.map((session) => session.id)).toEqual([created.sessionID])
    }),
  )

  it.live("keeps one promoted primary root across service restarts", () =>
    Effect.gen(function* () {
      const dbDir = yield* tmpdirScoped()
      const primary = yield* tmpdirScoped({ git: true })
      const secondary = yield* tmpdirScoped({ git: true })
      const dbPath = path.join(dbDir, "restart-promoted.db")
      const now = Date.now()
      const project = {
        id: ProjectV2.ID.make("restart-promoted-primary"),
        worktree: primary,
        vcs: "git" as const,
        time: { created: now, updated: now },
        sandboxes: [primary, secondary],
      } satisfies Project.Info

      const created = yield* Effect.gen(function* () {
        yield* insertProject(project)
        const session = yield* SessionNs.Service
        const info = yield* session.create({ title: "restart promoted root" }).pipe(
          Effect.provideService(InstanceRef, {
            directory: primary,
            worktree: primary,
            project,
          }),
        )
        const added = yield* session.addRoot({ sessionID: info.id, directory: secondary, name: "secondary" })
        const promoted = yield* session.updateRoot({ sessionID: info.id, rootID: added.id, primary: true })
        expectPrimaryRoot(yield* session.listRoots(info.id), promoted.id)
        return { sessionID: info.id, promoted }
      }).pipe(Effect.provide(sessionRestartLayer(dbPath, project)), Effect.scoped)

      const restarted = yield* Effect.gen(function* () {
        const session = yield* SessionNs.Service
        return yield* session.listRoots(created.sessionID)
      }).pipe(Effect.provide(sessionRestartLayer(dbPath, project)), Effect.scoped)

      expectPrimaryRoot(restarted, created.promoted.id)
      expect(restarted.find((root) => root.id === created.promoted.id)).toEqual(created.promoted)
    }),
  )

  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})
