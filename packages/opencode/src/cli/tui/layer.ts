import { run as runTui, type TuiInput } from "@oc2-ai/tui"
import { Global } from "@oc2-ai/core/global"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(Global.defaultLayer))
}
