import { afterEach, describe, expect, test } from "bun:test"
import { escapeTargetsPopup } from "@oc2-ai/ui/context/dialog"

afterEach(() => document.body.replaceChildren())

describe("dialog Escape layering", () => {
  test("defers Escape while focus or the active control belongs to a child popup", () => {
    const trigger = document.createElement("button")
    trigger.setAttribute("aria-controls", "child-listbox")
    trigger.setAttribute("aria-expanded", "true")
    const listbox = document.createElement("div")
    listbox.id = "child-listbox"
    listbox.setAttribute("role", "listbox")
    const option = document.createElement("button")
    option.setAttribute("role", "option")
    listbox.append(option)
    document.body.append(trigger, listbox)

    option.focus()
    expect(document.activeElement).toBe(option)
    expect(escapeTargetsPopup(option)).toBe(true)

    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    expect(escapeTargetsPopup(trigger)).toBe(true)

    trigger.setAttribute("aria-expanded", "false")
    listbox.remove()
    expect(escapeTargetsPopup(trigger)).toBe(false)
  })
})
