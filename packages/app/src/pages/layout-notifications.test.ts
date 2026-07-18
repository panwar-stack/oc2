import { expect, test } from "bun:test"

test("keeps agent state out of in-app toasts", async () => {
  const source = await Bun.file(new URL("./layout.tsx", import.meta.url)).text()
  const start = source.indexOf("const useSDKNotifications")
  const end = source.indexOf("useSDKNotifications()", start)
  const notifications = source.slice(start, end)

  expect(notifications).toContain('e.details?.type !== "permission.asked"')
  expect(notifications).toContain("platform.notify")
  expect(notifications).not.toContain("showToast(")
})
