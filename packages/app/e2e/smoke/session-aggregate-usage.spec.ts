import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@oc2-ai/core/util/encode"
import { fixture, pageMessages } from "./session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

test("keeps persisted aggregate usage invariant across 144-message pagination", async ({ page }) => {
  const messageRequests: string[] = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/session/${fixture.targetID}/message`) messageRequests.push(url.search)
  })
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await configure(page)

  await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.targetID}`)
  await expectSessionTitle(page, fixture.expected.targetTitle)
  await expectAppVisible(page.getByRole("textbox", { name: /Ask anything/i }))
  await expectAggregateUsage(page)

  await page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") }).evaluate((scroller) => {
    scroller.scrollTop = 0
    scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1 }))
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
  await expect.poll(() => messageRequests.filter((query) => query.includes("before=")).length).toBeGreaterThan(0)

  await expectAggregateUsage(page)
})

async function expectAggregateUsage(page: Page) {
  const usage = page.getByRole("button", { name: "View context usage" })
  await expectAppVisible(usage)
  await usage.click()
  const totalTokens = page.getByText("Total Tokens", { exact: true }).locator("..")
  const totalCost = page.getByText("Total Cost", { exact: true }).locator("..")
  await expect(totalTokens.getByText(fixture.expected.targetAggregateTokens, { exact: true })).toBeVisible()
  await expect(totalCost.getByText(fixture.expected.targetCost, { exact: true })).toBeVisible()
  await usage.click()
  await expect(totalTokens).toHaveCount(0)
}

async function configure(page: Page) {
  await page.addInitScript((directory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { showSessionProgressBar: true } }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, fixture.directory)
}
