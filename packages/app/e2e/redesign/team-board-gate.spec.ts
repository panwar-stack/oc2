import { expect, test, type Page, type TestInfo } from "@playwright/test"
import { base64Encode } from "@oc2-ai/core/util/encode"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer, type MockServerConfig } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const sessionURL = `/${base64Encode(fixture.directory)}/session/${fixture.targetID}`
const team = {
  id: "team_release_verification",
  name: "Release verification",
  goal: "Verify the authoritative Board projection",
  lead_session_id: fixture.targetID,
  status: "active",
  time_created: 1,
  time_updated: 1,
}
const emptyBoard = {
  team: {
    id: team.id,
    name: team.name,
    goal: team.goal,
    lead_session_id: fixture.targetID,
    status: "active",
  },
  viewer: { session_id: fixture.targetID, role: "lead" },
  revision: 1,
  generated_at: 1,
  counts: {
    workers: 0,
    working: 0,
    blocked: 0,
    idle: 0,
    done: 0,
    errored: 0,
    cancelled: 0,
    needs_you: 0,
    unread: 0,
    claimed: 0,
    total_tasks: 0,
  },
  workers: [],
  tasks: [],
  dependencies: [],
  attention_items: [],
}

test("M6 board is reachable in redesign sessions", async ({ page }, testInfo) => {
  await openBoardHarness(page)
  await expect(page.getByRole("tablist", { name: "Session view" }).getByRole("tab")).toHaveCount(3)
  await attach(page, testInfo, "m6-board-reachable")
})

test("M6 compact navigation composes session, board, tasks, and changes", async ({ page }) => {
  await openBoardHarness(page, {}, 390)
  const tabs = page.getByRole("tablist", { name: "Session view" })
  await expect(tabs.getByRole("tab")).toHaveCount(4)
  await tabs.getByRole("tab", { name: "changes" }).click()
  await expect(tabs.getByRole("tab", { name: "changes" })).toHaveAttribute("aria-selected", "true")
})

test("M6 renders authoritative workers with keyboard and completed collapse", async ({ page }) => {
  await openBoardHarness(page, {
    team: { body: team },
    teamHistory: { body: [team] },
    teamBoard: {
      body: {
        ...emptyBoard,
        revision: 7,
        counts: { ...emptyBoard.counts, workers: 2, working: 1, done: 1, claimed: 2, total_tasks: 2 },
        workers: [
          {
            member_id: "member_working",
            session_id: "session_working",
            name: "web",
            agent_type: "general",
            role: "Web implementation",
            state: "working",
            lifecycle: "task",
            work_mode: "implement",
            mutability: "write_allowed",
            display_summary: "Wire the Board",
            current_work: { source: "task", id: "task_working", started_at: 1 },
            elapsed_ms: 30_000,
            mailbox: { unread: 1 },
            attention: { plan: null, permissions: 0, questions: 0 },
            dependency_ids: [],
            outcome: null,
            result_persisted: false,
            time_created: 1,
            time_updated: 2,
          },
          {
            member_id: "member_done",
            session_id: "session_done",
            name: "audit",
            agent_type: "general",
            role: null,
            state: "completed",
            lifecycle: "task",
            work_mode: "implement",
            mutability: "read_only",
            display_summary: "Audit complete",
            current_work: null,
            elapsed_ms: null,
            mailbox: { unread: 0 },
            attention: { plan: null, permissions: 0, questions: 0 },
            dependency_ids: [],
            outcome: { type: "succeeded", label: "completed" },
            result_persisted: true,
            time_created: 1,
            time_updated: 2,
          },
        ],
        tasks: [
          {
            id: "task_working",
            description: "Wire the Board",
            status: "in_progress",
            assignee: "member_working",
            dependency_ids: [],
            started_at: 1,
            completed_at: null,
          },
          {
            id: "task_done",
            description: "Audit",
            status: "completed",
            assignee: "member_done",
            dependency_ids: [],
            started_at: 1,
            completed_at: 2,
          },
        ],
      },
    },
  })
  await page.getByRole("tab", { name: "board" }).click()
  await expect(page.locator("[data-board-card]")).toHaveCount(1)
  await page.getByRole("button", { name: /Completed · 1/ }).click()
  await expect(page.locator("[data-board-card]")).toHaveCount(2)
  const working = page.getByRole("button", { name: /web, Working/ })
  await working.focus()
  await working.press("Enter")
  await expect(page.getByRole("complementary", { name: "web details" })).toBeVisible()
})

test.describe("M6 board degraded contracts", () => {
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
        team: { body: team },
        teamHistory: { body: [team] },
        teamBoard: { body: emptyBoard },
      },
      title: "No team activity yet",
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

async function openBoardHarness(
  page: Page,
  responses: Pick<MockServerConfig, "team" | "teamHistory" | "teamBoard" | "teamTasks"> = {},
  width = 1280,
) {
  await page.setViewportSize({ width, height: 900 })
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
