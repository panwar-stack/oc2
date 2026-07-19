import { describe, expect, test } from "bun:test"
import { responsiveDiffStyle } from "./index"

describe("responsive diff style", () => {
  test("uses unified below the split readability threshold", () => {
    expect(responsiveDiffStyle("split", 879)).toBe("unified")
    expect(responsiveDiffStyle("split", 880)).toBe("split")
    expect(responsiveDiffStyle("unified", 390)).toBe("unified")
  })

  test("removes diffStyle from forwarded options before resolving container width", async () => {
    const source = await Bun.file(new URL("../components/file.tsx", import.meta.url)).text()

    expect(source).toContain('"before", "after", "diffStyle", "virtualize"')
    expect(source).toContain("responsiveDiffStyle(local.diffStyle, containerWidth())")
  })
})
