import { Flag } from "@oc2-ai/core/flag/flag"
import { createBuiltinPlugins, type BuiltinTuiPlugin } from "@oc2-ai/tui/builtins"
import type { RuntimeFlags } from "@/effect/runtime-flags"

export type InternalTuiPlugin = BuiltinTuiPlugin

export function internalTuiPlugins(flags: Pick<RuntimeFlags.Info, "experimentalEventSystem">): InternalTuiPlugin[] {
  return createBuiltinPlugins({
    experimentalEventSystem: flags.experimentalEventSystem,
    experimentalSessionSwitcher: Flag.OC2_EXPERIMENTAL_SESSION_SWITCHER,
  })
}
