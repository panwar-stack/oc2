import { describe, expect, test } from "bun:test"

describe("web timeline transcript contract", () => {
  test("keeps layout replacement behind newLayoutDesigns and durable row identities", async () => {
    const source = await Bun.file(import.meta.dir + "/message-timeline.tsx").text()
    const data = await Bun.file(import.meta.dir + "/message-timeline.data.ts").text()

    expect(source).toContain('data-component="session-timeline"')
    expect(source).toContain('data-layout={settings.general.newLayoutDesigns() ? "v2" : "legacy"}')
    expect(source).toContain("redesigned={settings.general.newLayoutDesigns()}")
    expect(source).toContain("<TurnFooter")
    expect(data).toContain("new TimelineRow.TurnFooter")
    expect(data).toContain("lastAssistant && showTurnFooter")
    expect(data).toContain("`turn-footer:${row.userMessageID}:${row.assistantMessageID}`")
    expect(source).not.toContain("lastAssistantGroupKey")
    expect(data).toContain("`assistant-part:${row.userMessageID}:${row.group.key}`")
  })

  test("uses canonical transcript slots and V2 domain tokens", async () => {
    const timeline = await Bun.file(import.meta.dir + "/message-timeline.tsx").text()
    const styles = await Bun.file(import.meta.dir + "/../../index.css").text()
    const marked = await Bun.file(import.meta.dir + "/../../../../ui/src/context/marked.tsx").text()
    const markdown = await Bun.file(import.meta.dir + "/../../../../ui/src/components/markdown.css").text()
    const pierre = await Bun.file(import.meta.dir + "/../../../../ui/src/pierre/index.ts").text()

    expect(timeline).toContain('data-slot="session-turn-thinking-glyph"')
    expect(timeline).toContain('data-variant={props.redesigned ? "v2" : "legacy"}')
    expect(timeline).not.toContain("data-redesigned")
    expect(styles).toContain('[data-component="session-timeline"][data-layout="v2"]')
    expect(styles).toContain(
      '[data-timeline-row="AssistantPart"] > [data-component="session-turn"] > [data-slot="session-turn-message-container"]',
    )
    expect(styles).toContain(
      '[data-timeline-row="Retry"] > [data-component="session-turn"] > [data-slot="session-turn-message-container"]',
    )
    expect(styles).toContain("border-left: 1px solid var(--v2-border-border-muted)")
    expect(styles).toContain('[data-component="tool-part-wrapper"]')
    expect(styles).toContain('[data-slot="session-turn-diff-view"]')
    expect(styles).toContain("max-width: none")
    expect(markdown).not.toContain("prefers-color-scheme")
    expect(marked).toContain("var(--v2-syntax-keyword)")
    expect(marked).toContain("var(--v2-diff-added)")
    expect(markdown).toContain("var(--v2-markdown-text, var(--markdown-text))")
    expect(pierre).toContain("var(--v2-diff-added-bg)")
    expect(`${marked}\n${markdown}\n${pierre}`).not.toMatch(/#[\da-f]{3,8}/i)
  })

  test("limits redesigned prose without constraining tools", async () => {
    const styles = await Bun.file(import.meta.dir + "/../../../../ui/src/components/message-part.css").text()

    expect(styles).toContain('[data-component="user-message"][data-variant="v2"]')
    expect(styles).toContain("max-width: min(100%, var(--v2-timeline-max-width))")
    expect(styles).toContain('[data-component="text-part"][data-variant="v2"]')
    expect(styles).toContain('[data-component="tool-part-wrapper"][data-variant="v2"]')
    expect(styles).not.toContain("data-redesigned")
    expect(styles).not.toContain("@media (prefers-color-scheme: dark)")
  })
})
