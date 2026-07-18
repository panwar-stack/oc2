import { expect, test } from "bun:test"
import { checkTokenParity } from "./check-token-parity"

const root = `${import.meta.dir}/..`
const input = {
  master: await Bun.file(`${root}/design-system/tokens.json`).text(),
  web: await Bun.file(`${root}/packages/ui/src/v2/styles/theme.css`).text(),
  tui: await Bun.file(`${root}/packages/tui/src/theme/assets/oc2.json`).text(),
}

test("web and TUI house themes match the canonical token master", () => {
  expect(checkTokenParity(input)).toBe(10)
})

test("token parity rejects a web mismatch", () => {
  expect(() =>
    checkTokenParity({
      ...input,
      web: input.web.replace("--v2-background-bg-base: #ffffff;", "--v2-background-bg-base: #000000;"),
    }),
  ).toThrow("web light: surface.app is #000000, expected #FFFFFF")
})

test("token parity rejects a later web override", () => {
  expect(() =>
    checkTokenParity({
      ...input,
      web: `${input.web}\n@layer theme { [data-color-scheme="dark"] { --v2-background-bg-base: #ffffff; } }\n`,
    }),
  ).toThrow("--v2-background-bg-base must have one definition per mode, found 3")
})
