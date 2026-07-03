#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/opencode")

await $`bun run --cwd packages/ui generate:tailwind`

await $`bun run --cwd packages/ui generate:v2-oc2`

await $`bun prettier --write packages/ui/src/styles/tailwind/colors.css packages/ui/src/theme/themes/oc-2.json`

await $`./script/format.ts`

await formatJson("packages/sdk/openapi.json")

async function formatJson(path: string) {
  await Bun.write(path, JSON.stringify(await Bun.file(path).json(), null, 2) + "\n")
}
