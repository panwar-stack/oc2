import { expect, test } from "bun:test"

import { VERSION } from "../src/index"
import { smokeFixture } from "../src/testing/fixtures"

test("exports the package version", () => {
  expect(VERSION).toBe("0.0.0")
  expect(smokeFixture.version).toBe(VERSION)
})
