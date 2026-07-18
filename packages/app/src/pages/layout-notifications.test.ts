import { expect, test } from "bun:test"

test("keeps redesigned decisions in-page and restores actionable legacy alerts", async () => {
  const source = await Bun.file(new URL("./layout.tsx", import.meta.url)).text()
  const start = source.indexOf("const useSDKNotifications")
  const end = source.indexOf("useSDKNotifications()", start)
  const notifications = source.slice(start, end)

  expect(notifications).toContain('e.details?.type !== "permission.asked"')
  expect(notifications).toContain("platform.notify")
  expect(notifications).toContain("if (settings.general.newLayoutDesigns()) return")
  expect(notifications).toContain("const toastID = showToast({")
  expect(notifications).toContain('language.t("notification.action.goToSession")')
  expect(notifications).toContain("persistent: true")
})
