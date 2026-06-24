/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { MouseEvent, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2"
import loguSidebarPlugin from "../../../src/feature-plugins/sidebar/logu"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

test("renders logu children with timeout state and navigation", async () => {
  const sessions = [
    loguChild("child-timeout", "Slow", 1, "branch", "test/slow", { timedOut: true }),
    loguChild("child-judge", "Judge", 2, "judge", "test/judge"),
    loguChild("child-fast", "Fast", 0, "branch", "test/fast"),
  ]
  const state = new Map(sessions.map((session) => [session.id, session]))
  const navigations: Array<{ name: string; params: unknown }> = []
  let sidebarContent: Parameters<TuiPluginApi["slots"]["register"]>[0]["slots"]["sidebar_content"] | undefined
  let frame = ""
  const base = createTuiPluginApi({
    state: {
      session: {
        children: () => sessions.map((session) => ({ id: session.id, title: session.title, parentID: "parent" })),
        get: (sessionID) => state.get(sessionID),
        status: () => ({ type: "idle" }),
        permission: (sessionID) => (sessionID === "child-fast" ? [permission("perm-1", sessionID)] : []),
        question: (sessionID) =>
          sessionID === "child-timeout" ? [question("question-1", sessionID), question("question-2", sessionID)] : [],
      },
    },
  })
  const api = {
    ...base,
    route: {
      register: () => () => {},
      navigate(name: string, params?: Record<string, unknown>) {
        navigations.push({ name, params })
      },
      current: { name: "session", params: { sessionID: "parent" } },
    },
    slots: {
      register(registration: Parameters<TuiPluginApi["slots"]["register"]>[0]) {
        sidebarContent = registration.slots.sidebar_content
        return "logu-sidebar-slot"
      },
    },
  } as unknown as TuiPluginApi

  await loguSidebarPlugin.tui(api, undefined, {} as never)
  const app = await testRender(() => sidebarContent?.({ theme: api.theme }, { session_id: "parent" }) ?? <box />, {
    width: 120,
    height: 20,
  })
  try {
    await app.waitForFrame((next) => {
      frame = next
      return next.includes("Logu")
    })

    expect(frame).toContain("Logu (3 sessions) [3 pending]")
    expect(frame.indexOf("Fast - test/fast")).toBeLessThan(frame.indexOf("Slow - test/slow"))
    expect(frame.indexOf("Slow - test/slow")).toBeLessThan(frame.indexOf("Judge - test/judge"))
    expect(frame).toContain("Slow - test/slow (timed out) [2 pending]")
    expect(frame).toContain("Fast - test/fast (idle) [1 pending]")

    const row = findRenderable(app.renderer.root, (renderable) => renderable.id === "logu-sidebar-row-child-timeout")
    expect(row).toBeDefined()
    row?.processMouseEvent(
      new MouseEvent(row, { type: "down", button: 0, x: 0, y: 0, modifiers: { shift: false, alt: false, ctrl: false } }),
    )

    expect(navigations).toEqual([{ name: "session", params: { sessionID: "child-timeout" } }])
  } finally {
    app.renderer.destroy()
  }
})

function loguChild(
  id: string,
  title: string,
  index: number,
  stage: "branch" | "judge",
  model: string,
  metadata?: { timedOut?: true },
) {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/repo",
    title,
    version: "1",
    time: { created: 0, updated: 0 },
    metadata: {
      logu: {
        stage,
        index,
        model,
        parentRunID: "parent",
        parentSessionID: "parent",
        ...metadata,
      },
    },
  } satisfies Session
}

function permission(id: string, sessionID: string): PermissionRequest {
  return { id, sessionID, permission: "edit", patterns: [], metadata: {}, always: [] }
}

function question(id: string, sessionID: string): QuestionRequest {
  return { id, sessionID, questions: [] }
}

function findRenderable(root: Renderable, predicate: (renderable: Renderable) => boolean): Renderable | undefined {
  if (predicate(root)) return root
  return root
    .getChildren()
    .map((child) => findRenderable(child, predicate))
    .find(Boolean)
}
