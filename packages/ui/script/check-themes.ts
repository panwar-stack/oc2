#!/usr/bin/env bun

import Ajv from "ajv"
import type { DesktopTheme } from "../src/theme/types"
import { DEFAULT_THEMES } from "../src/theme/default-themes"
import { resolveTheme } from "../src/theme/resolve"
import { resolveThemeV2 } from "../src/theme/v2/resolve"

const directory = `${import.meta.dir}/../src/theme/themes`
const paths = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: directory }))).toSorted()
const schema = await Bun.file(`${import.meta.dir}/../src/theme/theme.schema.json`).json()
const ajv = new Ajv({ allErrors: true, strict: false })
const validate = ajv.compile(schema)
const errors: string[] = []
const ids = new Set<string>()

if (paths.length !== 36) errors.push(`expected 36 bundled themes, found ${paths.length}`)

for (const path of paths) {
  const input: unknown = await Bun.file(`${directory}/${path}`).json()
  if (!validate(input)) {
    errors.push(`${path}: ${ajv.errorsText(validate.errors, { separator: "; " })}`)
    continue
  }

  const theme = input as DesktopTheme
  if (path !== `${theme.id}.json`) errors.push(`${path}: filename must match theme id ${theme.id}`)
  if (ids.has(theme.id)) errors.push(`${path}: duplicate theme id ${theme.id}`)
  ids.add(theme.id)

  const legacy = resolveTheme(theme)
  const v2 = resolveThemeV2(theme)
  for (const [mode, tokens] of Object.entries({
    "legacy light": legacy.light,
    "legacy dark": legacy.dark,
    "v2 light": v2.light,
    "v2 dark": v2.dark,
  })) {
    if (Object.keys(tokens).length === 0 || Object.values(tokens).some((value) => !value))
      errors.push(`${path}: ${mode} did not resolve completely`)
  }
}

const registered = Object.keys(DEFAULT_THEMES).toSorted()
const discovered = paths.map((path) => path.slice(0, -5)).toSorted()
if (JSON.stringify(registered) !== JSON.stringify(discovered))
  errors.push("default theme registry does not match bundled files")

if (errors.length) {
  console.error(errors.join("\n"))
  process.exit(1)
}

console.log(`Validated ${paths.length} bundled themes against schema and both resolvers`)
