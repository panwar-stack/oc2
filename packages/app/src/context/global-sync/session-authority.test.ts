import { describe, expect, test } from "bun:test"
import type { Session } from "@oc2-ai/sdk/v2/client"
import { createSessionAuthority, mergeSessionAggregates, preserveSessionAggregates } from "./session-authority"

const session = (id: string, cost: number, title = id) =>
  ({
    id,
    slug: id,
    projectID: "project",
    directory: "/repo",
    title,
    version: "dev",
    cost,
    tokens: { input: cost * 10, output: cost, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1, processing: cost * 100 },
  }) satisfies Session

describe("session aggregate authority", () => {
  test("accepts the newest initial or event GET without deduping newer requests", () => {
    const authority = createSessionAuthority()
    const initial = authority.beginSession("/repo", "session")
    const event = authority.beginSession("/repo", "session")

    expect(authority.accepts("/repo", "session", initial)).toBe(false)
    expect(authority.accepts("/repo", "session", event)).toBe(true)
  })

  test("keeps a newer GET when an older list resolves last", () => {
    const authority = createSessionAuthority()
    const list = authority.beginList("/repo")
    const event = authority.beginSession("/repo", "session")
    const current = [session("session", 9)]

    expect(authority.accepts("/repo", "session", event)).toBe(true)
    expect(authority.reconcileList("/repo", list, current, [session("session", 1)])).toEqual(current)
  })

  test("keeps newest-first list results and records omissions against older lists", () => {
    const authority = createSessionAuthority()
    const older = authority.beginList("/repo")
    const newer = authority.beginList("/repo")
    const latest = authority.reconcileList("/repo", newer, [session("a", 1)], [session("b", 2)])

    expect(latest.map((item) => item.id)).toEqual(["b"])
    expect(authority.reconcileList("/repo", older, latest, [session("a", 1)])).toEqual(latest)
  })

  test("does not let an older list reinsert a session omitted by a newer list", () => {
    const authority = createSessionAuthority()
    const current = [session("session", 1)]
    const older = authority.beginList("/repo")
    const newer = authority.beginList("/repo")
    const omitted = authority.reconcileList("/repo", newer, current, [])

    expect(omitted).toEqual([])
    expect(authority.reconcileList("/repo", older, omitted, current)).toEqual([])
  })

  test("isolates generations by directory and session", () => {
    const authority = createSessionAuthority()
    const left = authority.beginSession("/left", "session")
    authority.beginSession("/right", "session")
    authority.beginSession("/left", "other")

    expect(authority.accepts("/left", "session", left)).toBe(true)
  })

  test("tombstones reject GET and list reinsertion until a create event", () => {
    const authority = createSessionAuthority()
    const request = authority.beginSession("/repo", "session")
    authority.remove("/repo", "session")

    expect(authority.accepts("/repo", "session", request)).toBe(false)
    expect(authority.reconcileList("/repo", authority.beginList("/repo"), [], [session("session", 1)])).toEqual([])

    authority.create("/repo", "session")
    expect(authority.deleted("/repo", "session")).toBe(false)
    expect(authority.reconcileList("/repo", authority.beginList("/repo"), [], [session("session", 2)])).toEqual([
      session("session", 2),
    ])
  })

  test("normalizes trailing slashes and Windows separators for lists, sessions, and tombstones", () => {
    const authority = createSessionAuthority()
    const list = authority.beginList("C:\\repo\\")
    const request = authority.beginSession("C:/repo/", "session")

    expect(authority.accepts("C:\\repo", "session", request)).toBe(true)
    authority.remove("C:/repo", "session")
    expect(authority.deleted("C:\\repo\\", "session")).toBe(true)
    expect(authority.reconcileList("C:/repo/", list, [], [session("session", 1)])).toEqual([])
  })

  test("session.updated invalidates older GET and list responses without clearing tombstones", () => {
    const authority = createSessionAuthority()
    const current = [session("session", 9, "new metadata")]
    const list = authority.beginList("/repo")
    const get = authority.beginSession("/repo", "session")
    authority.update("/repo/", "session")

    expect(authority.accepts("/repo", "session", get)).toBe(false)
    expect(authority.reconcileList("/repo", list, current, [session("session", 1, "stale")])).toEqual(current)

    authority.remove("/repo", "session")
    authority.update("/repo", "session")
    expect(authority.deleted("/repo", "session")).toBe(true)
  })

  test("accepts a replacement GET with lower totals into the newest update metadata", () => {
    const authority = createSessionAuthority()
    const removal = authority.beginSession("/repo", "session")
    const current = session("session", 8, "old metadata")
    authority.update("/repo", "session")
    const replacement = authority.beginSession("/repo", "session")
    const metadata = preserveSessionAggregates(current, session("session", 0, "new metadata"))

    expect(authority.accepts("/repo", "session", removal)).toBe(false)
    expect(authority.accepts("/repo", "session", replacement)).toBe(true)
    expect(mergeSessionAggregates(metadata, session("session", 2, "stale GET metadata"))).toEqual({
      ...metadata,
      cost: 2,
      tokens: session("session", 2).tokens,
      time: { ...metadata.time, processing: 200 },
    })
  })

  test("repeated updates choose the newest replacement and deletion rejects it", () => {
    const authority = createSessionAuthority()
    authority.update("/repo", "session")
    const first = authority.beginSession("/repo", "session")
    authority.update("/repo", "session")
    const second = authority.beginSession("/repo", "session")

    expect(authority.accepts("/repo", "session", first)).toBe(false)
    expect(authority.accepts("/repo", "session", second)).toBe(true)
    authority.remove("/repo", "session")
    expect(authority.accepts("/repo", "session", second)).toBe(false)
  })

  test("reset isolates a disposed directory from reopened and unrelated authority state", () => {
    const authority = createSessionAuthority()
    const disposed = authority.beginSession("C:\\repo\\", "session")
    const disposedList = authority.beginList("C:/repo")
    authority.remove("C:/repo", "session")
    authority.remove("C:/other", "session")

    authority.reset("C:/repo/")

    expect(authority.deleted("C:\\repo", "session")).toBe(false)
    expect(authority.accepts("C:/repo", "session", disposed)).toBe(false)
    expect(
      authority.reconcileList(
        "C:/repo",
        disposedList,
        [session("session", 4, "reopened")],
        [session("session", 99, "disposed response")],
      ),
    ).toEqual([session("session", 4, "reopened")])
    expect(authority.deleted("C:/other", "session")).toBe(true)
    const reopened = authority.beginSession("C:/repo", "session")
    expect(authority.accepts("C:\\repo\\", "session", reopened)).toBe(true)
  })

  test("preserves authoritative aggregates across stale session.updated metadata", () => {
    const current = session("session", 9, "old")
    const updated = preserveSessionAggregates(current, session("session", 1, "new"))

    expect(updated.title).toBe("new")
    expect(updated.cost).toBe(9)
    expect(updated.tokens).toEqual(current.tokens)
    expect(updated.time.processing).toBe(900)
  })
})
