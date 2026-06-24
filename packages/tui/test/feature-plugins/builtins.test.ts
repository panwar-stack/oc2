import { expect, test } from "bun:test"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"

test("registers logu sidebar as an always-available builtin", () => {
  const ids = createBuiltinPlugins({ experimentalEventSystem: false, experimentalSessionSwitcher: false }).map((plugin) => plugin.id)

  expect(ids).toContain("internal:sidebar-logu")
})
