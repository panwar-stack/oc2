import { describe, expect, test } from "bun:test"
import {
  decisionDocumentTitle,
  decisionKey,
  pendingDecisionTitleController,
  questionDecisionPresentation,
} from "./session-decision"

describe("decision card presentation", () => {
  test("derives ARIA roles, live count, and consequence-bearing confirmation", () => {
    expect(questionDecisionPresentation({ multiple: true, selected: 2, total: 5, last: true })).toEqual({
      groupRole: "group",
      optionRole: "checkbox",
      selection: "2 of 5 selected",
      confirm: "Confirm 2",
    })
    expect(questionDecisionPresentation({ multiple: false, selected: 1, total: 3, last: true })).toEqual({
      groupRole: "radiogroup",
      optionRole: "radio",
      selection: "1 of 3 selected",
      confirm: "Confirm answer",
    })
    expect(questionDecisionPresentation({ multiple: true, selected: 1, total: 4, last: false }).confirm).toBe(
      "Next question",
    )
    expect(
      questionDecisionPresentation({
        multiple: false,
        selected: 1,
        total: 2,
        last: true,
        planApproval: true,
        planDecision: "Yes",
      }).confirm,
    ).toBe("Approve plan")
    expect(
      questionDecisionPresentation({
        multiple: false,
        selected: 1,
        total: 2,
        last: true,
        planApproval: true,
        planDecision: "No",
      }).confirm,
    ).toBe("Keep planning")
  })

  test("maps canonical navigation, selection, confirmation, cancellation, and digit keys", () => {
    expect(decisionKey("ArrowDown", 5)).toEqual({ type: "move", step: 1 })
    expect(decisionKey("ArrowUp", 5)).toEqual({ type: "move", step: -1 })
    expect(decisionKey(" ", 5)).toEqual({ type: "toggle" })
    expect(decisionKey("Enter", 5)).toEqual({ type: "confirm" })
    expect(decisionKey("Escape", 5)).toEqual({ type: "cancel" })
    expect(decisionKey("3", 5)).toEqual({ type: "pick", index: 2 })
    expect(decisionKey("6", 5)).toBeUndefined()
  })

  test("keeps required group and live-region attributes in both docks", async () => {
    const question = await Bun.file(new URL("./session-question-dock.tsx", import.meta.url)).text()
    const permission = await Bun.file(new URL("./session-permission-dock.tsx", import.meta.url)).text()
    expect(question).toContain("role={presentation().groupRole}")
    expect(question).toContain("role={presentation().optionRole}")
    expect(question).toContain('aria-live="polite"')
    expect(permission).toContain('role="radiogroup"')
    expect(permission).toContain('role="radio"')
    expect(permission).toContain('aria-live="polite"')
  })
})

describe("pending decision document title", () => {
  test("adds one pending marker without duplicating it", () => {
    expect(decisionDocumentTitle("OC2", true)).toBe("▲ OC2")
    expect(decisionDocumentTitle("▲ OC2", true)).toBe("▲ OC2")
    expect(decisionDocumentTitle("▲ OC2", false)).toBe("OC2")
  })

  test("tracks title changes while pending and removes its marker on cleanup", async () => {
    document.title = "Session"
    const controller = pendingDecisionTitleController(document)
    controller.set(true)
    expect(document.title).toBe("▲ Session")
    document.title = "Renamed session"
    await Bun.sleep(0)
    expect(document.title).toBe("▲ Renamed session")
    controller.set(false)
    expect(document.title).toBe("Renamed session")
    controller.set(true)
    expect(document.title).toBe("▲ Renamed session")
    controller.dispose()
    expect(document.title).toBe("Renamed session")
  })
})
