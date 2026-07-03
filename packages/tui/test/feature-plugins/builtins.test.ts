import { expect, test } from "bun:test"
import { createBuiltinPlugins } from "../../src/feature-plugins/builtins"

test("registers builtin sidebar plugins without removed logu sidebar", () => {
  const ids = createBuiltinPlugins({ experimentalEventSystem: false, experimentalSessionSwitcher: false }).map(
    (plugin) => plugin.id,
  )

  expect(ids).toContain("internal:sidebar-context")
  expect(ids).toContain("internal:sidebar-files")
  expect(ids).not.toContain("internal:sidebar-logu")
})
