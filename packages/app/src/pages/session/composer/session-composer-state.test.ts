import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session } from "@oc2-ai/sdk/v2/client"
import {
  composerPresentation,
  formatComposerElapsed,
  latchComposerWorkingSince,
  todoState,
} from "./session-composer-model"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

const session = (input: { id: string; parentID?: string }) =>
  ({
    id: input.id,
    parentID: input.parentID,
  }) as Session

const permission = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
  }) as PermissionRequest

const question = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    questions: [],
  }) as QuestionRequest

describe("sessionPermissionRequest", () => {
  test("prefers the current session permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-root")
  })

  test("returns a nested child permission", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
      session({ id: "other" }),
    ]
    const permissions = {
      grand: [permission("perm-grand", "grand")],
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")?.id).toBe("perm-grand")
  })

  test("returns undefined without a matching tree permission", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      other: [permission("perm-other", "other")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root")).toBeUndefined()
  })

  test("skips filtered permissions in the current tree", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", (item) => item.id !== "perm-root"))?.toMatchObject({
      id: "perm-child",
    })
  })

  test("returns undefined when all tree permissions are filtered out", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const permissions = {
      root: [permission("perm-root", "root")],
      child: [permission("perm-child", "child")],
    }

    expect(sessionPermissionRequest(sessions, permissions, "root", () => false)).toBeUndefined()
  })
})

describe("sessionQuestionRequest", () => {
  test("prefers the current session question", () => {
    const sessions = [session({ id: "root" }), session({ id: "child", parentID: "root" })]
    const questions = {
      root: [question("q-root", "root")],
      child: [question("q-child", "child")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-root")
  })

  test("returns a nested child question", () => {
    const sessions = [
      session({ id: "root" }),
      session({ id: "child", parentID: "root" }),
      session({ id: "grand", parentID: "child" }),
    ]
    const questions = {
      grand: [question("q-grand", "grand")],
    }

    expect(sessionQuestionRequest(sessions, questions, "root")?.id).toBe("q-grand")
  })
})

describe("todoState", () => {
  test("hides when there are no todos", () => {
    expect(todoState({ count: 0, done: false, live: true })).toBe("hide")
  })

  test("opens while the session is still working", () => {
    expect(todoState({ count: 2, done: false, live: true })).toBe("open")
  })

  test("closes completed todos after a running turn", () => {
    expect(todoState({ count: 2, done: true, live: true })).toBe("close")
  })

  test("clears stale todos when the turn ends", () => {
    expect(todoState({ count: 2, done: false, live: false })).toBe("clear")
  })

  test("clears completed todos when the session is no longer live", () => {
    expect(todoState({ count: 2, done: true, live: false })).toBe("clear")
  })
})

describe("composerPresentation", () => {
  test("derives truthful idle and steer actions", () => {
    expect(composerPresentation({ working: false, delivery: "steer", queued: 0, hasDraft: false })).toEqual({
      state: "idle",
      action: "send",
    })
    expect(composerPresentation({ working: true, delivery: "steer", queued: 0, hasDraft: true })).toEqual({
      state: "working",
      action: "send",
    })
  })

  test("uses queue semantics only when queue delivery is active", () => {
    expect(composerPresentation({ working: true, delivery: "queue", queued: 0, hasDraft: true })).toEqual({
      state: "working",
      action: "queue",
    })
  })

  test("confirms a queued draft until the user starts another draft", () => {
    expect(composerPresentation({ working: true, delivery: "queue", queued: 1, hasDraft: false })).toEqual({
      state: "queued",
      action: "queued",
    })
    expect(composerPresentation({ working: true, delivery: "queue", queued: 1, hasDraft: true })).toEqual({
      state: "working",
      action: "queue",
    })
  })
})

describe("composer working clock", () => {
  test("latches the start while work remains active and resets on idle", () => {
    expect(latchComposerWorkingSince(undefined, true, 1_000)).toBe(1_000)
    expect(latchComposerWorkingSince(1_000, true, 5_000)).toBe(1_000)
    expect(latchComposerWorkingSince(1_000, true, 5_000, true)).toBe(5_000)
    expect(latchComposerWorkingSince(1_000, false, 5_000)).toBeUndefined()
    expect(latchComposerWorkingSince(undefined, true, 8_000)).toBe(8_000)
  })

  test("formats stable elapsed labels", () => {
    expect(formatComposerElapsed(0)).toBe("0s")
    expect(formatComposerElapsed(885)).toBe("14m 45s")
    expect(formatComposerElapsed(3_725)).toBe("1h 2m")
  })
})
