import { expect, test, type Locator, type Page } from "@playwright/test"
import { base64Encode } from "@oc2-ai/core/util/encode"
import { fixture, pageMessages } from "./session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

test("keeps retained shell navigation usable without horizontal overflow", async ({ page }) => {
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await page.addInitScript((directory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: false } }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, fixture.directory)

  const slug = base64Encode(fixture.directory)
  await page.goto(`/${slug}/session/${fixture.sourceID}`)
  await expectSessionTitle(page, fixture.expected.sourceTitle)

  const prompt = page.getByRole("textbox", { name: /Ask anything/i })
  await expectAppVisible(prompt)
  await expectWithinViewport(page, prompt)

  const mobile = (page.viewportSize()?.width ?? 0) < 1280
  const nav = page.locator(
    mobile ? 'nav[data-component="sidebar-nav-mobile"]' : 'nav[data-component="sidebar-nav-desktop"]',
  )
  if (mobile) {
    const menu = page.getByRole("button", { name: "Toggle menu" })
    await expectAppVisible(menu)
    await expectWithinViewport(page, menu)
    await menu.click()
  } else {
    const sidebar = page.getByRole("button", { name: "Toggle sidebar" })
    await expectAppVisible(sidebar)
    await expectWithinViewport(page, sidebar)
    if ((await sidebar.getAttribute("aria-expanded")) !== "true") await sidebar.click()
  }

  await expect(nav).toBeInViewport()
  await expectWithinViewport(page, nav)
  const targetSession = nav.locator(`[data-session-id="${fixture.targetID}"] a`)
  await expectAppVisible(targetSession)
  await expectWithinViewport(page, targetSession)
  await expectNoHorizontalOverflow(page)

  await targetSession.click()
  await expect(page).toHaveURL(new RegExp(`/${slug}/session/${fixture.targetID}$`))
  await expectSessionTitle(page, fixture.expected.targetTitle)
  await expectAppVisible(prompt)
  await expectWithinViewport(page, prompt)
  await expectNoHorizontalOverflow(page)

  if (mobile) {
    const menu = page.getByRole("button", { name: "Toggle menu" })
    if ((await menu.getAttribute("aria-expanded")) === "true") await menu.click()
    await expect(menu).toHaveAttribute("aria-expanded", "false")
  }

  const usage = page.getByRole("button", { name: "View context usage" })
  await expectAppVisible(usage)
  await page.locator('[data-component="tooltip-trigger"]', { has: usage }).hover()
  const tooltip = page.locator('[data-component="tooltip"]')
  await expect(tooltip.getByText(fixture.expected.targetContextTokens, { exact: true })).toBeVisible()
  await expect(tooltip.getByText(fixture.expected.targetCost, { exact: true })).toBeVisible()
})

async function expectWithinViewport(page: Page, locator: Locator) {
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox()
        const viewport = page.viewportSize()
        if (!box || !viewport) return false
        return (
          box.x >= -1 &&
          box.y >= -1 &&
          box.x + box.width <= viewport.width + 1 &&
          box.y + box.height <= viewport.height + 1
        )
      },
      { message: "control should be fully inside the viewport" },
    )
    .toBe(true)
}

async function expectNoHorizontalOverflow(page: Page) {
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
}
