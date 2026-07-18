import { expect, test } from "bun:test"
import { STATUS_GLYPHS } from "./status-glyph"
import { gaugeVariant } from "./gauge-v2"

const source = async (name: string) => Bun.file(`${import.meta.dir}/${name}`).text()

test("status glyphs expose the canonical map and decorative default", async () => {
  expect(STATUS_GLYPHS).toEqual({
    pending: "○",
    running: "◐",
    done: "✓",
    failed: "✕",
    "needs-you": "▲",
    collapsed: "▸",
    expanded: "▾",
    live: "●",
    mailbox: "✉",
    "tool-group": "⌗",
    attachment: "▤",
    "gauge-full": "▰",
    "gauge-empty": "▱",
    brand: "›_",
    continuation: "↳",
    separator: "·",
    enter: "⏎",
  })
  expect(await source("status-glyph.tsx")).toContain('aria-hidden={local.label ? undefined : "true"}')
})

test("status glyphs use standard Unicode rather than private font codepoints", () => {
  const privateUse = (codepoint: number) =>
    (codepoint >= 0xe000 && codepoint <= 0xf8ff) ||
    (codepoint >= 0xf0000 && codepoint <= 0xffffd) ||
    (codepoint >= 0x100000 && codepoint <= 0x10fffd)

  expect(
    [...Object.values(STATUS_GLYPHS).join("")].some((glyph) => {
      const codepoint = glyph.codePointAt(0)
      return codepoint !== undefined && privateUse(codepoint)
    }),
  ).toBe(false)
})

test("key hints use real buttons only for clickable affordances", async () => {
  const component = await source("key-hint-v2.tsx")
  expect(component).toContain('component={local.onClick ? "button" : "span"}')
  expect(component).toContain("...rest")
  expect(component).toContain("aria-hidden=")
  expect(await source("key-hint-v2.css")).toContain(':is(:active, [data-state="pressed"])')
})

test("pills and badges carry text and live semantics", async () => {
  const pill = await source("pill-v2.tsx")
  const badge = await source("badge-v2.tsx")
  expect(pill).toContain('data-component="pill-v2"')
  expect(pill).toContain("{local.children}")
  expect(badge).toContain('role={rest.role ?? "status"}')
  expect(badge).toContain('aria-live={rest["aria-live"] ?? "polite"}')
})

test("gauges expose determinate values, visible percentages, and thresholds", async () => {
  const component = await source("gauge-v2.tsx")
  expect(gaugeVariant(69)).toBe("success")
  expect(gaugeVariant(70)).toBe("warning")
  expect(gaugeVariant(90)).toBe("danger")
  expect(gaugeVariant(95, "progress")).toBe("success")
  expect(component).toContain('role="progressbar"')
  expect(component).toContain("aria-valuenow=")
  expect(component).toContain("{percentage()}%")
  expect(component).toContain("{local.children}")
  expect(component.indexOf('role="progressbar"')).toBeLessThan(component.indexOf('data-slot="gauge-v2-supplemental"'))
})

test("collapsible section heads use a button and announce aggregates", async () => {
  const component = await source("section-head-v2.tsx")
  expect(component).toContain('data-slot="section-head-v2-trigger"')
  expect(component).toContain("aria-expanded=")
  expect(component).toContain('aria-live="polite"')
  expect(component).toContain('local.expanded ? "expanded" : "collapsed"')
  expect(component.indexOf('data-slot="section-head-v2-trigger"')).toBeLessThan(
    component.indexOf('data-slot="section-head-v2-aggregate"'),
  )
})
