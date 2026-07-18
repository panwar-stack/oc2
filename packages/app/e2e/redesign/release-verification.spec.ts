import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test"
import { base64Encode } from "@oc2-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { trackPageErrors } from "../utils/errors"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

const modes = ["dark", "light"] as const
const releaseNow = new Date(1_700_000_800_000)
const breakpoints = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 900, height: 900 },
  { name: "desktop", width: 1280, height: 900 },
] as const
const question = {
  id: "question_release_verification",
  sessionID: fixture.targetID,
  questions: [
    {
      header: "Release strategy",
      question: "Which verification evidence should accompany this release?",
      options: [
        { label: "Automated gates", description: "Attach repeatable command output and screenshots." },
        { label: "Manual checks", description: "Record the environment and the observed result." },
        { label: "Both", description: "Use automated gates plus focused manual review." },
      ],
      multiple: true,
      custom: false,
    },
  ],
}

for (const mode of modes) {
  for (const viewport of breakpoints) {
    test(`${mode} ${viewport.name}: verifies M1-M5 release surfaces`, async ({ page }, testInfo) => {
      test.setTimeout(180_000)
      await page.setViewportSize(viewport)
      await page.clock.setFixedTime(releaseNow)
      await page.emulateMedia({ colorScheme: mode, reducedMotion: "reduce" })
      const questions: unknown[] = []
      const sessionStatus: Record<string, unknown> = {}
      const errors = trackPageErrors(page)
      await mockOpenCodeServer(page, {
        sessions: fixture.sessions,
        provider: fixture.provider,
        directory: fixture.directory,
        project: fixture.project,
        pageMessages,
        questions,
        sessionStatus,
      })
      await configure(page, mode)

      await page.goto("/")
      const identity = page.locator('[data-component="home-identity"]')
      const homePrompt = page.getByRole("textbox", { name: "Message" })
      const recent = page.getByRole("listbox", { name: "Recent sessions" })
      await expectAppVisible(identity)
      await expectAppVisible(homePrompt)
      await expectAppVisible(recent)
      await expectScheme(page, mode)
      await expect(homePrompt).toBeFocused()
      const active = await recent.getAttribute("aria-activedescendant")
      await recent.focus()
      await page.keyboard.press("ArrowDown")
      await expect(recent).not.toHaveAttribute("aria-activedescendant", active ?? "")
      await expectFocusIndicator(recent)
      await expectContrast(identity.locator("strong"), 4.5)
      await expectNoHorizontalOverflow(page)
      await attachScreenshot(page, testInfo, `m1-welcome-${mode}-${viewport.name}`)

      const sessionURL = `/${base64Encode(fixture.directory)}/session/${fixture.targetID}`
      await page.goto(sessionURL)
      await expectSessionTitle(page, fixture.expected.targetTitle)
      const reviewToggle = page.getByRole("button", { name: "Toggle review" })
      if ((await reviewToggle.isVisible()) && (await reviewToggle.getAttribute("aria-expanded")) === "true") {
        await reviewToggle.click()
        await expect(reviewToggle).toHaveAttribute("aria-expanded", "false")
      }
      const timeline = page.locator('[data-component="session-timeline"][data-layout="v2"]')
      const composer = page.locator('[data-component="session-composer"]')
      const composerInput = composer.locator('[data-component="prompt-input"]')
      await expectAppVisible(timeline)
      await expectAppVisible(composer)
      await expect(timeline.locator('[data-component="session-turn"]')).not.toHaveCount(0)
      await expect(composer).toHaveAttribute("data-state", "idle")
      await composerInput.focus()
      await page.keyboard.press("Tab")
      const attach = composer.locator('[data-action="prompt-attach"]')
      await expect(attach).toBeFocused()
      await expectFocusIndicator(attach)
      await expectContrast(composerInput, 4.5)
      await expectNoHorizontalOverflow(page)
      await attachScreenshot(page, testInfo, `m2-m5-session-${mode}-${viewport.name}`)

      const details = page.getByRole("button", { name: "details", exact: true })
      if (viewport.width < 1100) {
        await details.click()
        await expectAppVisible(page.getByRole("complementary", { name: "Session details" }))
      } else {
        await expectAppVisible(page.getByRole("complementary", { name: "Session details" }))
      }
      const detailsPanel = page.getByRole("complementary", { name: "Session details" })
      await expect(detailsPanel.getByRole("region", { name: "Session" })).toBeVisible()
      await expect(detailsPanel.getByRole("region", { name: "Context" })).toBeVisible()
      await expect(detailsPanel.getByRole("region", { name: "Team" })).toBeVisible()
      await expect(detailsPanel.getByRole("region", { name: "Todo" })).toBeVisible()
      await expectNoHorizontalOverflow(page)
      await attachScreenshot(page, testInfo, `m4-sidebar-${mode}-${viewport.name}`)
      if (viewport.width < 1100) {
        await page.getByRole("button", { name: "Close session details" }).click({ position: { x: 4, y: 4 } })
      }

      sessionStatus[fixture.targetID] = { type: "busy" }
      await page.reload()
      await expectSessionTitle(page, fixture.expected.targetTitle)
      const workingComposer = page.locator('[data-component="session-composer"]')
      await expect(workingComposer).toHaveAttribute("data-state", "working")
      await expect(page.locator('[data-component="session-working-bar"][data-variant="working"]')).toBeVisible()
      await expect(page.getByLabel("Interrupt active turn")).toBeVisible()
      await expectNoHorizontalOverflow(page)
      await attachScreenshot(page, testInfo, `m5-composer-working-${mode}-${viewport.name}`)

      questions.push(question)
      await page.reload()
      await expectSessionTitle(page, fixture.expected.targetTitle)
      const decision = page.locator('[data-slot="question-options"]')
      await expectAppVisible(decision)
      const options = decision.getByRole("checkbox")
      await expect(options).toHaveCount(3)
      await expect(options.first()).toBeFocused()
      await page.keyboard.press("ArrowDown")
      await expect(options.nth(1)).toBeFocused()
      await page.keyboard.press("Space")
      await expect(options.nth(1)).toHaveAttribute("aria-checked", "true")
      await expect(page.getByText("1 of 3 selected", { exact: true })).toBeVisible()
      await expect(page.locator('[data-component="session-working-bar"]')).toHaveAttribute("data-variant", "needs-you")
      await expect(page.locator('[data-component="session-status-bar"]')).toHaveAttribute(
        "aria-label",
        /waiting on you/,
      )
      await expectFocusIndicator(options.nth(1))
      await expectContrast(page.locator('[data-slot="question-text"]'), 4.5)
      await expectNoHorizontalOverflow(page)
      await attachScreenshot(page, testInfo, `m3-decision-${mode}-${viewport.name}`)

      expect(errors).toEqual([])
    })
  }

  test(`${mode}: tolerates 200% browser zoom in Chromium`, async ({ browser }, testInfo) => {
    test.setTimeout(120_000)
    const baseURL = testInfo.project.use.baseURL
    if (typeof baseURL !== "string") throw new Error("Playwright baseURL is required")
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 640, height: 450 },
      screen: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: mode,
      reducedMotion: "reduce",
    })
    const page = await context.newPage()
    await page.clock.setFixedTime(releaseNow)
    await mockOpenCodeServer(page, {
      sessions: fixture.sessions,
      provider: fixture.provider,
      directory: fixture.directory,
      project: fixture.project,
      pageMessages,
    })
    await configure(page, mode)
    await page.goto("/")
    await expectAppVisible(page.locator('[data-component="home-identity"]'))
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])).toEqual([640, 450, 2])
    await expectWithinViewport(page, page.getByRole("textbox", { name: "Message" }))
    await expectNoHorizontalOverflow(page)
    await attachScreenshot(page, testInfo, `m1-welcome-${mode}-zoom-200`)
    await expectZoomMetrics(page)

    await page.goto(`/${base64Encode(fixture.directory)}/session/${fixture.targetID}`)
    await expectSessionTitle(page, fixture.expected.targetTitle)
    const reviewToggle = page.getByRole("button", { name: "Toggle review" })
    if ((await reviewToggle.isVisible()) && (await reviewToggle.getAttribute("aria-expanded")) === "true") {
      await reviewToggle.click()
    }
    await expectWithinViewport(page, page.locator('[data-component="session-composer"]'))
    await expectNoHorizontalOverflow(page)
    await attachScreenshot(page, testInfo, `m2-m5-session-${mode}-zoom-200`)
    await expectZoomMetrics(page)
    await context.close()
  })
}

async function configure(page: Page, mode: (typeof modes)[number]) {
  await page.addInitScript(
    ({ directory, mode }) => {
      localStorage.setItem("opencode-theme-id", "oc-2")
      localStorage.setItem("opencode-color-scheme", mode)
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          general: {
            newLayoutDesigns: true,
            showReasoningSummaries: true,
            showSessionProgressBar: true,
          },
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          const style = document.createElement("style")
          style.textContent = 'aside[aria-label="Development performance diagnostics"] { display: none !important; }'
          document.head.append(style)
        },
        { once: true },
      )
    },
    { directory: fixture.directory, mode },
  )
}

async function expectScheme(page: Page, mode: (typeof modes)[number]) {
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oc-2")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", mode)
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toContain(mode)
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1))
    .toBe(true)
}

async function expectWithinViewport(page: Page, locator: Locator) {
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1
      }),
    )
    .toBe(true)
}

async function expectZoomMetrics(page: Page) {
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])).toEqual([640, 450, 2])
}

async function expectFocusIndicator(locator: Locator) {
  const indicator = await locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return { boxShadow: style.boxShadow, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }
  })
  expect(
    indicator.boxShadow !== "none" || (indicator.outlineStyle !== "none" && indicator.outlineWidth !== "0px"),
  ).toBe(true)
}

async function expectContrast(locator: Locator, minimum: number) {
  const ratio = await locator.evaluate((element) => {
    const parse = (value: string) =>
      value
        .match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number) ?? []
    const luminance = (value: string) => {
      const channels = parse(value).map((channel) => {
        const normalized = channel / 255
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
    }
    const foreground = getComputedStyle(element).color
    let current: Element | null = element
    let background = ""
    while (current) {
      const value = getComputedStyle(current).backgroundColor
      if (value !== "rgba(0, 0, 0, 0)" && value !== "transparent") {
        background = value
        break
      }
      current = current.parentElement
    }
    const light = Math.max(luminance(foreground), luminance(background))
    const dark = Math.min(luminance(foreground), luminance(background))
    return (light + 0.05) / (dark + 0.05)
  })
  expect(ratio).toBeGreaterThanOrEqual(minimum)
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready)
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: "disabled", caret: "hide", scale: "css" })
  await testInfo.attach(name, { path, contentType: "image/png" })
}
