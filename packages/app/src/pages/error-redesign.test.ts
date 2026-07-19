import { describe, expect, test } from "bun:test"

describe("global error redesign contract", () => {
  test("uses the shared error grammar without dropping recovery actions", async () => {
    const source = await Bun.file(import.meta.dir + "/error.tsx").text()

    expect(source).toContain("<StateBlockV2")
    expect(source).toContain('variant="error"')
    expect(source).toContain('scale="full"')
    expect(source).toContain('data-slot="error-page-state"')
    expect(source).toContain('w-[min(92vw,48rem)]')
    expect(source).toContain("formattedError()")
    expect(source).toContain("readOnly\n          copyable")
    expect(source).toContain("platform.restart")
    expect(source).toContain("Sentry.captureException(props.error)")
    expect(source).toContain("github.com/panwar-stack/oc2/issues/new")
    expect(source).toContain("platform.version")
  })
})
