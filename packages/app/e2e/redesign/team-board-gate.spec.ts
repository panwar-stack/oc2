import { expect, test, type Page, type TestInfo } from "@playwright/test"
import { base64Encode } from "@oc2-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer, type MockServerConfig } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const enabled = process.env.VITE_OC2_TEAM_BOARD === "true"
const sessionURL = `/${base64Encode(fixture.directory)}/session/${fixture.targetID}`

test("M6 board remains absent when its environment gate is off", async ({ page }, testInfo) => {
  test.skip(enabled, "Run the gate-off contract without VITE_OC2_TEAM_BOARD=true")
  await openBoardHarness(page)
  await expect(page.getByRole("tablist", { name: "Session view" })).toHaveCount(0)
  await attach(page, testInfo, "m6-board-gate-off")
})

test.describe("M6 board gate-on degraded contracts", () => {
  test.skip(!enabled, "Run with VITE_OC2_TEAM_BOARD=true")

  for (const contract of [
    {
      name: "degraded",
      config: { team: { status: 400, body: { message: "No team for session" } } },
      title: "No team for this session",
      variant: "empty",
    },
    {
      name: "empty",
      config: {
        team: {
          body: {
            id: "team_release_verification",
            name: "Release verification",
            goal: "Verify the release without invented member data",
            lead_session_id: fixture.targetID,
            status: "active",
            time_created: 1,
            time_updated: 1,
          },
        },
        teamTasks: { body: [] },
      },
      title: "No team tasks yet",
      variant: "empty",
    },
    {
      name: "error",
      config: { team: { status: 500, body: { message: "Team service unavailable" } } },
      title: "Team board unavailable",
      variant: "error",
    },
  ] as const) {
    test(`renders the ${contract.name} state without worker-card acceptance claims`, async ({ page }, testInfo) => {
      await openBoardHarness(page, contract.config)
      if (contract.name === "error") {
        await expect(page.getByRole("complementary", { name: "Session details" })).toContainText("team unavailable")
      }
      const tabs = page.getByRole("tablist", { name: "Session view" })
      await expect(tabs.getByRole("tab")).toHaveCount(3)
      await tabs.getByRole("tab", { name: "board" }).click()
      const state = page.locator(`[data-component="state-block-v2"][data-variant="${contract.variant}"]`)
      await expect(state.getByText(contract.title, { exact: true })).toBeVisible()
      await expect(page.locator('[data-component="team-board-grid"]')).toHaveCount(0)
      await attach(page, testInfo, `m6-board-${contract.name}`)
    })
  }
})

async function openBoardHarness(page: Page, responses: Pick<MockServerConfig, "team" | "teamTasks"> = {}) {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.clock.setFixedTime(new Date(1_700_000_800_000))
  await mockOpenCodeServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
    ...responses,
  })
  await page.addInitScript((directory) => {
    localStorage.setItem("opencode-theme-id", "oc-2")
    localStorage.setItem("opencode-color-scheme", "dark")
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
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
  }, fixture.directory)
  await page.goto(sessionURL)
  await expectSessionTitle(page, fixture.expected.targetTitle)
  const reviewToggle = page.getByRole("button", { name: "Toggle review" })
  if ((await reviewToggle.isVisible()) && (await reviewToggle.getAttribute("aria-expanded")) === "true") {
    await reviewToggle.click()
  }
}

async function attach(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready)
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path, animations: "disabled", caret: "hide", scale: "css" })
  await testInfo.attach(name, { path, contentType: "image/png" })
}
