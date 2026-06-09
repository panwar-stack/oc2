import { expect, test } from "bun:test"
import { createBuiltinPlugins } from "../../../../tui/src/feature-plugins/builtins"

test("team sidebar plugin is registered as internal", () => {
  const teamPlugin = createBuiltinPlugins({ experimentalEventSystem: false, experimentalSessionSwitcher: false }).find(
    (plugin) => plugin.id === "internal:sidebar-team",
  )
  expect(teamPlugin).toBeDefined()
  expect(teamPlugin?.id).toBe("internal:sidebar-team")
  expect(teamPlugin?.tui).toBeTypeOf("function")
})
