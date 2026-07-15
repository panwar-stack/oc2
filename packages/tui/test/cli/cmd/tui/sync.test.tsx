/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@oc2-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { Event, GlobalEvent, Session } from "@oc2-ai/sdk/v2"
import { rootDirectoryLabel } from "../../../../src/routes/session/footer"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

function sessionInfo(id: string, cost: number, processing: number, title = `Session ${id}`): Session {
  return {
    id,
    slug: id,
    title,
    version: "dev",
    directory: "/tmp/opencode/packages/tui",
    projectID: "proj_test",
    cost,
    tokens: {
      input: Math.round(cost * 10),
      output: Math.round(cost * 5),
      reasoning: Math.round(cost * 3),
      cache: { read: Math.round(cost * 2), write: Math.round(cost) },
    },
    time: { created: 1, updated: processing, processing },
  }
}

function event(payload: Event): GlobalEvent {
  return { directory: "/tmp/opencode/packages/tui", project: "proj_test", payload }
}

function terminal(id: string, sessionID: string, mode: "aggregate" | "mirror"): Event {
  return {
    id,
    type: "session.next.step.ended",
    properties: {
      timestamp: 2,
      sessionID,
      assistantMessageID: `msg_${id}`,
      finish: "stop",
      cost: 1,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      accounting: {
        mode,
        purpose: "assistant",
        model: { id: "model", providerID: "provider" },
        time: { started: 1, completed: 2, duration: 1 },
      },
    },
  }
}

function failedTerminal(id: string, sessionID: string): Event {
  return {
    id,
    type: "session.next.step.failed",
    properties: {
      timestamp: 2,
      sessionID,
      assistantMessageID: `msg_${id}`,
      error: { type: "unknown", message: "failed" },
      accounting: {
        mode: "aggregate",
        purpose: "assistant",
        model: { id: "model", providerID: "provider" },
        time: { started: 1, completed: 2, duration: 1 },
      },
    },
  }
}

describe("tui sync", () => {
  test("formats footer label from primary root and root count", () => {
    expect(
      rootDirectoryLabel({
        fallback: "/tmp/other:main",
        session: {
          id: "ses_roots",
          slug: "ses_roots",
          title: "Roots",
          time: { created: 1, updated: 1, processing: 0 },
          version: "1.0.0",
          directory: "/tmp/repo-a",
          projectID: "proj_a",
          cost: 0,
        },
        roots: [
          {
            id: "root_extra",
            sessionID: "ses_roots",
            directory: "/tmp/repo-b",
            worktree: "/tmp/repo-b",
            projectID: "proj_b",
            created: 2,
            primary: false,
          },
          {
            id: "root_primary",
            sessionID: "ses_roots",
            directory: "/tmp/repo-a",
            worktree: "/tmp/repo-a",
            projectID: "proj_a",
            created: 1,
            primary: true,
          },
        ],
      }),
    ).toBe("/tmp/repo-a +1 roots")
  })

  test("refreshes session roots into sync state", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_roots"
    const roots = [
      {
        id: "root_primary",
        sessionID,
        directory: "/tmp/repo-a",
        worktree: "/tmp/repo-a",
        projectID: "proj_a",
        created: 1,
        primary: true,
      },
      {
        id: "root_extra",
        sessionID,
        name: "api",
        directory: "/tmp/repo-b",
        worktree: "/tmp/repo-b",
        projectID: "proj_b",
        created: 2,
        primary: false,
      },
    ]
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) {
        return json({
          id: sessionID,
          title: "Roots",
          time: { created: 1, updated: 1 },
          version: "1.0.0",
          directory: "/tmp/repo-a",
          project_id: "proj_a",
          cost: 0,
        })
      }
      if (url.pathname === `/session/${sessionID}/root`) return json(roots)
    })

    try {
      await expect(sync.session.refreshRoots(sessionID)).resolves.toEqual(roots)
      expect(sync.data.session_root[sessionID]).toEqual(roots)
      expect(sync.session.get(sessionID)?.directory).toBe("/tmp/repo-a")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("hydrates session roots through root list", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_hydrate_roots"
    const staleRoots = [
      {
        id: "root_stale",
        sessionID,
        directory: "/tmp/stale",
        worktree: "/tmp/stale",
        projectID: "proj_stale",
        created: 0,
        primary: true,
      },
    ]
    const roots = [
      {
        id: "root_primary",
        sessionID,
        directory: "/tmp/repo-a",
        worktree: "/tmp/repo-a",
        projectID: "proj_a",
        created: 1,
        primary: true,
      },
      {
        id: "root_extra",
        sessionID,
        name: "api",
        directory: "/tmp/repo-b",
        worktree: "/tmp/repo-b",
        projectID: "proj_b",
        created: 2,
        primary: false,
      },
    ]
    let rootRequests = 0
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) {
        return json({
          id: sessionID,
          title: "Hydrate roots",
          time: { created: 1, updated: 1 },
          version: "1.0.0",
          directory: "/tmp/repo-a",
          project_id: "proj_a",
          cost: 0,
        })
      }
      if (url.pathname === `/session/${sessionID}/root`) {
        rootRequests++
        return json(roots)
      }
      if (
        url.pathname === `/session/${sessionID}/message` ||
        url.pathname === `/session/${sessionID}/todo` ||
        url.pathname === `/session/${sessionID}/diff`
      )
        return json([])
    })

    try {
      sync.set("session_root", sessionID, staleRoots)

      await sync.session.sync(sessionID)

      expect(rootRequests).toBe(1)
      expect(sync.data.session_root[sessionID]).toEqual(roots)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("guards initial and event aggregate GETs while refreshing every owning or V1 lowering event", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_authority"
    const gets: Array<ReturnType<typeof Promise.withResolvers<Response>>> = []
    const initial = sessionInfo(sessionID, 1, 100)
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/session") return json([initial])
      if (url.pathname === `/session/${sessionID}`) {
        const request = Promise.withResolvers<Response>()
        gets.push(request)
        return request.promise
      }
      if (
        url.pathname === `/session/${sessionID}/root` ||
        url.pathname === `/session/${sessionID}/message` ||
        url.pathname === `/session/${sessionID}/todo` ||
        url.pathname === `/session/${sessionID}/diff`
      )
        return json([])
    }, tmp.path)

    try {
      expect(sync.session.get(sessionID)?.cost).toBe(1)
      expect(sync.session.get(sessionID)?.time.processing).toBe(100)

      const hydration = sync.session.sync(sessionID)
      await wait(() => gets.length === 1)
      emit(event(terminal("evt_owning_newer", sessionID, "aggregate")))
      await wait(() => gets.length === 2)
      gets[1]!.resolve(json(sessionInfo(sessionID, 3, 300)))
      await wait(() => sync.session.get(sessionID)?.cost === 3)
      gets[0]!.resolve(json(sessionInfo(sessionID, 2, 200)))
      await hydration

      expect(sync.session.get(sessionID)?.cost).toBe(3)
      expect(sync.session.get(sessionID)?.time.processing).toBe(300)

      emit(event(failedTerminal("evt_failed", sessionID)))
      await wait(() => gets.length === 3)
      gets[2]!.resolve(json(sessionInfo(sessionID, 3.5, 350)))
      await wait(() => sync.session.get(sessionID)?.cost === 3.5)

      emit(event(terminal("evt_mirror", sessionID, "mirror")))
      await Bun.sleep(30)
      expect(gets).toHaveLength(3)

      emit(
        event({
          id: "evt_part_update",
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 3,
            part: { id: "part", sessionID, messageID: "message", type: "text", text: "lower" },
          },
        }),
      )
      await wait(() => gets.length === 4)
      gets[3]!.resolve(json(sessionInfo(sessionID, 4, 400)))
      await wait(() => sync.session.get(sessionID)?.cost === 4)

      emit(
        event({
          id: "evt_part_remove",
          type: "message.part.removed",
          properties: { sessionID, messageID: "message", partID: "part" },
        }),
      )
      await wait(() => gets.length === 5)
      emit(
        event({
          id: "evt_update_during_removal",
          type: "session.updated",
          properties: { sessionID, info: sessionInfo(sessionID, 0, 0, "Updated during removal") },
        }),
      )
      await wait(() => gets.length === 6)
      await wait(() => sync.session.get(sessionID)?.title === "Updated during removal")
      gets[4]!.resolve(json(sessionInfo(sessionID, 2.5, 250, "Old removal GET")))
      await Bun.sleep(30)
      expect(sync.session.get(sessionID)?.cost).toBe(4)
      expect(sync.session.get(sessionID)?.tokens).toEqual({
        input: 40,
        output: 20,
        reasoning: 12,
        cache: { read: 8, write: 4 },
      })
      expect(sync.session.get(sessionID)?.title).toBe("Updated during removal")
      gets[5]!.resolve(json(sessionInfo(sessionID, 2.5, 250, "Replacement GET")))
      await wait(() => sync.session.get(sessionID)?.cost === 2.5)
      expect(sync.session.get(sessionID)?.cost).toBe(2.5)
      expect(sync.session.get(sessionID)?.time.processing).toBe(250)
      expect(sync.session.get(sessionID)?.tokens).toEqual({
        input: 25,
        output: 13,
        reasoning: 8,
        cache: { read: 5, write: 3 },
      })
      expect(sync.session.get(sessionID)?.title).toBe("Updated during removal")

      emit(
        event({
          id: "evt_message_remove",
          type: "message.removed",
          properties: { sessionID, messageID: "message" },
        }),
      )
      await wait(() => gets.length === 7)
      gets[6]!.resolve(json(sessionInfo(sessionID, 1, 100)))
      await wait(() => sync.session.get(sessionID)?.cost === 1)
      expect(sync.session.get(sessionID)?.cost).toBe(1)
      expect(sync.session.get(sessionID)?.time.processing).toBe(100)
      expect(sync.session.get(sessionID)?.tokens).toEqual({
        input: 10,
        output: 5,
        reasoning: 3,
        cache: { read: 2, write: 1 },
      })

      emit(
        event({
          id: "evt_repeated_update_1",
          type: "session.updated",
          properties: { sessionID, info: sessionInfo(sessionID, 0, 0, "Repeated update 1") },
        }),
      )
      await wait(() => gets.length === 8)
      emit(
        event({
          id: "evt_repeated_update_2",
          type: "session.updated",
          properties: { sessionID, info: sessionInfo(sessionID, 0, 0, "Repeated update 2") },
        }),
      )
      await wait(() => gets.length === 9)
      gets[7]!.resolve(json(sessionInfo(sessionID, 99, 9_900, "First replacement")))
      await Bun.sleep(30)
      expect(sync.session.get(sessionID)?.cost).toBe(1)
      expect(sync.session.get(sessionID)?.title).toBe("Repeated update 2")
      gets[8]!.resolve(json(sessionInfo(sessionID, 0.75, 75, "Second replacement")))
      await wait(() => sync.session.get(sessionID)?.cost === 0.75)
      expect(sync.session.get(sessionID)?.time.processing).toBe(75)
      expect(sync.session.get(sessionID)?.title).toBe("Repeated update 2")
      expect(gets).toHaveLength(9)
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps newest list results and tombstones deleted sessions against stale responses", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const sessionID = "ses_list_authority"
    const lists: Array<ReturnType<typeof Promise.withResolvers<Response>>> = []
    const gets: Array<ReturnType<typeof Promise.withResolvers<Response>>> = []
    let bootstrapped = false
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/session") {
        if (!bootstrapped) {
          bootstrapped = true
          return json([sessionInfo(sessionID, 1, 100)])
        }
        const request = Promise.withResolvers<Response>()
        lists.push(request)
        return request.promise
      }
      if (url.pathname === `/session/${sessionID}`) {
        const request = Promise.withResolvers<Response>()
        gets.push(request)
        return request.promise
      }
    }, tmp.path)

    try {
      const older = sync.session.refresh()
      const newer = sync.session.refresh()
      await wait(() => lists.length === 2)
      lists[1]!.resolve(json([]))
      await newer
      expect(sync.session.get(sessionID)).toBeUndefined()
      lists[0]!.resolve(json([sessionInfo(sessionID, 2, 200)]))
      await older
      expect(sync.session.get(sessionID)).toBeUndefined()

      emit(
        event({
          id: "evt_recreate",
          type: "session.created",
          properties: { sessionID, info: sessionInfo(sessionID, 8, 800) },
        }),
      )
      await wait(() => sync.session.get(sessionID)?.cost === 8)

      const staleUpdateList = sync.session.refresh()
      await wait(() => lists.length === 3)
      emit(
        event({
          id: "evt_update_during_list",
          type: "session.updated",
          properties: { sessionID, info: sessionInfo(sessionID, 0, 0, "Updated during list") },
        }),
      )
      await wait(() => sync.session.get(sessionID)?.title === "Updated during list")
      await wait(() => gets.length === 1)
      gets[0]!.resolve(json(sessionInfo(sessionID, 7, 700, "Replacement list GET")))
      await wait(() => sync.session.get(sessionID)?.cost === 7)
      lists[2]!.resolve(json([sessionInfo(sessionID, 100, 10_000, "Stale list")]))
      await staleUpdateList
      expect(sync.session.get(sessionID)?.cost).toBe(7)
      expect(sync.session.get(sessionID)?.time.processing).toBe(700)
      expect(sync.session.get(sessionID)?.title).toBe("Updated during list")

      emit(event(terminal("evt_pending_delete", sessionID, "aggregate")))
      await wait(() => gets.length === 2)
      emit(
        event({
          id: "evt_delete",
          type: "session.deleted",
          properties: { sessionID, info: sessionInfo(sessionID, 8, 800) },
        }),
      )
      await wait(() => sync.session.get(sessionID) === undefined)
      gets[1]!.resolve(json(sessionInfo(sessionID, 99, 9_900)))
      await Bun.sleep(30)

      emit(
        event({
          id: "evt_update_after_delete",
          type: "session.updated",
          properties: { sessionID, info: sessionInfo(sessionID, 100, 10_000) },
        }),
      )
      await Bun.sleep(30)
      expect(gets).toHaveLength(2)
      expect(sync.session.get(sessionID)).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("reconciles delayed bootstrap lists at application after newer GETs and tombstones", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const freshID = "ses_bootstrap_fresh"
    const deletedID = "ses_bootstrap_deleted"
    const agents = Promise.withResolvers<Response>()
    const raced = Promise.withResolvers<void>()
    let raceError: unknown
    let scheduled = false
    const { app, sync } = await mount((url, context) => {
      if (url.pathname === "/agent") return agents.promise
      if (url.pathname === "/session") {
        if (!scheduled) {
          scheduled = true
          setTimeout(() => {
            void (async () => {
              try {
                await wait(() => !!context.sync())
                await Bun.sleep(20)
                const active = context.sync()
                if (!active) throw new Error("sync context was not mounted")
                await active.session.sync(freshID)
                expect(active.session.get(freshID)?.cost).toBe(9)
                context.emit(
                  event({
                    id: "evt_bootstrap_delete",
                    type: "session.deleted",
                    properties: { sessionID: deletedID, info: sessionInfo(deletedID, 2, 200) },
                  }),
                )
                await Bun.sleep(30)
              } catch (error) {
                raceError = error
              } finally {
                agents.resolve(json([]))
                raced.resolve()
              }
            })()
          }, 0)
        }
        return json([sessionInfo(freshID, 1, 100), sessionInfo(deletedID, 2, 200)])
      }
      if (url.pathname === `/session/${freshID}`) return json(sessionInfo(freshID, 9, 900))
      if (
        url.pathname === `/session/${freshID}/root` ||
        url.pathname === `/session/${freshID}/message` ||
        url.pathname === `/session/${freshID}/todo` ||
        url.pathname === `/session/${freshID}/diff`
      )
        return json([])
    }, tmp.path, { skipInitialLoading: true })

    try {
      await raced.promise
      if (raceError) throw raceError
      expect(sync.session.get(freshID)?.cost).toBe(9)
      expect(sync.session.get(freshID)?.time.processing).toBe(900)
      expect(sync.session.get(deletedID)).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })
})
