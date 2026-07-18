import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@oc2-ai/core/util/encode"
import { fixture, pageMessages } from "./session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

async function openHome(page: Page, sessions = fixture.sessions, failSessions = false) {
  await mockOpenCodeServer(page, {
    sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
  await page.addInitScript((directory) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, fixture.directory)
  if (failSessions) {
    await page.route("**/session?**", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "offline" }) }),
    )
  }

  await page.goto("/")
}

test("renders the redesigned home and resumes the selected recent session", async ({ page }) => {
  await openHome(page)

  await expectAppVisible(page.locator('[data-component="home-identity"]'))
  const prompt = page.getByRole("textbox", { name: "Message" })
  await expectAppVisible(prompt)
  const recent = page.getByRole("listbox", { name: "Recent sessions" })
  await expectAppVisible(recent)
  await expect(recent.getByRole("option")).toHaveCount(2)
  await expect(recent.getByRole("option").first()).toHaveAttribute("aria-selected", "true")
  await expect(recent).toContainText("127.5K tok")
  await expect(prompt).toBeFocused()

  await page.keyboard.press("Control+o")
  await expect(page.getByText("ALL SESSIONS", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Recent sessions" }).click()

  await prompt.focus()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(new RegExp(`/${base64Encode(fixture.directory)}/session/${fixture.targetID}$`))
})

test("keeps the resume surface usable at narrow and 200%-equivalent widths", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 })
  await openHome(page)

  for (const width of [640, 390]) {
    await page.setViewportSize({ width, height: 720 })
    await expectAppVisible(page.getByRole("textbox", { name: "Message" }))
    await expectAppVisible(page.getByRole("listbox", { name: "Recent sessions" }))
    const geometry = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
  }

  const prompt = page.getByRole("textbox", { name: "Message" })
  await prompt.fill("2 failing home tests")
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/session$/)
  await expect(page.getByRole("textbox", { name: "Message" })).toContainText("2 failing home tests")
  expect(await page.evaluate(() => JSON.stringify(history.state))).not.toContain("2 failing home tests")
})

test("loads beyond the recent cache when all sessions opens", async ({ page }) => {
  const sessions = Array.from({ length: 70 }, (_, index) => ({
    ...fixture.sessions[0],
    id: `ses_home_${index}`,
    slug: `home-${index}`,
    title: `Home session ${index}`,
    time: { created: 1700000000000 + index, updated: 1700000000000 + index },
  }))
  await openHome(page, sessions)
  await expectAppVisible(page.locator('[data-component="home-identity"]'))

  await page.keyboard.press("Control+o")
  await expect(page.locator('[data-component="home-session-row"]')).toHaveCount(70)
})

test("delivers a prompt when a deep link targets the open new-session route", async ({ page }) => {
  await openHome(page)
  const href = `/${base64Encode(fixture.directory)}/session`
  await page.goto(href)
  await expectAppVisible(page.getByRole("textbox", { name: "Message" }))

  await page.evaluate((directory) => {
    const url = `opencode://new-session?directory=${encodeURIComponent(directory)}&prompt=same-route%20prompt`
    window.dispatchEvent(new CustomEvent("opencode:deep-link", { detail: { urls: [url] } }))
  }, fixture.directory)

  await expect(page).toHaveURL(new RegExp(`${href}$`))
  await expect(page.getByRole("textbox", { name: "Message" })).toContainText("same-route prompt")
})

test("renders the canonical session error and retry action", async ({ page }) => {
  await openHome(page, fixture.sessions, true)

  await expect(page.getByRole("alert").getByText("Couldn't load sessions")).toBeVisible()
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible()
})
