#!/usr/bin/env bun
import { $ } from "bun"

const generatedPaths = [
  "packages/sdk/openapi.json",
  "packages/sdk/js/src/gen",
  "packages/sdk/js/src/v2/gen",
  "packages/ui/src/styles/tailwind/colors.css",
  "packages/ui/src/theme/themes/oc-2.json",
]

console.log("Regenerating SDK/OpenAPI and UI generated artifacts...")
await $`./packages/sdk/js/script/build.ts`
await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/opencode")
await formatJson("packages/sdk/openapi.json")
await $`bun run --cwd packages/ui generate:tailwind`
await $`bun run --cwd packages/ui generate:v2-oc2`
await $`bun prettier --write packages/ui/src/styles/tailwind/colors.css packages/ui/src/theme/themes/oc-2.json`

const status = (await $`git status --porcelain -- ${generatedPaths}`.quiet()).text().trim()
if (status === "") {
  console.log("Generated artifacts are up to date.")
  process.exit(0)
}

console.error("Generated artifacts are out of date. Run `bun run check:generated` and commit the generated changes.")
console.error(status)

const diffStat = (await $`git diff --stat -- ${generatedPaths}`.quiet()).text().trim()
if (diffStat !== "") console.error(diffStat)

const diff = (await $`git diff -- ${generatedPaths}`.quiet()).text().trim()
if (diff !== "") console.error(diff)

process.exit(1)

async function formatJson(path: string) {
  await Bun.write(path, JSON.stringify(await Bun.file(path).json(), null, 2) + "\n")
}
