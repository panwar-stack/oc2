import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { extractLegacyTuiConfig } from "../../src/config/tui-migrate"
import { tmpdir } from "../fixture/fixture"

afterEach(() => {
  delete process.env.OC2_CONFIG
  delete process.env.OC2_DISABLE_PROJECT_CONFIG
  delete process.env.LEGACY_TUI_SCROLL_SPEED_TEST
})

test("extracts valid legacy fields independently without modifying sources", async () => {
  await using root = await tmpdir()
  const nested = path.join(root.path, "apps", "client")
  const json = path.join(root.path, "oc2.json")
  const jsonc = path.join(nested, "oc2.jsonc")
  const tuiJson = path.join(root.path, "tui.json")
  const tuiJsonc = path.join(nested, "tui.jsonc")
  const backup = json + ".tui-migration.bak"
  await fs.mkdir(nested, { recursive: true })
  await Bun.write(
    json,
    JSON.stringify({
      theme: "root-theme",
      keybinds: "invalid",
      tui: { scroll_speed: 2, diff_style: "invalid", unknown: true },
    }),
  )
  await Bun.write(
    jsonc,
    `{
  // legacy TUI values remain in their original source
  "keybinds": { "app_exit": "ctrl+q" },
  "tui": { "scroll_acceleration": { "enabled": false }, "diff_style": "stacked" }
}`,
  )
  await Bun.write(tuiJson, '{"theme":"explicit-json"}\n')
  await Bun.write(tuiJsonc, '{\n  // protected explicit config\n  "theme": "explicit-jsonc"\n}\n')
  await Bun.write(backup, '{"theme":"existing-backup"}\n')
  const timestamp = new Date("2020-01-02T03:04:05.000Z")
  const protectedSources = [json, jsonc, tuiJson, tuiJsonc, backup]
  await Promise.all(protectedSources.map((source) => fs.utimes(source, timestamp, timestamp)))
  const before = await Promise.all(
    protectedSources.map(async (source) => ({
      source,
      bytes: await Bun.file(source).bytes(),
      mtime: (await fs.stat(source)).mtimeMs,
    })),
  )

  const contributions = (await extractLegacyTuiConfig({ cwd: nested, directories: [] })).filter((item) =>
    item.source.startsWith(root.path),
  )

  expect(contributions).toEqual([
    {
      source: json,
      directory: root.path,
      info: { theme: "root-theme", scroll_speed: 2 },
    },
    {
      source: jsonc,
      directory: nested,
      info: {
        keybinds: { app_exit: "ctrl+q" },
        scroll_acceleration: { enabled: false },
        diff_style: "stacked",
      },
    },
  ])
  for (const item of before) {
    expect(await Bun.file(item.source).bytes()).toEqual(item.bytes)
    expect((await fs.stat(item.source)).mtimeMs).toBe(item.mtime)
  }
  expect(await Bun.file(jsonc + ".tui-migration.bak").exists()).toBe(false)
})

test("substitutes typed legacy values before decoding fields", async () => {
  await using root = await tmpdir()
  const source = path.join(root.path, "oc2.jsonc")
  await Bun.write(path.join(root.path, "diff-style.txt"), "stacked")
  await Bun.write(
    source,
    `{
  "theme": "legacy-theme",
  "tui": {
    "scroll_speed": {env:LEGACY_TUI_SCROLL_SPEED_TEST},
    "diff_style": "{file:diff-style.txt}"
  }
}`,
  )
  process.env.LEGACY_TUI_SCROLL_SPEED_TEST = "2.5"

  const contribution = (await extractLegacyTuiConfig({ cwd: root.path, directories: [] })).find(
    (item) => item.source === source,
  )

  expect(contribution).toEqual({
    source,
    directory: root.path,
    info: { theme: "legacy-theme", scroll_speed: 2.5, diff_style: "stacked" },
  })
})

test("project disable keeps only the explicit OC2_CONFIG legacy contribution", async () => {
  await using root = await tmpdir()
  const project = path.join(root.path, "project")
  const custom = path.join(root.path, "custom.jsonc")
  await fs.mkdir(project, { recursive: true })
  await Bun.write(path.join(project, "oc2.json"), JSON.stringify({ theme: "project" }))
  await Bun.write(custom, `{ "theme": "custom", "tui": { "scroll_speed": 3 } }`)
  process.env.OC2_DISABLE_PROJECT_CONFIG = "true"
  process.env.OC2_CONFIG = custom

  const contributions = await extractLegacyTuiConfig({ cwd: project, directories: [] })

  expect(contributions.find((item) => item.source === custom)).toEqual({
    source: custom,
    directory: root.path,
    info: { theme: "custom", scroll_speed: 3 },
  })
  expect(contributions.some((item) => item.source === path.join(project, "oc2.json"))).toBe(false)
})
