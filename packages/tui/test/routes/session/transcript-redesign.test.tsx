import { describe, expect, test } from "bun:test"

describe("TUI transcript redesign contract", () => {
  test("keeps the extracted transcript block grammar mounted", async () => {
    const root = new URL("../../../src/", import.meta.url)
    const [route, user, tools, thinking] = await Promise.all([
      Bun.file(new URL("routes/session/index.tsx", root)).text(),
      Bun.file(new URL("component/user-message.tsx", root)).text(),
      Bun.file(new URL("component/tool-row.tsx", root)).text(),
      Bun.file(new URL("component/thinking-row.tsx", root)).text(),
    ])

    expect(route).toContain("<TranscriptUserMessage")
    expect(route).toContain("<ThinkingRow")
    expect(route).toContain("<ToolRow")
    expect(route).toContain("<TurnFooter")
    expect(user).toContain('border={["left"]}')
    expect(user).toContain("borderColor={theme.primary}")
    expect(tools).toContain('wrapMode="none"')
    expect(thinking).toContain('wrapMode="none"')
  })
})
