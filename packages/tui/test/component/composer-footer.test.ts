import { describe, expect, test } from "bun:test"
import { composerFooterPresentation } from "../../src/component/composer-footer"

describe("composerFooterPresentation", () => {
  test("keeps idle sends and working steer delivery truthful", () => {
    expect(composerFooterPresentation({ working: false, delivery: "steer", queued: 0, hasDraft: false })).toEqual({
      state: "idle",
      action: "send",
    })
    expect(composerFooterPresentation({ working: true, delivery: "steer", queued: 0, hasDraft: true })).toEqual({
      state: "working",
      action: "steer",
    })
  })

  test("shows sends-next semantics only for queue delivery", () => {
    expect(composerFooterPresentation({ working: true, delivery: "queue", queued: 0, hasDraft: true })).toEqual({
      state: "working",
      action: "queue",
    })
    expect(composerFooterPresentation({ working: true, delivery: "queue", queued: 1, hasDraft: false })).toEqual({
      state: "queued",
      action: "queued",
    })
    expect(composerFooterPresentation({ working: true, delivery: "steer", queued: 1, hasDraft: false })).toEqual({
      state: "working",
      action: "steer",
    })
  })

  test("keeps an idle lead send action while teammates work", () => {
    expect(
      composerFooterPresentation({
        working: true,
        activeTurn: false,
        delivery: "steer",
        queued: 0,
        hasDraft: true,
      }),
    ).toEqual({ state: "working", action: "send" })
  })

  test("returns to queue action when the next draft starts", () => {
    expect(composerFooterPresentation({ working: true, delivery: "queue", queued: 1, hasDraft: true })).toEqual({
      state: "working",
      action: "queue",
    })
  })
})
