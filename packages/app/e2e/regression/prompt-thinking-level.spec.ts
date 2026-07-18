import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@oc2-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/PromptThinkingLevelRegression"
const projectID = "proj_prompt_thinking_level_regression"
const sessionID = "ses_prompt_thinking_level_regression"

test("shows the V2 thinking level control while relevant", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-thinking-level-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "thinking-model": {
              id: "thinking-model",
              name: "Thinking Model",
              limit: { context: 200_000 },
              variants: { high: {} },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "thinking-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-thinking-level-regression",
        projectID,
        directory,
        title: "Prompt thinking level regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-composer"]')
  const input = composer.locator('[data-component="prompt-input"]')
  const placeholder = composer.locator('[data-component="session-composer-text"]')
  const placeholderText = placeholder.locator('[data-slot="session-composer-placeholder"]')
  const control = composer.locator('[data-component="prompt-variant-control"]')
  await expectAppVisible(composer)

  const inputBox = await input.boundingBox()
  const placeholderBox = await placeholderText.boundingBox()
  expect(inputBox).not.toBeNull()
  expect(placeholderBox).not.toBeNull()
  expect(placeholderBox!.x).toBeGreaterThan(inputBox!.x + 16)

  await idleComposer(page)
  await expect(control).toBeHidden()

  await composer.hover()
  await expect(control).toBeVisible()

  await control.locator('[data-action="prompt-model-variant"]').click()
  const high = page.getByRole("option", { name: "high" })
  await expect(high).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(control).toBeVisible()
  await expect(high).toBeVisible()
  await high.click()

  await idleComposer(page)
  await input.focus()
  await expect(control).toBeVisible()

  await idleComposer(page)
  await expect(control).toBeVisible()

  await input.focus()
  await page.keyboard.type("caret stays clear")
  await expect(placeholder).toBeHidden()
  await page.keyboard.press("ControlOrMeta+A")
  await page.keyboard.press("Backspace")
  await expect(placeholder).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(composer.locator('[data-action="prompt-attach"]')).toBeFocused()
})

async function idleComposer(page: Page) {
  await page.mouse.move(0, 0)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}
